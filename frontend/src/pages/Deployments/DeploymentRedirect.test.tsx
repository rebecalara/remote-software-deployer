import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/apiClient';
import { getDeployment } from '../../services/deploymentService';
import type { Deployment } from '../../types/deployment';
import { DeploymentRedirect } from './DeploymentRedirect';

vi.mock('../../services/deploymentService', () => ({ getDeployment: vi.fn() }));

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{pathname + search}</p>;
}

function openLink(id = 'd1') {
  render(
    <MemoryRouter initialEntries={[`/deployments/${id}`]}>
      <Routes>
        <Route path="/deployments/:id" element={<DeploymentRedirect />} />
        <Route path="/monitoring" element={<Where />} />
        <Route path="/history" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}
const finishedAgo = (ms: number) => ({ id: 'd1', finishedAt: new Date(Date.now() - ms).toISOString() }) as Deployment;
const HOUR = 3600 * 1000;

describe('DeploymentRedirect — links antigos e do Dashboard (/deployments/:id)', () => {
  it('em andamento → Monitoramento, já aberta', async () => {
    vi.mocked(getDeployment).mockResolvedValue({ id: 'd1', finishedAt: null } as Deployment);
    openLink();
    expect(await screen.findByTestId('where')).toHaveTextContent('/monitoring?open=d1');
  });

  it('encerrada há menos de 24 h → Monitoramento (seção das encerradas)', async () => {
    vi.mocked(getDeployment).mockResolvedValue(finishedAgo(23 * HOUR));
    openLink();
    expect(await screen.findByTestId('where')).toHaveTextContent('/monitoring?open=d1');
  });

  it('encerrada há mais de 24 h → Histórico (o Monitoramento já não a mostra)', async () => {
    vi.mocked(getDeployment).mockResolvedValue(finishedAgo(2 * 24 * HOUR));
    openLink();
    expect(await screen.findByTestId('where')).toHaveTextContent('/history?open=d1');
  });

  it('inexistente (404) → "Implantação não encontrada." com os dois caminhos', async () => {
    vi.mocked(getDeployment).mockRejectedValue(new ApiError(404, 'Implantação não encontrada.'));
    openLink('nao-existe');
    expect(await screen.findByText('Implantação não encontrada.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Monitoramento' })).toHaveAttribute('href', '/monitoring');
    expect(screen.getByRole('link', { name: 'Histórico' })).toHaveAttribute('href', '/history');
  });

  it('outro erro mostra a mensagem', async () => {
    vi.mocked(getDeployment).mockRejectedValue(new ApiError(503, 'Não foi possível conectar ao servidor.'));
    openLink();
    expect(await screen.findByText('Não foi possível abrir a implantação.')).toBeInTheDocument();
    expect(screen.getByText('Não foi possível conectar ao servidor.')).toBeInTheDocument();
  });
});
