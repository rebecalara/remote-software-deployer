// Espelha backend/src/machines/*.ts (MachineView, SyncResult, SyncStatus) — manter em sincronia.

export type MachineStatus = 'ONLINE' | 'OFFLINE' | 'UNKNOWN';

export interface Machine {
  id: string;
  hostname: string;
  ipAddress: string | null;
  operatingSystem: string | null;
  department: string | null;
  /** Verificação da porta do WinRM: ONLINE = "respondendo no WinRM" (não "ligada"). */
  status: MachineStatus;
  /** ISO 8601. Quando a porta do WinRM foi verificada pela última vez (null = nunca). */
  statusCheckedAt: string | null;
  /** ISO 8601. Última sincronização em que o AD confirmou esta máquina. */
  lastSync: string | null;
  /** false = não apareceu na sincronização mais recente (saiu do AD). */
  seenInLastSync: boolean;
}

export interface MachineListResponse {
  machines: Machine[];
  lastSyncAt: string | null;
}

// Espelha backend/src/machines/machine-reachability.scheduler.ts.
export interface ReachabilityResult {
  total: number;
  responding: number;
  notResponding: number;
  checkedAt: string;
  durationMs: number;
}

export interface ReachabilityStatus {
  /** false no modo demonstração (sem WinRM). */
  available: boolean;
  unavailableReason: string | null;
  autoCheckEnabled: boolean;
  intervalMinutes: number;
  running: boolean;
  progress: { checked: number; total: number } | null;
  lastRunAt: string | null;
  lastTrigger: 'STARTUP' | 'AUTO' | 'MANUAL' | null;
  lastResult: ReachabilityResult | null;
  lastError: string | null;
  nextRunAt: string | null;
}

export interface SyncResult {
  total: number;
  created: number;
  updated: number;
  notSeen: number;
  syncedAt: string;
}

export type SyncTrigger = 'STARTUP' | 'AUTO' | 'MANUAL';

export interface SyncStatus {
  running: boolean;
  autoSyncEnabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  lastTrigger: SyncTrigger | null;
  /** Último SUCESSO — preservado quando uma tentativa posterior falha. */
  lastResult: SyncResult | null;
  lastError: string | null;
  nextRunAt: string | null;
}
