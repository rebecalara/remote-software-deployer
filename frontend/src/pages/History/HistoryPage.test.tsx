import { render, screen, waitFor } from '@testing-library/react';
import { setupUser } from '../../test/user';
import { BrowserRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../context/AuthContext';
import { ApiError } from '../../services/apiClient';
import { exportDeploymentsCsv, listDeployments } from '../../services/deploymentService';
import { storeSession } from '../../test/tokens';
import type { DeploymentPage, DeploymentSummary } from '../../types/deployment';
import { HistoryPage } from './HistoryPage';

// Serviços simulados: nenhum teste chama o backend.
vi.mock('../../services/deploymentService', () => ({
  listDeployments: vi.fn(),
  exportDeploymentsCsv: vi.fn(),
  getDeployment: vi.fn(),
}));
vi.mock('../../services/softwareService', () => ({
  listSoftware: vi.fn(() => Promise.resolve([{ id: 's1', name: '7-Zip', version: '26.06', active: true }])),
}));
vi.mock('../Deployments/DeploymentPanel', () => ({ DeploymentPanel: () => null }));

function item(id: string): DeploymentSummary {
  return {
    id,
    name: '7-Zip 26.06',
    action: 'INSTALL',
    status: 'SUCCEEDED',
    createdAt: '2026-11-24T23:20:00.000Z',
    startedAt: '2026-11-24T23:20:01.000Z',
    finishedAt: '2026-11-24T23:20:23.000Z',
    software: { id: 's1', name: '7-Zip', version: '26.06', installType: 'MSI' },
    product: null,
    vendorCommand: null,
    requestedBy: { username: 'testuser', displayName: 'Test User' },
    counts: { total: 1, pending: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0 },
  };
}
const page = (items: DeploymentSummary[], total = items.length, p = 1): DeploymentPage => ({ items, total, page: p, pageSize: 20 });

/** Abre o Histórico num endereço (o roteador do navegador lê e grava a URL de verdade). */
function openAt(url: string) {
  window.history.replaceState({}, '', url);
  storeSession();
  render(
    <AuthProvider>
      <BrowserRouter>
        <HistoryPage />
      </BrowserRouter>
    </AuthProvider>,
  );
}
const search = () => new URLSearchParams(window.location.search);
const lastFilters = () => vi.mocked(listDeployments).mock.calls.at(-1)![0];

describe('HistoryPage — filtros no endereço, vazios e exportação', () => {
  beforeEach(() => {
    vi.mocked(listDeployments).mockResolvedValue(page([item('d1'), item('d2')]));
  });

  it('lê os filtros do endereço (link copiado / F5) e busca só as encerradas', async () => {
    openAt('/history?status=PARTIAL&mine=true&action=UNINSTALL');
    await screen.findAllByTestId('deployment-title');
    expect(lastFilters()).toEqual(
      expect.objectContaining({ page: 1, pageSize: 20, state: 'finished', status: 'PARTIAL', action: 'UNINSTALL', mine: true }),
    );
    expect(screen.getByRole('radio', { name: 'Minhas implantações' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Status')).toHaveValue('PARTIAL');
  });

  it('em "Minhas", a coluna de quem pediu sai', async () => {
    openAt('/history?mine=true');
    await screen.findAllByTestId('deployment-title');
    expect(screen.queryByText('Solicitada por')).not.toBeInTheDocument();
  });

  it('o "Até" inclui o dia inteiro: vai até o início do dia seguinte, no fuso de quem usa', async () => {
    openAt('/history?from=2026-11-19&to=2026-11-19');
    await screen.findAllByTestId('deployment-title');
    expect(lastFilters()).toEqual(
      expect.objectContaining({ from: new Date(2026, 10, 19).toISOString(), to: new Date(2026, 10, 20).toISOString() }),
    );
  });

  it('período invertido: avisa e nem consulta o backend', async () => {
    openAt('/history?from=2026-11-20&to=2026-11-19');
    expect(await screen.findByRole('alert')).toHaveTextContent('A data final deve ser igual ou posterior à inicial.');
    expect(listDeployments).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeDisabled();
  });

  it('com uma página só, aparece só a contagem', async () => {
    openAt('/history');
    expect(await screen.findByTestId('page-range')).toHaveTextContent('1–2 de 2');
    expect(screen.queryByRole('button', { name: 'Próxima' })).not.toBeInTheDocument();
  });

  it('com várias páginas, "Próxima" muda a página no endereço e busca de novo', async () => {
    vi.mocked(listDeployments).mockResolvedValue(page([item('d1')], 45));
    openAt('/history');
    expect(await screen.findByTestId('page-range')).toHaveTextContent('1–20 de 45');
    await setupUser().click(screen.getByRole('button', { name: 'Próxima' }));
    await waitFor(() => expect(search().get('page')).toBe('2'));
    await waitFor(() => expect(lastFilters()).toEqual(expect.objectContaining({ page: 2 })));
  });

  it('mudar um filtro volta para a página 1 e fica no endereço', async () => {
    openAt('/history?page=3&softwareId=s1');
    await screen.findAllByTestId('deployment-title');
    await setupUser().selectOptions(screen.getByLabelText('Status'), 'FAILED');
    await waitFor(() => expect(search().get('status')).toBe('FAILED'));
    expect(search().get('page')).toBeNull();
    expect(search().get('softwareId')).toBe('s1');
  });

  it('busca por máquina espera parar de digitar e vai para o endereço', async () => {
    openAt('/history');
    await screen.findAllByTestId('deployment-title');
    await setupUser().type(screen.getByLabelText('Máquina'), 'rsd-alvo');
    await waitFor(() => expect(search().get('machine')).toBe('rsd-alvo'), { timeout: 2000 });
    await waitFor(() => expect(lastFilters()).toEqual(expect.objectContaining({ machine: 'rsd-alvo' })));
  });

  it('sem resultado com filtros: mensagem e "Limpar filtros", que mantém a aba "Minhas"', async () => {
    vi.mocked(listDeployments).mockResolvedValue(page([]));
    openAt('/history?mine=true&status=FAILED&machine=pc-99');
    expect(await screen.findByText('Nenhuma implantação com esses filtros.')).toBeInTheDocument();
    // Um "Limpar filtros" só (o da barra some com a lista vazia).
    const clear = screen.getAllByRole('button', { name: 'Limpar filtros' });
    expect(clear).toHaveLength(1);
    await setupUser().click(clear[0]);
    await waitFor(() => expect(window.location.search).toBe('?mine=true'));
  });

  it('sem nenhuma implantação: convite para a Nova implantação (ADMIN/OPERATOR)', async () => {
    vi.mocked(listDeployments).mockResolvedValue(page([]));
    openAt('/history');
    expect(await screen.findByText('Nenhuma implantação ainda.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Nova implantação' })).toHaveAttribute('href', '/deployments/new');
    expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeDisabled();
  });

  it('em "Minhas" sem nenhuma: "Nenhuma implantação sua ainda."', async () => {
    vi.mocked(listDeployments).mockResolvedValue(page([]));
    openAt('/history?mine=true');
    expect(await screen.findByText('Nenhuma implantação sua ainda.')).toBeInTheDocument();
  });

  it('erro da API aparece com a mensagem do servidor', async () => {
    vi.mocked(listDeployments).mockRejectedValue(new ApiError(400, 'Filtro inválido.', 'status'));
    openAt('/history?status=XYZ');
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar o histórico: Filtro inválido.');
  });

  it('"Exportar CSV" baixa com os MESMOS filtros da lista e o nome dado pelo servidor', async () => {
    vi.mocked(exportDeploymentsCsv).mockResolvedValue({ blob: new Blob(['a;b']), fileName: 'rsd-historico-2026-11-25.csv' });
    const createObjectURL = vi.fn(() => 'blob:csv');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('rsd-historico-2026-11-25.csv');
    });
    openAt('/history?status=FAILED&mine=true');
    await screen.findAllByTestId('deployment-title');
    await setupUser().click(screen.getByRole('button', { name: 'Exportar CSV' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(exportDeploymentsCsv).toHaveBeenCalledWith(lastFilters());
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('exportação recusada (mais de 10.000 linhas): mensagem de erro que fica na tela', async () => {
    vi.mocked(exportDeploymentsCsv).mockRejectedValue(new ApiError(400, 'Muitos resultados para exportar; refine os filtros.'));
    openAt('/history');
    await screen.findAllByTestId('deployment-title');
    await setupUser().click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Muitos resultados para exportar; refine os filtros.');
  });
});
