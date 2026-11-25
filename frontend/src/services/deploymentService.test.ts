import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exportDeploymentsCsv, getDeploymentLimits, listDeployments } from './deploymentService';
import { apiDownload, apiFetch } from './apiClient';

vi.mock('./apiClient', () => ({ apiFetch: vi.fn(), apiDownload: vi.fn() }));

describe('deploymentService — filtros viram a query string da API', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockResolvedValue({});
    vi.mocked(apiDownload).mockResolvedValue({ blob: new Blob(), fileName: null });
  });

  it('lista com os filtros preenchidos; vazios e "Minhas" desligado não vão', async () => {
    await listDeployments({ page: 2, pageSize: 20, status: 'PARTIAL', machine: 'pc-01', softwareId: '', mine: false });
    expect(apiFetch).toHaveBeenCalledWith('/deployments?page=2&pageSize=20&status=PARTIAL&machine=pc-01');
  });

  it('"Minhas" ligado vira mine=true (quem é "eu" o backend tira do token)', async () => {
    await listDeployments({ mine: true });
    expect(apiFetch).toHaveBeenCalledWith('/deployments?mine=true');
  });

  it('sem filtros, sem "?"', async () => {
    await listDeployments();
    expect(apiFetch).toHaveBeenCalledWith('/deployments');
  });

  it('exportação usa os MESMOS filtros da lista, mas todas as páginas (sem page/pageSize)', async () => {
    await exportDeploymentsCsv({ page: 3, pageSize: 20, status: 'FAILED', from: '2026-11-01T03:00:00.000Z', mine: true });
    expect(apiDownload).toHaveBeenCalledWith('/deployments/export?status=FAILED&from=2026-11-01T03%3A00%3A00.000Z&mine=true');
  });

  it('limite de máquinas vem do backend (DEPLOYMENT_MAX_MACHINES)', async () => {
    await getDeploymentLimits();
    expect(apiFetch).toHaveBeenCalledWith('/deployments/limits');
  });
});
