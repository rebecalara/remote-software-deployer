import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DeploymentSummary } from '../../types/deployment';
import { DeploymentTable, toggleInSet } from './DeploymentTable';
import { durationText, formatDuration, partialHint } from './deploymentUi';

// O painel que abre na linha consulta a API; aqui só a tabela importa.
vi.mock('./DeploymentPanel', () => ({ DeploymentPanel: ({ deploymentId }: { deploymentId: string }) => <p>painel de {deploymentId}</p> }));

const counts = { total: 3, pending: 0, running: 0, succeeded: 1, failed: 2, cancelled: 0 };
function deployment(overrides: Partial<DeploymentSummary>): DeploymentSummary {
  return {
    id: 'd1',
    name: '7-Zip 26.06 — 3 máquinas',
    action: 'INSTALL',
    status: 'SUCCEEDED',
    createdAt: '2026-11-24T23:20:00.000Z',
    startedAt: '2026-11-24T23:20:01.000Z',
    finishedAt: '2026-11-24T23:20:23.000Z',
    software: { id: 's1', name: '7-Zip', version: '26.06', installType: 'MSI' },
    product: null,
    vendorCommand: null,
    requestedBy: { username: 'testuser', displayName: 'Test User' },
    counts,
    ...overrides,
  };
}

function renderTable(items: DeploymentSummary[], props: Partial<Parameters<typeof DeploymentTable>[0]> = {}) {
  const onToggle = vi.fn();
  render(<DeploymentTable items={items} openIds={new Set()} onToggle={onToggle} now={Date.now()} ariaLabel="Implantações" {...props} />);
  return { onToggle, table: screen.getByRole('table', { name: 'Implantações' }) };
}

describe('DeploymentTable — mesma tabela no Monitoramento, no Histórico e no Dashboard', () => {
  it('título curto (nome + versão), só a quantidade de máquinas e a duração legível', () => {
    renderTable([deployment({})]);
    expect(screen.getByTestId('deployment-title')).toHaveTextContent('7-Zip 26.06');
    const row = screen.getByTestId('deployment-title').closest('tr')!;
    expect(within(row).getByText('3')).toBeInTheDocument();
    expect(within(row).getByText('22 s')).toBeInTheDocument();
  });

  it('instalação comum do catálogo não ganha selo; desinstalação e produto fora do catálogo ganham', () => {
    renderTable([
      deployment({ id: 'a' }),
      deployment({
        id: 'b',
        action: 'UNINSTALL',
        software: null,
        product: { productCode: '{X}', name: 'PuTTY release 0.85', version: '0.85', publisher: null },
      }),
    ]);
    expect(screen.queryByText('Instalação')).not.toBeInTheDocument();
    expect(screen.getByText('Desinstalação')).toBeInTheDocument();
    expect(screen.getByText('Fora do catálogo')).toBeInTheDocument();
  });

  it('desinstalação pelo comando do fabricante mostra esse selo no lugar de "Fora do catálogo"', () => {
    renderTable([deployment({ action: 'UNINSTALL', software: null, vendorCommand: '"C:\\Program Files\\7-Zip\\Uninstall.exe" /S' })]);
    expect(screen.getByText('Comando do fabricante')).toBeInTheDocument();
    expect(screen.queryByText('Fora do catálogo')).not.toBeInTheDocument();
  });

  it('Parcial com a dica "N de M máquinas concluídas"', () => {
    renderTable([deployment({ status: 'PARTIAL' })]);
    const badge = screen.getByText('Parcial');
    expect(badge.closest('[data-status]')).toHaveAccessibleDescription('1 de 3 máquinas concluídas; veja as falhas');
  });

  it('"Solicitada por" aparece em "Todas" e sai em "Minhas"', () => {
    const { table } = renderTable([deployment({})]);
    expect(within(table).getByText('Solicitada por')).toBeInTheDocument();
    expect(within(table).getByText('Test User')).toBeInTheDocument();
  });

  it('em "Minhas implantações", sem a coluna de quem pediu', () => {
    renderTable([deployment({})], { hideRequester: true });
    expect(screen.queryByText('Solicitada por')).not.toBeInTheDocument();
    expect(screen.queryByText('Test User')).not.toBeInTheDocument();
  });

  it('clicar na linha ou no botão abre a implantação ali mesmo', async () => {
    const { onToggle } = renderTable([deployment({})]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Expandir 7-Zip 26.06' }));
    expect(onToggle).toHaveBeenCalledWith('d1');
  });

  it('linha aberta mostra o painel da implantação', () => {
    renderTable([deployment({})], { openIds: new Set(['d1']) });
    expect(screen.getByRole('button', { name: 'Recolher 7-Zip 26.06' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('painel de d1')).toBeInTheDocument();
  });
});

describe('peças da tabela', () => {
  it.each([
    [4_000, '4 s'],
    [65_000, '1 min 5 s'],
    [60_000, '1 min'],
    [3_720_000, '1 h 2 min'],
    [3_600_000, '1 h'],
  ])('duração %i ms → "%s" (zeros à direita omitidos)', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it('em andamento conta até agora; sem início, travessão', () => {
    const now = new Date('2026-11-25T12:00:30.000Z').getTime();
    expect(durationText('2026-11-25T12:00:00.000Z', null, now, true)).toBe('30 s');
    expect(durationText(null, null, now, true)).toBe('—');
  });

  it('dica do Parcial no singular', () => {
    expect(partialHint({ succeeded: 1, total: 1 })).toBe('1 de 1 máquina concluída; veja as falhas');
  });

  it('abrir e fechar linhas', () => {
    expect([...toggleInSet(new Set(['a']), 'b')]).toEqual(['a', 'b']);
    expect([...toggleInSet(new Set(['a', 'b']), 'a')]).toEqual(['b']);
  });
});
