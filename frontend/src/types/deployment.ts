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
