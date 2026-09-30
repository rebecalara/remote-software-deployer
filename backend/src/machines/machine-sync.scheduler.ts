import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { MachineSyncService, SyncResult } from './machine-sync.service';

export type SyncTrigger = 'STARTUP' | 'AUTO' | 'MANUAL';

export interface SyncStatus {
  running: boolean;
  autoSyncEnabled: boolean;
  intervalMinutes: number;
  /** Quando a última sincronização terminou (com sucesso ou falha). */
  lastRunAt: string | null;
  lastTrigger: SyncTrigger | null;
  /** Último SUCESSO — preservado quando uma tentativa posterior falha. */
  lastResult: SyncResult | null;
  /** Mensagem genérica da última tentativa, se ela falhou; null se deu certo. */
  lastError: string | null;
  nextRunAt: string | null;
}

export const DEFAULT_INTERVAL_MINUTES = 60;
export const MIN_INTERVAL_MINUTES = 5;
// setTimeout aceita no máximo 2^31-1 ms (~24,8 dias); acima disso o Node dispara
// IMEDIATAMENTE. O teto de 24h deixa folga e evita sync em loop por valor errado.
export const MAX_INTERVAL_MINUTES = 1440;

const GENERIC_SYNC_ERROR = 'Erro inesperado na sincronização.';

/**
 * Dono único do agendamento. Automático, manual e o da subida passam todos por
 * run(), e ao TERMINAR qualquer um deles o próximo ciclo é agendado a partir de
 * agora — por isso um "Sincronizar agora" reinicia a contagem, e uma sincronização
 * lenta nunca empilha ciclos (setTimeout encadeado, não setInterval).
 */
@Injectable()
export class MachineSyncScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MachineSyncScheduler.name);
  private readonly intervalMinutes: number;
  private readonly autoSyncEnabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private status: Omit<SyncStatus, 'autoSyncEnabled' | 'intervalMinutes'> = {
    running: false,
    lastRunAt: null,
    lastTrigger: null,
    lastResult: null,
    lastError: null,
    nextRunAt: null,
  };

  constructor(private readonly machineSyncService: MachineSyncService) {
    this.intervalMinutes = parseSyncInterval(process.env.MACHINE_SYNC_INTERVAL_MINUTES, this.logger);
    this.autoSyncEnabled = this.intervalMinutes > 0 && hasServiceAccount();
  }

  onApplicationBootstrap(): void {
    if (this.intervalMinutes === 0) {
      this.logger.log('Sincronização automática desligada (MACHINE_SYNC_INTERVAL_MINUTES=0).');
      return;
    }
    if (!hasServiceAccount()) {
      this.logger.warn(
        'Sincronização automática desativada: conta de serviço LDAP não configurada ' +
          '(LDAP_SEARCH_BIND_DN / LDAP_SEARCH_BIND_PASSWORD / LDAP_COMPUTER_BASE_DN).',
      );
      return;
    }
    this.logger.log(`Sincronização automática a cada ${this.intervalMinutes} min.`);
    // Não bloqueia a subida do backend.
    void this.runScheduled('STARTUP');
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.clearTimer();
  }

  /** Ponto de entrada do botão "Sincronizar agora". Propaga 409/503 para o cliente. */
  async run(trigger: SyncTrigger): Promise<SyncResult> {
    // Checado ANTES de cancelar o timer: um clique durante uma sincronização em
    // andamento não pode mexer na contagem.
    if (this.status.running) {
      throw new ConflictException('Já existe uma sincronização em andamento.');
    }

    this.clearTimer();
    this.status.running = true;
    this.status.lastTrigger = trigger;
    try {
      const result = await this.machineSyncService.sync();
      this.status.lastResult = result;
      this.status.lastError = null;
      return result;
    } catch (err) {
      this.status.lastError = err instanceof HttpException ? err.message : GENERIC_SYNC_ERROR;
      throw err;
    } finally {
      this.status.running = false;
      this.status.lastRunAt = new Date().toISOString();
      this.scheduleNext();
    }
  }

  getStatus(): SyncStatus {
    return {
      ...this.status,
      autoSyncEnabled: this.autoSyncEnabled,
      intervalMinutes: this.intervalMinutes,
    };
  }

  /** Disparos do timer e da subida: nunca propagam erro (não podem derrubar o processo). */
  private async runScheduled(trigger: SyncTrigger): Promise<void> {
    try {
      await this.run(trigger);
    } catch (err) {
      if (err instanceof ConflictException) {
        this.logger.log(`Sincronização ${trigger} pulada: já havia uma em andamento.`);
      } else {
        // O detalhe já foi logado pelo MachineSyncService.
        this.logger.warn(`Sincronização ${trigger} falhou: ${(err as Error).message}`);
      }
    }
  }

  private scheduleNext(): void {
    this.clearTimer();
    if (!this.autoSyncEnabled || this.destroyed) {
      this.status.nextRunAt = null;
      return;
    }
    const delayMs = this.intervalMinutes * 60_000;
    this.timer = setTimeout(() => void this.runScheduled('AUTO'), delayMs);
    // Não segura o processo vivo só por causa do agendamento.
    this.timer.unref?.();
    this.status.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.status.nextRunAt = null;
  }
}

/** Retorna o intervalo em minutos; 0 = agendamento desligado. */
export function parseSyncInterval(raw: string | undefined, logger?: Logger): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_INTERVAL_MINUTES;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    logger?.warn(
      `MACHINE_SYNC_INTERVAL_MINUTES inválido ("${raw}"); usando ${DEFAULT_INTERVAL_MINUTES}.`,
    );
    return DEFAULT_INTERVAL_MINUTES;
  }
  if (value === 0) {
    return 0;
  }
  if (value < MIN_INTERVAL_MINUTES) {
    logger?.warn(
      `MACHINE_SYNC_INTERVAL_MINUTES=${value} abaixo do mínimo; usando ${MIN_INTERVAL_MINUTES}.`,
    );
    return MIN_INTERVAL_MINUTES;
  }
  if (value > MAX_INTERVAL_MINUTES) {
    logger?.warn(
      `MACHINE_SYNC_INTERVAL_MINUTES=${value} acima do teto; usando ${MAX_INTERVAL_MINUTES}.`,
    );
    return MAX_INTERVAL_MINUTES;
  }
  return value;
}

function hasServiceAccount(): boolean {
  return Boolean(
    process.env.LDAP_SEARCH_BIND_DN &&
      process.env.LDAP_SEARCH_BIND_PASSWORD &&
      process.env.LDAP_COMPUTER_BASE_DN,
  );
}
