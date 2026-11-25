import { Injectable, Logger } from '@nestjs/common';
import { DeploymentAction, DeploymentStatus } from '@prisma/client';
import { DeploymentDisplayStatus, displayStatus } from '../deployments/deployment-outcome';
import { DeploymentsService, type DeploymentOverview } from '../deployments/deployments.service';
import { PowerShellExecutor } from '../deployments/powershell-executor';
import { LdapAuthenticationError, LdapService } from '../ldap/ldap.service';
import { PrismaService } from '../prisma/prisma.service';

// Dashboard (tela inicial): resumo SÓ com dado real (DECISIONS.md, recorte do mockup).
// Junta numa resposta máquinas, implantações, atividade recente e status do sistema.

export const ACTIVITY_LIMIT = 10;
/** O bind no LDAP é cacheado por este tempo: abrir o Dashboard não pode virar um bind por visita. */
export const LDAP_CHECK_CACHE_MS = 30_000;

export interface ActivityItem {
  kind: 'deployment' | 'software';
  at: string;
  /** Quem fez: quem pediu a implantação ou quem cadastrou o software. */
  by: string | null;
  /** deployment: status final e contagem; software: tipo do instalador. */
  deploymentId?: string;
  /** deployment: instalação ou desinstalação. */
  action?: DeploymentAction;
  /** PARTIAL = alguma máquina concluiu e alguma falhou (calculado). */
  status?: DeploymentDisplayStatus;
  succeeded?: number;
  failed?: number;
  total?: number;
  softwareName: string;
  softwareVersion: string;
  /** deployment: false = produto fora do catálogo (desinstalação pelo inventário). */
  inCatalog?: boolean;
}

export interface SystemCheck {
  ok: boolean;
  /** Motivo, quando não está ok. */
  detail: string | null;
  /**
   * Qual falha, para o texto da tela: 'refused' = o serviço respondeu e recusou a conta
   * (só no AD/LDAP); 'no-response' = não respondeu ou outro erro. null quando ok.
   */
  reason: 'refused' | 'no-response' | null;
}

