// Espelha backend/src/deployments/deployments.service.ts (views) — manter em sincronia.
import type { InstallType } from './software';

export type DeploymentStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
/**
 * Status de uma IMPLANTAÇÃO como a API devolve: o do banco mais PARTIAL, calculado pelo
 * backend (FAILED em que alguma máquina concluiu). "Falhou" = nenhuma máquina concluiu.
 * Máquinas (DeploymentTarget) nunca são PARTIAL.
 */
export type DeploymentDisplayStatus = DeploymentStatus | 'PARTIAL';
/** Instalar ou desinstalar (desinstalar só existe para MSI). */
export type DeploymentAction = 'INSTALL' | 'UNINSTALL';
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
  action: DeploymentAction;
  status: DeploymentDisplayStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** null = desinstalação de um MSI fora do catálogo (ver `product`). */
  software: { id: string; name: string; version: string; installType: InstallType } | null;
  /** Desinstalação: o produto removido (cópia do momento da criação). */
  product: { productCode: string | null; name: string; version: string | null; publisher: string | null } | null;
  /** Desinstalação por comando do fabricante: o comando exato executado. */
  vendorCommand: string | null;
  requestedBy: { username: string; displayName: string | null };
  counts: DeploymentCounts;
}

export interface Deployment extends DeploymentSummary {
  targets: DeploymentTarget[];
}

export interface DeploymentCreateInput {
  /** Ausente = INSTALL. */
  action?: DeploymentAction;
  /** Software do catálogo. Na desinstalação, ou ele ou o productCode. */
  softwareId?: string;
  /** Só desinstalação: MSI escolhido pelo inventário guardado das máquinas. */
  productCode?: string;
  /** Só desinstalação: programa (não MSI) pelo comando do fabricante — id do servidor. */
  programId?: string;
  machineIds: string[];
  name?: string;
}

/** GET /deployments/limits — máquinas por implantação (DEPLOYMENT_MAX_MACHINES no backend). */
export interface DeploymentLimits {
  maxMachines: number;
}

/** GET /deployments/summary — contadores do painel de Monitoramento. */
export interface DeploymentOverview {
  /** Implantações ainda não encerradas. */
  activeDeployments: number;
  /** Máquinas instalando agora e máquinas na fila (de todas as implantações). */
  runningTargets: number;
  pendingTargets: number;
  windowHours: number;
  /** Implantações encerradas nas últimas `windowHours` horas, por status final. */
  /** failed = nenhuma máquina concluiu; partial = alguma concluiu e alguma falhou. */
  finishedInWindow: { succeeded: number; partial: number; failed: number; cancelled: number };
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
  status?: DeploymentDisplayStatus;
  softwareId?: string;
  machine?: string;
  from?: string;
  to?: string;
  /** Só as criadas pelo usuário logado (o backend identifica pelo token). */
  mine?: boolean;
  /** "active" = ainda não encerrada; "finished" = encerrada. */
  state?: 'active' | 'finished';
  /** Encerradas a partir deste instante (ISO 8601). */
  finishedFrom?: string;
  action?: DeploymentAction;
}

/** GET /dashboard — resumo da tela inicial (espelha backend/src/dashboard/dashboard.service.ts). */
export interface DashboardActivity {
  kind: 'deployment' | 'software';
  at: string;
  by: string | null;
  deploymentId?: string;
  action?: DeploymentAction;
  status?: DeploymentDisplayStatus;
  succeeded?: number;
  failed?: number;
  total?: number;
  softwareName: string;
  softwareVersion: string;
  /** false = produto fora do catálogo (desinstalação pelo inventário). */
  inCatalog?: boolean;
}

export interface SystemCheck {
  ok: boolean;
  detail: string | null;
  /** 'refused' = respondeu e recusou a conta (AD/LDAP); 'no-response' = não respondeu. */
  reason: 'refused' | 'no-response' | null;
}

export interface DashboardData {
  machines: { total: number; seenInLastSync: number; lastSyncAt: string | null };
  /** Presentes no AD que responderam na porta do WinRM; available false = desligada (sem WinRM). */
  reachability: { available: boolean; detail: string | null; responding: number; total: number; checkedAt: string | null };
  /** Sobre concluídas + parciais + falhas da janela (sem canceladas); null sem nenhuma. */
  deployments: DeploymentOverview & { failureRate: number | null; successRate: number | null };
  activity: DashboardActivity[];
  system: {
    database: SystemCheck;
    ldap: SystemCheck;
    deployment: { available: boolean; detail: string | null };
    lastSyncAt: string | null;
    checkedAt: string;
  };
}
