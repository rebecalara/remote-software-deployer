import type { InventoryProductGroup, InventorySummary } from '../../types/inventory';

/**
 * O que a desinstalação remove: um MSI escolhido pelo inventário das máquinas
 * (pode estar fora do catálogo; vai pelo ProductCode) ou um MSI do catálogo que nenhum
 * inventário encontrou (vai pelo software do catálogo). Só MSI — nunca "Outro".
 */
export interface UninstallTarget {
  key: string;
  source: 'inventory' | 'catalog';
  productCode: string;
  name: string;
  version: string | null;
  publisher: string | null;
  inCatalog: boolean;
  /** null = fora do catálogo. */
  catalogActive: boolean | null;
  /** Só source = catalog. */
  softwareId: string | null;
  /** Só source = inventory: quantas das máquinas selecionadas têm o produto. */
  machinesWith: number | null;
}

export function fromInventory(g: InventoryProductGroup): UninstallTarget {
  return {
    key: `inv:${g.productCode}`,
    source: 'inventory',
    productCode: g.productCode!,
    name: g.name,
    version: g.version,
    publisher: g.publisher,
    inCatalog: g.catalog !== null,
    catalogActive: g.catalog ? g.catalog.active : null,
    softwareId: null,
    machinesWith: g.machineIds.length,
  };
}

export function fromCatalog(c: InventorySummary['catalogNotFound'][number]): UninstallTarget {
  return {
    key: `cat:${c.softwareId}`,
    source: 'catalog',
    productCode: c.productCode,
    name: c.name,
    version: c.version,
    publisher: null,
    inCatalog: true,
    catalogActive: c.active,
    softwareId: c.softwareId,
    machinesWith: null,
  };
}

/** Máquinas que precisam de consulta: sem inventário ou com inventário antigo (e no AD). */
export function machinesToConsult(summary: InventorySummary | null): InventorySummary['machines'] {
  return (summary?.machines ?? []).filter((m) => m.seenInLastSync && (m.inventoryAt === null || m.stale));
}
