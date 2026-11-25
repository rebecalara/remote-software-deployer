import {
  ConflictException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MachineStatus } from '@prisma/client';
import { PowerShellExecutor } from '../deployments/powershell-executor';
import { PrismaService } from '../prisma/prisma.service';
import { ProbeResult, mapWithLimit, probePort } from './port-probe';

// Verificação periódica de quais máquinas respondem no WinRM (DECISIONS.md): conexão TCP na
// porta 5985 de cada máquina presente no AD, com tempo limite curto e paralelismo limitado.
// Só teste de porta — nenhuma autenticação, nenhum comando. "Respondendo no WinRM" diz só
// que a porta aceitou conexão, não que a máquina está pronta para implantar.
//
// Mesmo molde do MachineSyncScheduler: setTimeout encadeado, agendado ao FIM de cada rodada
// (automática, manual ou da subida); "Verificar agora" reinicia a contagem; nunca duas
// rodadas ao mesmo tempo. Fila por processo (mesma limitação das outras travas em memória).

export const WINRM_PORT = 5985;
export const PROBE_TIMEOUT_MS = 2000;
export const PROBE_PARALLEL = 20;
export const DEFAULT_REACHABILITY_INTERVAL_MINUTES = 15;
export const MIN_REACHABILITY_INTERVAL_MINUTES = 5;
// Mesmo teto da sincronização: o setTimeout do Node dispara na hora acima de ~24,8 dias.
export const MAX_REACHABILITY_INTERVAL_MINUTES = 1440;

export type ReachabilityTrigger = 'STARTUP' | 'AUTO' | 'MANUAL';

export interface ReachabilityResult {
  total: number;
  responding: number;
  notResponding: number;
  checkedAt: string;
  durationMs: number;
}

export interface ReachabilityStatus {
  /** false no modo demonstração (sem WinRM): nada é verificado. */
  available: boolean;
  unavailableReason: string | null;
  autoCheckEnabled: boolean;
  intervalMinutes: number;
  running: boolean;
  /** Andamento da rodada em curso; null fora dela. */
  progress: { checked: number; total: number } | null;
  lastRunAt: string | null;
  lastTrigger: ReachabilityTrigger | null;
  lastResult: ReachabilityResult | null;
  lastError: string | null;
  nextRunAt: string | null;
}

type Probe = (host: string, port: number, timeoutMs: number) => Promise<ProbeResult>;

