import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { InventoryProductGroup } from '../../types/inventory';
import type { Machine } from '../../types/machine';
import type { Software } from '../../types/software';
import { ReviewStep } from './ReviewStep';
import { fromInventory } from './uninstallTarget';

// Aviso de reinício no Revisar: "nunca são reiniciadas" só vale para MSI (REBOOT=ReallySuppress
// por último). Um EXE só recebe os argumentos do catálogo e pode reiniciar a máquina sozinho.

const MSI_TEXT = 'Executa como administrador. As máquinas nunca são reiniciadas. Máquinas desligadas ficam registradas como falha.';
const EXE_TEXT =
  'Executa como administrador. O sistema não reinicia as máquinas, mas um instalador EXE pode reiniciar sozinho. Máquinas desligadas ficam registradas como falha.';
const EXE_INFO =
  'Para evitar, inclua nos argumentos do catálogo a opção do fabricante para não reiniciar. Se o instalador pedir reinício, a máquina fica com o aviso "reinício pendente"; se ele mesmo reiniciar (código 1641), isso fica registrado no resultado.';

const machines: Machine[] = [
  {
    id: 'm1',
    hostname: 'RSD-ALVO-01',
    ipAddress: null,
    operatingSystem: 'Windows 11',
    department: 'TI',
    status: 'ONLINE',
    statusCheckedAt: '2026-11-25T10:00:00.000Z',
    lastSync: '2026-11-25T09:00:00.000Z',
    seenInLastSync: true,
  },
];
const software = (installType: 'MSI' | 'EXE'): Software => ({
  id: 's1',
  name: '7-Zip',
  version: '26.06',
  vendor: 'Igor Pavlov',
  installType,
  installArgs: installType === 'EXE' ? ['/S'] : [],
  active: true,
  installer: { originalName: `7z.${installType.toLowerCase()}`, sizeBytes: 1_900_000, sha256: 'A'.repeat(64), uploadedAt: '2026-11-20T10:00:00.000Z' },
  deploymentCount: 0,
  msiProductCode: installType === 'MSI' ? '{23170F69-40C1-2702-2606-000001000000}' : null,
  uninstallAvailable: installType === 'MSI',
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:00:00.000Z',
  createdBy: null,
  updatedBy: null,
});
const group = (overrides: Partial<InventoryProductGroup>): InventoryProductGroup => ({
  key: 'k',
  kind: 'MSI',
  productCode: '{23170F69-40C1-2702-2606-000001000000}',
  name: '7-Zip 26.06 (x64 edition)',
  version: '26.06.00.0',
  publisher: 'Igor Pavlov',
  machineIds: ['m1'],
  catalog: null,
  uninstall: { available: true, method: 'MSI', reason: null, programId: null, command: null },
  ...overrides,
});

function renderReview(props: Partial<Parameters<typeof ReviewStep>[0]>) {
  render(
    <ReviewStep
      machines={machines}
      software={null}
      action="INSTALL"
      uninstallTarget={null}
      requireConfirm={false}
      confirmed={false}
      onConfirm={() => {}}
      error={null}
      {...props}
    />,
  );
  const notice = screen.getByTestId('review-notice');
  const info = within(notice).getByRole('button', { name: 'Mais sobre este aviso' });
  return { notice, info };
}

describe('ReviewStep — aviso de reinício', () => {
  it('instalar MSI: "As máquinas nunca são reiniciadas."', () => {
    const { notice } = renderReview({ software: software('MSI') });
    expect(notice).toHaveTextContent(MSI_TEXT);
  });

  it('instalar EXE: o sistema não reinicia, mas o instalador pode; sem a promessa "nunca"', () => {
    const { notice, info } = renderReview({ software: software('EXE') });
    expect(notice).toHaveTextContent(EXE_TEXT);
    expect(notice).not.toHaveTextContent('nunca são reiniciadas');
    expect(info).toHaveAccessibleDescription(EXE_INFO);
  });

  it('desinstalar MSI (msiexec /x com REBOOT=ReallySuppress): a frase do MSI', () => {
    const { notice } = renderReview({ action: 'UNINSTALL', uninstallTarget: fromInventory(group({})) });
    expect(notice).toHaveTextContent(MSI_TEXT);
  });

  it('desinstalar pelo comando do fabricante: pode reiniciar a máquina', () => {
    const vendor = group({
      kind: 'OTHER',
      productCode: null,
      uninstall: { available: true, method: 'VENDOR', reason: null, programId: 'p1', command: '"C:\\Program Files\\7-Zip\\Uninstall.exe" /S' },
    });
    const { notice } = renderReview({ action: 'UNINSTALL', uninstallTarget: fromInventory(vendor), requireConfirm: true });
    expect(notice).toHaveTextContent('O comando do fabricante pode reiniciar a máquina.');
    expect(notice).not.toHaveTextContent('nunca são reiniciadas');
  });
});