export interface DashboardView {
  machines: { total: number; seenInLastSync: number; lastSyncAt: string | null };
  /**
   * Máquinas presentes no AD que responderam na porta do WinRM na última verificação.
   * available false = verificação desligada neste servidor (sem WinRM), com o motivo.
   */
  reachability: {
    available: boolean;
    detail: string | null;
    responding: number;
    total: number;
    checkedAt: string | null;
  };
  deployments: DeploymentOverview & {
    /**
     * Sobre as encerradas na janela, sem as canceladas (concluídas + parciais + falhas);
     * null sem nenhuma. Falha = nenhuma máquina concluiu; parcial não conta nem como
     * sucesso nem como falha.
     */
    failureRate: number | null;
    successRate: number | null;
  };
  activity: ActivityItem[];
  system: {
    database: SystemCheck;
    ldap: SystemCheck;
    deployment: { available: boolean; detail: string | null };
    lastSyncAt: string | null;
    checkedAt: string;
  };
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  private ldapCache: { at: number; result: SystemCheck } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly executor: PowerShellExecutor,
    private readonly ldap: LdapService,
  ) {}

  async overview(now: Date = new Date()): Promise<DashboardView> {
    const database = await this.checkDatabase();
    const [machines, summary, activity, ldap] = await Promise.all([
      this.machineCounts(),
      this.deployments.summary(now),
      this.activity(),
      this.checkLdap(now.getTime()),
    ]);
    const { succeeded, partial, failed } = summary.finishedInWindow;
    const ended = succeeded + partial + failed;
    const reachability = await this.reachabilityCounts(machines.lastSyncAt, machines.seenInLastSync);
    return {
      machines,
      reachability,
      deployments: {
        ...summary,
        failureRate: ended > 0 ? failed / ended : null,
        successRate: ended > 0 ? succeeded / ended : null,
      },
      activity,
      system: {
        database,
        ldap,
        deployment: { available: this.executor.isAvailable, detail: this.executor.unavailableReason },
        lastSyncAt: machines.lastSyncAt,
        checkedAt: now.toISOString(),
      },
    };
  }

  private async checkDatabase(): Promise<SystemCheck> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true, detail: null, reason: null };
    } catch (err) {
      return { ok: false, detail: (err as Error).message, reason: 'no-response' };
    }
  }

  /** Bind da conta de serviço de leitura, com cache curto. */
  private async checkLdap(nowMs: number): Promise<SystemCheck> {
    if (this.ldapCache && nowMs - this.ldapCache.at < LDAP_CHECK_CACHE_MS) return this.ldapCache.result;
    let result: SystemCheck;
    try {
      await this.ldap.checkServiceAccount();
      result = { ok: true, detail: null, reason: null };
    } catch (err) {
      const refused = err instanceof LdapAuthenticationError;
      result = {
        ok: false,
        detail: refused
          ? 'O AD/LDAP respondeu, mas recusou a conta de serviço de leitura.'
          : `O AD/LDAP não respondeu${(err as Error).message ? `: ${(err as Error).message}` : ' (conexão recusada ou tempo esgotado).'}`,
        reason: refused ? 'refused' : 'no-response',
      };
      this.logger.warn(`Status do sistema: ${result.detail}`);
    }
    this.ldapCache = { at: nowMs, result };
    return result;
  }

  private async machineCounts(): Promise<DashboardView['machines']> {
    const [total, aggregate] = await Promise.all([
      this.prisma.machine.count(),
      this.prisma.machine.aggregate({ _max: { lastSync: true } }),
    ]);
    const lastSyncAt = aggregate._max.lastSync;
    // Mesma regra de "presente no AD" da tela de Máquinas (isSeenInLastSync).
    const seenInLastSync = lastSyncAt ? await this.prisma.machine.count({ where: { lastSync: lastSyncAt } }) : 0;
    return { total, seenInLastSync, lastSyncAt: lastSyncAt?.toISOString() ?? null };
  }

  /** "N de M respondendo no WinRM", só entre as máquinas presentes no AD. */
  private async reachabilityCounts(lastSyncAt: string | null, present: number): Promise<DashboardView['reachability']> {
    const available = this.executor.isAvailable;
    const base = { available, detail: available ? null : this.executor.unavailableReason, total: present };
    if (!available || !lastSyncAt) return { ...base, responding: 0, checkedAt: null };
    const where = { lastSync: new Date(lastSyncAt) };
    const [responding, aggregate] = await Promise.all([
      this.prisma.machine.count({ where: { ...where, status: 'ONLINE', statusCheckedAt: { not: null } } }),
      this.prisma.machine.aggregate({ where, _max: { statusCheckedAt: true } }),
    ]);
    return { ...base, responding, checkedAt: aggregate._max.statusCheckedAt?.toISOString() ?? null };
  }

  /** Implantações encerradas e softwares cadastrados, os mais recentes primeiro. */
  private async activity(): Promise<ActivityItem[]> {
    const [deployments, software] = await Promise.all([
      this.prisma.deployment.findMany({
        where: { finishedAt: { not: null } },
        orderBy: { finishedAt: 'desc' },
        take: ACTIVITY_LIMIT,
        include: {
          software: { select: { name: true, version: true } },
          user: { select: { username: true, displayName: true } },
          targets: { select: { status: true } },
        },
      }),
      this.prisma.software.findMany({
        orderBy: { createdAt: 'desc' },
        take: ACTIVITY_LIMIT,
        include: { createdBy: { select: { username: true, displayName: true } } },
      }),
    ]);
    const items: ActivityItem[] = [
      ...deployments.map((d) => ({
        kind: 'deployment' as const,
        at: d.finishedAt!.toISOString(),
        by: d.user.displayName || d.user.username,
        deploymentId: d.id,
        action: d.action,
        status: displayStatus(d.status, {
          succeeded: d.targets.filter((t) => t.status === DeploymentStatus.SUCCEEDED).length,
        }),
        succeeded: d.targets.filter((t) => t.status === DeploymentStatus.SUCCEEDED).length,
        failed: d.targets.filter((t) => t.status === DeploymentStatus.FAILED).length,
        total: d.targets.length,
        // Desinstalação de MSI fora do catálogo: não há software; vale a cópia do produto.
        softwareName: d.software?.name ?? d.productName ?? d.productCode ?? '—',
        softwareVersion: d.software ? d.software.version : (d.productVersion ?? ''),
        inCatalog: d.software !== null,
      })),
      ...software.map((s) => ({
        kind: 'software' as const,
        at: s.createdAt.toISOString(),
        by: s.createdBy ? s.createdBy.displayName || s.createdBy.username : null,
        softwareName: s.name,
        softwareVersion: s.version,
      })),
    ];
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_LIMIT);
  }
}
