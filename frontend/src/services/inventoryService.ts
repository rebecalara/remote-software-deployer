import { apiFetch } from './apiClient';
import type { InventoryState, MachineInventory } from '../types/inventory';

/** Última consulta guardada (ou null) e se a consulta ao vivo está disponível. Qualquer perfil. */
export function getInventory(machineId: string): Promise<InventoryState> {
  return apiFetch<InventoryState>(`/machines/${encodeURIComponent(machineId)}/inventory`);
}

/**
 * Consulta a máquina AO VIVO pelo WinRM (ADMIN/OPERATOR) e guarda o resultado. Síncrona:
 * pode levar até ~2 min. Falha na máquina: 502/504 com a mensagem do motivo; 409 se já
 * houver consulta para a máquina; 503 se a consulta estiver indisponível no servidor.
 */
export function collectInventory(machineId: string): Promise<MachineInventory> {
  return apiFetch<MachineInventory>(`/machines/${encodeURIComponent(machineId)}/inventory`, { method: 'POST' });
}
