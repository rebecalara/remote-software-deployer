import { render, screen, waitFor } from '@testing-library/react';
import { setupUser } from './user';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Sha256 } from '../components/Sha256';
import { SidePanel } from '../components/SidePanel';
import { DeploymentTable } from '../pages/Deployments/DeploymentTable';
import { ReviewStep } from '../pages/Deployments/ReviewStep';
import { UninstallChoices } from '../pages/Deployments/UninstallChoices';
import { StatusBadge } from '../pages/Deployments/deploymentUi';
import { fromInventory } from '../pages/Deployments/uninstallTarget';
import { MachineDetailsPanel } from '../pages/Machines/MachineDetailsPanel';
import { SoftwareFormPanel } from '../pages/Software/SoftwareFormPanel';
import { getInventory } from '../services/inventoryService';
import type { DeploymentSummary } from '../types/deployment';
import type { InventoryProductGroup } from '../types/inventory';
import type { Machine } from '../types/machine';
import type { Software } from '../types/software';

// Nenhum elemento interativo dentro de outro: um <button> dentro de outro <button> (ou de um
// link, label, summary, role=button) é HTML inválido, e o leitor de tela e o teclado se
// perdem. E nenhum gatilho de dica dentro de um elemento com onClick (linha clicável): o
// clique e o Enter do gatilho acionariam a linha. Exceção: fundo de diálogo com
// role="presentation" (atalho de mouse que só reage ao clique nele mesmo).

vi.mock('../services/inventoryService', () => ({ getInventory: vi.fn(), collectInventory: vi.fn() }));
vi.mock('../pages/Deployments/DeploymentPanel', () => ({ DeploymentPanel: () => null }));

const INTERACTIVE = 'button, a[href], label, summary, [role=button], input, select, textarea';
const CONTAINER = 'button, a[href], label, summary, [role=button]';

/** O React guarda as props no elemento do DOM: assim dá para ver um onClick num <tr> ou <div>. */
function hasReactClick(el: Element): boolean {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  return Boolean(key && typeof (el as unknown as Record<string, { onClick?: unknown }>)[key].onClick === 'function');
}

const describeEl = (el: Element) => `<${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? ` data-testid="${el.getAttribute('data-testid')}"` : ''}> "${el.textContent?.trim().slice(0, 30)}"`;

function nestingProblems(root: ParentNode = document.body): string[] {
  const problems: string[] = [];
  for (const el of root.querySelectorAll(INTERACTIVE)) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p.matches(CONTAINER)) problems.push(`${describeEl(el)} dentro de ${describeEl(p)}`);
    }
  }
  for (const el of root.querySelectorAll('[data-tooltip-target]')) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (hasReactClick(p) && p.getAttribute('role') !== 'presentation') problems.push(`gatilho ${describeEl(el)} dentro de ${describeEl(p)} com onClick`);
    }
  }
  return problems;
}

const MSI_CODE = '{23170F69-40C1-2702-2606-000001000000}';
const machine = (overrides: Partial<Machine> = {}): Machine => ({
  id: 'm1',
  hostname: 'RSD-ALVO-01',
  ipAddress: null,
  operatingSystem: 'Windows 11',
  department: 'TI',
  status: 'ONLINE',
  statusCheckedAt: '2026-11-25T10:00:00.000Z',
  lastSync: '2026-11-25T09:00:00.000Z',
  seenInLastSync: true,
  ...overrides,
});
const software: Software = {
  id: 's1',
  name: '7-Zip',
  version: '26.06',
  vendor: 'Igor Pavlov',
  installType: 'MSI',
  installArgs: [],
  active: false,
  installer: { originalName: '7z2606-x64.msi', sizeBytes: 1_900_000, sha256: 'A'.repeat(64), uploadedAt: '2026-11-20T10:00:00.000Z' },
  deploymentCount: 3,
  msiProductCode: MSI_CODE,
  uninstallAvailable: true,
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:00:00.000Z',
  createdBy: null,
  updatedBy: null,
};
const msiGroup: InventoryProductGroup = {
  key: 'k1',
  kind: 'MSI',
  productCode: MSI_CODE,
  name: '7-Zip 26.06 (x64 edition)',
  version: '26.06.00.0',
  publisher: 'Igor Pavlov',
  machineIds: ['m1'],
  catalog: { softwareId: 's1', name: '7-Zip', version: '26.06', active: false, uninstallAvailable: true },
  uninstall: { available: true, method: 'MSI', reason: null, programId: null, command: null },
};
const blockedGroup: InventoryProductGroup = {
  ...msiGroup,
  key: 'k2',
  kind: 'OTHER',
  productCode: null,
  name: 'Microsoft Edge',
  catalog: null,
  uninstall: { available: false, method: null, reason: 'Não declarou desinstalação silenciosa.', programId: null, command: null },
};
const deployment = (overrides: Partial<DeploymentSummary>): DeploymentSummary => ({
  id: 'd1',
  name: 'x',
  action: 'INSTALL',
  status: 'PARTIAL',
  createdAt: '2026-11-24T23:20:00.000Z',
  startedAt: '2026-11-24T23:20:01.000Z',
  finishedAt: '2026-11-24T23:20:23.000Z',
  software: { id: 's1', name: '7-Zip', version: '26.06', installType: 'MSI' },
  product: null,
  vendorCommand: null,
  requestedBy: { username: 'testuser', displayName: 'Test User' },
  counts: { total: 3, pending: 0, running: 0, succeeded: 1, failed: 2, cancelled: 0 },
  ...overrides,
});

