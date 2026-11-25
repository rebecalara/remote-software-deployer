import { describe, expect, it } from 'vitest';
import type { InventoryProductGroup, InventorySummary } from '../../types/inventory';
import { fromInventory, machinesToConsult } from './uninstallTarget';

const CODE = '{23170F69-40C1-2702-2606-000001000000}';

function group(overrides: Partial<InventoryProductGroup>): InventoryProductGroup {
  return {
    key: 'k',
    kind: 'MSI',
    productCode: CODE,
    name: '7-Zip 26.06 (x64 edition)',
    version: '26.06.00.0',
    publisher: 'Igor Pavlov',
    machineIds: ['m1', 'm2'],
    catalog: null,
    uninstall: { available: true, method: 'MSI', reason: null, programId: null, command: null },
    ...overrides,
  };
}

describe('fromInventory — o que a desinstalação vai remover', () => {
  it('MSI vai pelo ProductCode; o comando do registro nunca é usado', () => {
    const t = fromInventory(group({ uninstall: { available: true, method: 'MSI', reason: null, programId: 'p', command: 'x.exe /S' } }));
    expect(t).toMatchObject({ key: `inv:${CODE}`, method: 'MSI', productCode: CODE, programId: null, command: null, machinesWith: 2 });
  });

  it('programa que não é MSI vai pelo id do servidor (o comando é só para exibir)', () => {
    const t = fromInventory(
      group({
        kind: 'OTHER',
        productCode: null,
        uninstall: { available: true, method: 'VENDOR', reason: null, programId: 'abc123', command: '"C:\\Program Files\\7-Zip\\Uninstall.exe" /S' },
      }),
    );
    expect(t).toMatchObject({ key: 'prog:abc123', method: 'VENDOR', productCode: null, programId: 'abc123' });
    expect(t.command).toContain('Uninstall.exe');
  });

  it('marca se está no catálogo e se o cadastro está ativo', () => {
    expect(fromInventory(group({})).inCatalog).toBe(false);
    expect(fromInventory(group({})).catalogActive).toBeNull();
    const inCatalog = fromInventory(
      group({ catalog: { softwareId: 's1', name: '7-Zip', version: '26.06', active: false, uninstallAvailable: true } }),
    );
    expect(inCatalog).toMatchObject({ inCatalog: true, catalogActive: false });
  });
});

describe('machinesToConsult — quais máquinas pedem "Consultar agora"', () => {
  it('sem inventário ou com inventário antigo, e só as que estão no AD', () => {
    const summary: InventorySummary = {
      staleAfterDays: 7,
      products: [],
      machines: [
        { id: 'a', hostname: 'A', seenInLastSync: true, inventoryAt: null, stale: false },
        { id: 'b', hostname: 'B', seenInLastSync: true, inventoryAt: '2026-11-01T00:00:00Z', stale: true },
        { id: 'c', hostname: 'C', seenInLastSync: true, inventoryAt: '2026-11-24T00:00:00Z', stale: false },
        { id: 'd', hostname: 'D', seenInLastSync: false, inventoryAt: null, stale: false },
      ],
    };
    expect(machinesToConsult(summary).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('sem resumo ainda, nenhuma', () => {
    expect(machinesToConsult(null)).toEqual([]);
  });
});
