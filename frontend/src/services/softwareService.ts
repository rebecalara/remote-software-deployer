import { apiFetch, apiUpload, type UploadOptions } from './apiClient';
import type { InstallerLimits, Software, SoftwareCreateInput, SoftwareUpdateInput } from '../types/software';

/** Limite de tamanho e se o envio está disponível no servidor. */
export function getInstallerLimits(): Promise<InstallerLimits> {
  return apiFetch<InstallerLimits>('/software/installer-limits');
}

/** Por padrão só os ativos; includeInactive traz também os desativados. */
export function listSoftware(includeInactive = false): Promise<Software[]> {
  return apiFetch<Software[]>(`/software${includeInactive ? '?includeInactive=true' : ''}`);
}

export function getSoftware(id: string): Promise<Software> {
  return apiFetch<Software>(`/software/${encodeURIComponent(id)}`);
}

/** Etapa 1 do cadastro: os dados, em JSON. O instalador vai depois, em uploadInstaller. */
export function createSoftware(input: SoftwareCreateInput): Promise<Software> {
  return apiFetch<Software>('/software', { method: 'POST', body: input });
}

/**
 * Só os campos enviados. Depois da primeira implantação, versão, tipo e argumentos
 * ficam travados (409); o tipo também trava depois do envio do instalador.
 */
export function updateSoftware(id: string, input: SoftwareUpdateInput): Promise<Software> {
  return apiFetch<Software>(`/software/${encodeURIComponent(id)}`, { method: 'PATCH', body: input });
}

export function deactivateSoftware(id: string): Promise<Software> {
  return apiFetch<Software>(`/software/${encodeURIComponent(id)}/deactivate`, { method: 'POST' });
}

export function activateSoftware(id: string): Promise<Software> {
  return apiFetch<Software>(`/software/${encodeURIComponent(id)}/activate`, { method: 'POST' });
}

/** Só software nunca implantado; com implantações, 409 orientando desativar. */
export function deleteSoftware(id: string): Promise<void> {
  return apiFetch<void>(`/software/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Etapa 2 do cadastro: envia (ou troca) o instalador, com progresso e cancelamento.
 * O servidor calcula o SHA-256 e confere o cabeçalho contra o tipo cadastrado.
 */
export function uploadInstaller(id: string, file: File, options: UploadOptions = {}): Promise<Software> {
  return apiUpload<Software>(`/software/${encodeURIComponent(id)}/installer`, file, options);
}
