import { apiFetch } from './apiClient';
import type { Deployment, DeploymentCreateInput, DeploymentLog, DeploymentSummary } from '../types/deployment';

/**
 * Cria e enfileira (ADMIN/OPERATOR). Responde na hora, com as máquinas PENDING; a
 * instalação segue em segundo plano. 503 com o motivo se a implantação estiver
 * indisponível no servidor; 409 se alguma máquina saiu do AD.
 */
export function createDeployment(input: DeploymentCreateInput): Promise<Deployment> {
  return apiFetch<Deployment>('/deployments', { method: 'POST', body: input });
}

/** Mais recentes primeiro, com a contagem por status. */
export function listDeployments(limit?: number): Promise<DeploymentSummary[]> {
  return apiFetch<DeploymentSummary[]>(`/deployments${limit ? `?limit=${limit}` : ''}`);
}

export function getDeployment(id: string): Promise<Deployment> {
  return apiFetch<Deployment>(`/deployments/${encodeURIComponent(id)}`);
}

/** Todos os passos de uma máquina, em ordem (inclusive DEBUG). */
export function getTargetLogs(deploymentId: string, targetId: string): Promise<DeploymentLog[]> {
  return apiFetch<DeploymentLog[]>(
    `/deployments/${encodeURIComponent(deploymentId)}/targets/${encodeURIComponent(targetId)}/logs`,
  );
}

/** Cancela só as máquinas pendentes (ADMIN/OPERATOR); as em execução terminam normalmente. */
export function cancelDeployment(id: string): Promise<Deployment> {
  return apiFetch<Deployment>(`/deployments/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}