describe('nenhum elemento interativo dentro de outro (componentes com dica)', () => {
  it('a própria verificação acusa botão dentro de botão (prova do teste)', () => {
    // Pela API do DOM: o parser de HTML (innerHTML) fecharia o primeiro botão antes do segundo.
    const div = document.createElement('div');
    const outer = div.appendChild(document.createElement('button'));
    outer.appendChild(document.createElement('span')).appendChild(document.createElement('button'));
    expect(nestingProblems(div)).toHaveLength(1);
  });

  it('painel da máquina: selos, "confirmada no AD" e inventário (nome, "No catálogo", "Atualizado")', async () => {
    vi.mocked(getInventory).mockResolvedValue({
      collectAvailable: true,
      collectUnavailableReason: null,
      inventory: {
        machineId: 'm1',
        collectedAt: '2026-11-24T10:00:00.000Z',
        collectedBy: { username: 'testuser', displayName: 'Test User' },
        items: [
          {
            name: '7-Zip 26.06 (x64 edition)',
            version: '26.06.00.0',
            publisher: 'Igor Pavlov',
            installDate: '2026-11-24',
            productCode: MSI_CODE,
            arch: '64',
            catalog: msiGroup.catalog,
            uninstall: msiGroup.uninstall,
          },
        ],
      },
    });
    render(
      <MemoryRouter>
        <MachineDetailsPanel machine={machine({ seenInLastSync: false })} now={Date.now()} onClose={() => {}} canCollect />
      </MemoryRouter>,
    );
    await screen.findByTestId('catalog-badge');
    expect(document.querySelectorAll('[data-tooltip-target]').length).toBeGreaterThanOrEqual(6);
    expect(nestingProblems()).toEqual([]);
  });

  it('painel do catálogo (software já implantado): SHA-256 e "Sim (MSI)"', () => {
    render(<SoftwareFormPanel software={software} limits={null} canWrite={false} onClose={() => {}} onSaved={() => {}} onChanged={() => {}} />);
    expect(screen.getByTestId('sha256')).toHaveAttribute('data-tooltip-target');
    expect(screen.getByTestId('product-code')).toHaveAttribute('data-tooltip-target');
    expect(nestingProblems()).toEqual([]);
  });

  it('Nova Implantação: programas bloqueados e Revisar ("1 de 2", "Desativado")', async () => {
    const { unmount } = render(
      <UninstallChoices
        summary={{ staleAfterDays: 7, machines: [], products: [msiGroup, blockedGroup] }}
        search=""
        loadError={null}
        onRetry={() => {}}
        consult={{ running: false, done: 0, total: 0, failures: [] }}
        onConsultNow={() => {}}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    await setupUser().click(screen.getByRole('button', { name: /não pode ser desinstalado/ }));
    expect(screen.getByTestId('blocked-item')).toHaveAttribute('data-tooltip-target');
    expect(nestingProblems()).toEqual([]);
    unmount();

    render(
      <ReviewStep
        machines={[machine(), machine({ id: 'm2', hostname: 'WS-TI-015' })]}
        software={null}
        action="UNINSTALL"
        uninstallTarget={fromInventory(msiGroup)}
        requireConfirm={false}
        confirmed={false}
        onConfirm={() => {}}
        error={null}
      />,
    );
    expect(screen.getByTestId('coverage')).toHaveTextContent('1 de 2');
    expect(screen.getByText('Desativado')).toHaveAttribute('data-tooltip-target');
    expect(nestingProblems()).toEqual([]);
  });

  it('tabela de implantações (linha clicável): título e Parcial sem gatilho dentro da linha', () => {
    render(
      <DeploymentTable
        items={[
          deployment({}),
          deployment({ id: 'd2', action: 'UNINSTALL', software: null, product: { productCode: '{X}', name: 'PuTTY', version: '0.85', publisher: null } }),
        ]}
        openIds={new Set()}
        onToggle={() => {}}
        now={Date.now()}
        ariaLabel="Implantações"
      />,
    );
    expect(document.querySelectorAll('tbody [data-tooltip-target]')).toHaveLength(0);
    expect(nestingProblems()).toEqual([]);
  });

  it('selo Parcial fora de linha clicável (Dashboard) e SHA-256 avulso', () => {
    render(
      <>
        <StatusBadge status="PARTIAL" counts={{ succeeded: 1, total: 3 }} />
        <Sha256 value={'B'.repeat(64)} />
      </>,
    );
    expect(screen.getByText('Parcial').closest('[data-tooltip-target]')).not.toBeNull();
    expect(nestingProblems()).toEqual([]);
  });

  it('diálogo de confirmação sobre o painel lateral: o fundo é role="presentation"', () => {
    render(
      <>
        <SidePanel title="Painel" onClose={() => {}}>
          conteúdo
        </SidePanel>
        <ConfirmDialog title="Descartar alterações?" confirmLabel="Descartar" onCancel={() => {}} onConfirm={() => {}}>
          texto
        </ConfirmDialog>
      </>,
    );
    expect(nestingProblems()).toEqual([]);
    return waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
  });
});
