import { apiFetch } from './apiClient';
import type { MachineListResponse, SyncResult, SyncStatus } from '../types/machine';

/** Lista do banco — nunca dispara busca no LDAP. */
export function listMachines(search?: string): Promise<MachineListResponse> {
  const query = search?.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
  return apiFetch<MachineListResponse>(`/machines${query}`);
}

/**
 * "Sincronizar agora" (ADMIN/OPERATOR). Reinicia a contagem da sincronização
 * automática. 409 se já houver uma em andamento; 503 se o AD/LDAP não responder.
 */
export function syncMachines(): Promise<SyncResult & { nextRunAt: string | null }> {
  return apiFetch(`/machines/sync`, { method: 'POST' });
}

export function getSyncStatus(): Promise<SyncStatus> {
  return apiFetch<SyncStatus>(`/machines/sync/status`);
}
