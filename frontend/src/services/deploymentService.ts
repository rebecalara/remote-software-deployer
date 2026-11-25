import { apiDownload, apiFetch } from './apiClient';
import type {
  DashboardData,
  Deployment,
  DeploymentCreateInput,
  DeploymentLimits,
  DeploymentListFilters,
  DeploymentLog,
  DeploymentOverview,
  DeploymentPage,
} from '../types/deployment';

/**
 * Cria e enfileira (ADMIN/OPERATOR). Responde na hora, com as máquinas PENDING; a
 * instalação segue em segundo plano. 503 com o motivo se a implantação estiver
 * indisponível no servidor; 409 se alguma máquina saiu do AD ou se já existe uma
 * implantação igual em andamento numa das máquinas.
 */
export function createDeployment(input: DeploymentCreateInput): Promise<Deployment> {
  return apiFetch<Deployment>('/deployments', { method: 'POST', body: input });
}

/** Limites que a tela confere antes de enviar (máquinas por implantação, do .env do backend). */
export function getDeploymentLimits(): Promise<DeploymentLimits> {
  return apiFetch<DeploymentLimits>('/deployments/limits');
}

/** Mais recentes primeiro, paginada e com filtros (Histórico). 400 com o campo se um filtro for inválido. */
/** Filtros → query string, igual para a lista e a exportação (mesma validação no backend). */
function filterQuery(filters: DeploymentListFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '' && value !== false) params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function listDeployments(filters: DeploymentListFilters = {}): Promise<DeploymentPage> {
  return apiFetch<DeploymentPage>(`/deployments${filterQuery(filters)}`);
}

/**
 * Histórico em CSV com os mesmos filtros da lista, todas as páginas (page/pageSize não vão).
 * Devolve o arquivo e o nome dado pelo servidor (rsd-historico-AAAA-MM-DD.csv).
 */
export function exportDeploymentsCsv(filters: DeploymentListFilters): Promise<{ blob: Blob; fileName: string | null }> {
  const { page: _page, pageSize: _pageSize, ...rest } = filters;
  return apiDownload(`/deployments/export${filterQuery(rest)}`);
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
