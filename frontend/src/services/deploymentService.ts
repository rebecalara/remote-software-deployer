import { apiFetch } from './apiClient';
import type {
  DashboardData,
  Deployment,
  DeploymentCreateInput,
  DeploymentListFilters,
  DeploymentLog,
  DeploymentOverview,
  DeploymentPage,
} from '../types/deployment';

/**
 * Cria e enfileira (ADMIN/OPERATOR). Responde na hora, com as máquinas PENDING; a
 * instalação segue em segundo plano. 503 com o motivo se a implantação estiver
 * indisponível no servidor; 409 se alguma máquina saiu do AD.
 */
export function createDeployment(input: DeploymentCreateInput): Promise<Deployment> {
  return apiFetch<Deployment>('/deployments', { method: 'POST', body: input });
}

/** Mais recentes primeiro, paginada e com filtros (Histórico). 400 com o campo se um filtro for inválido. */
export function listDeployments(filters: DeploymentListFilters = {}): Promise<DeploymentPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '' && value !== false) params.set(key, String(value));
  }
  const query = params.toString();
  return apiFetch<DeploymentPage>(`/deployments${query ? `?${query}` : ''}`);
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

/** Contadores do painel de Monitoramento, sobre todas as implantações. */
export function getDeploymentOverview(): Promise<DeploymentOverview> {
  return apiFetch<DeploymentOverview>('/deployments/summary');
}

/** Resumo da tela inicial: máquinas, implantações, atividade e status do sistema. */
export function getDashboard(): Promise<DashboardData> {
  return apiFetch<DashboardData>('/dashboard');
}