@Injectable()
export class MachineReachabilityScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MachineReachabilityScheduler.name);
  private readonly intervalMinutes: number;
  private timer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private running = false;
  private progress: ReachabilityStatus['progress'] = null;
  private lastRunAt: string | null = null;
  private lastTrigger: ReachabilityTrigger | null = null;
  private lastResult: ReachabilityResult | null = null;
  private lastError: string | null = null;
  private nextRunAt: string | null = null;
  /** Trocável nos testes. */
  probe: Probe = probePort;

  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: PowerShellExecutor,
  ) {
    this.intervalMinutes = parseReachabilityInterval(process.env.MACHINE_REACHABILITY_INTERVAL_MINUTES, this.logger);
  }

  get available(): boolean {
    return this.executor.isAvailable;
  }

  private get autoCheckEnabled(): boolean {
    return this.available && this.intervalMinutes > 0;
  }

  onApplicationBootstrap(): void {
    if (!this.available) {
      this.logger.log(`Verificação do WinRM desligada: ${this.executor.unavailableReason}`);
      return;
    }
    if (this.intervalMinutes === 0) {
      this.logger.log('Verificação automática do WinRM desligada (MACHINE_REACHABILITY_INTERVAL_MINUTES=0).');
      return;
    }
    this.logger.log(`Verificação do WinRM (porta ${WINRM_PORT}) a cada ${this.intervalMinutes} min.`);
    void this.runScheduled('STARTUP');
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.clearTimer();
  }

  /**
   * "Verificar agora": começa uma rodada em segundo plano e devolve o status na hora (a
   * rodada inteira pode levar minutos com mais de mil máquinas). 503 sem WinRM; 409 com
   * uma rodada em andamento.
   */
  start(trigger: ReachabilityTrigger = 'MANUAL'): ReachabilityStatus {
    this.assertCanRun();
    void this.runScheduled(trigger);
    return this.getStatus();
  }

  /** Uma rodada completa (os testes esperam por ela). */
  async run(trigger: ReachabilityTrigger): Promise<ReachabilityResult> {
    this.assertCanRun();
    this.clearTimer();
    this.running = true;
    this.lastTrigger = trigger;
    const started = Date.now();
    try {
      const result = await this.checkAll(started);
      this.lastResult = result;
      this.lastError = null;
      this.logger.log(
        `Verificação do WinRM (${trigger}): ${result.responding} de ${result.total} respondendo, em ${(result.durationMs / 1000).toFixed(1)} s.`,
      );
      return result;
    } catch (err) {
      this.lastError = 'Erro inesperado na verificação.';
      this.logger.error(`Verificação do WinRM (${trigger}) falhou: ${(err as Error).message}`);
      throw err;
    } finally {
      this.running = false;
      this.progress = null;
      this.lastRunAt = new Date().toISOString();
      this.scheduleNext();
    }
  }

  getStatus(): ReachabilityStatus {
    return {
      available: this.available,
      unavailableReason: this.available ? null : this.executor.unavailableReason,
      autoCheckEnabled: this.autoCheckEnabled,
      intervalMinutes: this.intervalMinutes,
      running: this.running,
      progress: this.progress ? { ...this.progress } : null,
      lastRunAt: this.lastRunAt,
      lastTrigger: this.lastTrigger,
      lastResult: this.lastResult,
      lastError: this.lastError,
      nextRunAt: this.nextRunAt,
    };
  }

  private assertCanRun(): void {
    if (!this.available) {
      throw new ServiceUnavailableException(
        `A verificação do WinRM está desligada neste servidor: ${this.executor.unavailableReason}`,
      );
    }
    if (this.running) throw new ConflictException('Já existe uma verificação em andamento.');
  }

  /** Só as máquinas presentes na última sincronização com o AD. */
  private async checkAll(started: number): Promise<ReachabilityResult> {
    const aggregate = await this.prisma.machine.aggregate({ _max: { lastSync: true } });
    const lastSyncAt = aggregate._max.lastSync;
    const machines = lastSyncAt
      ? await this.prisma.machine.findMany({ where: { lastSync: lastSyncAt }, select: { id: true, hostname: true } })
      : [];
    this.progress = { checked: 0, total: machines.length };

    const results = await mapWithLimit(
      machines,
      PROBE_PARALLEL,
      async (m) => ({ id: m.id, ...(await this.safeProbe(m.hostname)) }),
      () => {
        if (this.progress) this.progress.checked += 1;
      },
    );

    // Todas com a mesma data, em duas atualizações em lote.
    const checkedAt = new Date();
    const responding = results.filter((r) => r.responding).map((r) => r.id);
    const notResponding = results.filter((r) => !r.responding).map((r) => r.id);
    await this.prisma.$transaction([
      this.prisma.machine.updateMany({
        where: { id: { in: responding } },
        data: { status: MachineStatus.ONLINE, statusCheckedAt: checkedAt },
      }),
      this.prisma.machine.updateMany({
        where: { id: { in: notResponding } },
        data: { status: MachineStatus.OFFLINE, statusCheckedAt: checkedAt },
      }),
    ]);
    return {
      total: machines.length,
      responding: responding.length,
      notResponding: notResponding.length,
      checkedAt: checkedAt.toISOString(),
      durationMs: Date.now() - started,
    };
  }

  /** Uma sonda que lança conta como "sem resposta" (a rodada nunca para por uma máquina). */
  private async safeProbe(hostname: string): Promise<ProbeResult> {
    try {
      return await this.probe(hostname, WINRM_PORT, PROBE_TIMEOUT_MS);
    } catch {
      return { responding: false, outcome: 'error' };
    }
  }

  /** Disparos do timer, da subida e do botão: nunca propagam erro. */
  private async runScheduled(trigger: ReachabilityTrigger): Promise<void> {
    try {
      await this.run(trigger);
    } catch (err) {
      if (err instanceof ConflictException) this.logger.log(`Verificação ${trigger} pulada: já havia uma em andamento.`);
    }
  }

  private scheduleNext(): void {
    this.clearTimer();
    if (!this.autoCheckEnabled || this.destroyed) return;
    const delayMs = this.intervalMinutes * 60_000;
    this.timer = setTimeout(() => void this.runScheduled('AUTO'), delayMs);
    this.timer.unref?.();
    this.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
  }
}

/** Intervalo em minutos; 0 = verificação automática desligada (o botão continua valendo). */
export function parseReachabilityInterval(raw: string | undefined, logger?: Logger): number {
  const name = 'MACHINE_REACHABILITY_INTERVAL_MINUTES';
  if (raw === undefined || raw.trim() === '') return DEFAULT_REACHABILITY_INTERVAL_MINUTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    logger?.warn(`${name} inválido ("${raw}"); usando ${DEFAULT_REACHABILITY_INTERVAL_MINUTES}.`);
    return DEFAULT_REACHABILITY_INTERVAL_MINUTES;
  }
  if (value === 0) return 0;
  if (value < MIN_REACHABILITY_INTERVAL_MINUTES) {
    logger?.warn(`${name}=${value} abaixo do mínimo; usando ${MIN_REACHABILITY_INTERVAL_MINUTES}.`);
    return MIN_REACHABILITY_INTERVAL_MINUTES;
  }
  if (value > MAX_REACHABILITY_INTERVAL_MINUTES) {
    logger?.warn(`${name}=${value} acima do teto; usando ${MAX_REACHABILITY_INTERVAL_MINUTES}.`);
    return MAX_REACHABILITY_INTERVAL_MINUTES;
  }
  return value;
}
