import { apiFetch } from './apiClient';
import type { MachineListResponse, ReachabilityStatus, SyncResult, SyncStatus } from '../types/machine';

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

/** Andamento e resultado da verificação do WinRM (porta 5985). */
export function getReachabilityStatus(): Promise<ReachabilityStatus> {
  return apiFetch<ReachabilityStatus>(`/machines/reachability/status`);
}

/**
 * "Verificar agora" (ADMIN/OPERATOR): começa a verificação em segundo plano (202). 409 se
 * já houver uma em andamento; 503 sem WinRM neste servidor.
 */
export function checkReachability(): Promise<ReachabilityStatus> {
  return apiFetch<ReachabilityStatus>(`/machines/reachability/check`, { method: 'POST' });
}
