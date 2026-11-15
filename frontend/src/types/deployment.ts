// Espelha backend/src/deployments/deployments.service.ts (views) — manter em sincronia.
import type { InstallType } from './software';

export type DeploymentStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface DeploymentLog {
  timestamp: string;
  level: LogLevel;
  message: string;
}

export interface DeploymentTarget {
  id: string;
  machineId: string;
  hostname: string;
  status: DeploymentStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** null = não executou, falhou antes de executar, ou MSI "já instalado". */
  exitCode: number | null;
  /** Último passo registrado (fase atual, enquanto executa). */
  lastLog: DeploymentLog | null;
}

export interface DeploymentCounts {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface DeploymentSummary {
  id: string;
  name: string;
  status: DeploymentStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  software: { id: string; name: string; version: string; installType: InstallType };
  requestedBy: { username: string; displayName: string | null };
  counts: DeploymentCounts;
}

export interface Deployment extends DeploymentSummary {
  targets: DeploymentTarget[];
}

export interface DeploymentCreateInput {
  softwareId: string;
  machineIds: string[];
  name?: string;
}

/** Limite do backend (deployment-validation.ts: MAX_TARGETS_PER_DEPLOYMENT). */
export const MAX_TARGETS_PER_DEPLOYMENT = 50;

/** GET /deployments/summary — contadores do painel de Monitoramento. */
export interface DeploymentOverview {
  /** Implantações ainda não encerradas. */
  activeDeployments: number;
  /** Máquinas instalando agora e máquinas na fila (de todas as implantações). */
  runningTargets: number;
  pendingTargets: number;
  windowHours: number;
  /** Implantações encerradas nas últimas `windowHours` horas, por status final. */
  finishedInWindow: { succeeded: number; failed: number; cancelled: number };
}

/** GET /deployments — uma página da lista, com o total para a paginação. */
export interface DeploymentPage {
  items: DeploymentSummary[];
  total: number;
  page: number;
  pageSize: number;
}

/** Filtros do Histórico. Datas como instante ISO 8601 (o dia já convertido no fuso local). */
export interface DeploymentListFilters {
  page?: number;
  pageSize?: number;
  status?: DeploymentStatus;
  softwareId?: string;
  machine?: string;
  from?: string;
  to?: string;
  /** Só as criadas pelo usuário logado (o backend identifica pelo token). */
  mine?: boolean;
}

/** GET /dashboard — resumo da tela inicial (espelha backend/src/dashboard/dashboard.service.ts). */
export interface DashboardActivity {
  kind: 'deployment' | 'software';
  at: string;
  by: string | null;
  deploymentId?: string;
  status?: DeploymentStatus;
  succeeded?: number;
  failed?: number;
  total?: number;
  softwareName: string;
  softwareVersion: string;
}

export interface SystemCheck {
  ok: boolean;
  detail: string | null;
}

export interface DashboardData {
  machines: { total: number; seenInLastSync: number; lastSyncAt: string | null };
  deployments: DeploymentOverview & { failureRate: number | null };
  activity: DashboardActivity[];
  system: {
    database: SystemCheck;
    ldap: SystemCheck;
    deployment: { available: boolean; detail: string | null };
    lastSyncAt: string | null;
    checkedAt: string;
  };
}
