import { Injectable, Logger } from '@nestjs/common';
import { DeploymentAction, DeploymentStatus } from '@prisma/client';
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
  status?: DeploymentStatus;
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
}

export interface DashboardView {
  machines: { total: number; seenInLastSync: number; lastSyncAt: string | null };
  deployments: DeploymentOverview & {
    /** Falhas / (concluídas + falhas) na janela; null sem nenhuma encerrada. */
    failureRate: number | null;
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
    const { succeeded, failed } = summary.finishedInWindow;
    return {
      machines,
      deployments: { ...summary, failureRate: succeeded + failed > 0 ? failed / (succeeded + failed) : null },
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
      return { ok: true, detail: null };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /** Bind da conta de serviço de leitura, com cache curto. */
  private async checkLdap(nowMs: number): Promise<SystemCheck> {
    if (this.ldapCache && nowMs - this.ldapCache.at < LDAP_CHECK_CACHE_MS) return this.ldapCache.result;
    let result: SystemCheck;
    try {
      await this.ldap.checkServiceAccount();
      result = { ok: true, detail: null };
    } catch (err) {
      result = {
        ok: false,
        detail:
          err instanceof LdapAuthenticationError
            ? 'O AD/LDAP respondeu, mas recusou a conta de serviço de leitura.'
            : `O AD/LDAP não respondeu${(err as Error).message ? `: ${(err as Error).message}` : ' (conexão recusada ou tempo esgotado).'}`,
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
        status: d.status,
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
