import type { InventoryProductGroup, InventorySummary } from '../../types/inventory';

/**
 * O que a desinstalação remove: um MSI escolhido pelo inventário das máquinas (pode estar
 * fora do catálogo; vai pelo ProductCode). Só o que o inventário encontrou.
 */
export interface UninstallTarget {
  key: string;
  productCode: string;
  name: string;
  version: string | null;
  publisher: string | null;
  inCatalog: boolean;
  /** null = fora do catálogo. */
  catalogActive: boolean | null;
  /** Quantas das máquinas selecionadas têm o produto, segundo o inventário. */
  machinesWith: number;
}

export function fromInventory(g: InventoryProductGroup): UninstallTarget {
  return {
    key: `inv:${g.productCode}`,
    productCode: g.productCode!,
    name: g.name,
    version: g.version,
    publisher: g.publisher,
    inCatalog: g.catalog !== null,
    catalogActive: g.catalog ? g.catalog.active : null,
    machinesWith: g.machineIds.length,
  };
}

/** Máquinas que precisam de consulta: sem inventário ou com inventário antigo (e no AD). */
export function machinesToConsult(summary: InventorySummary | null): InventorySummary['machines'] {
  return (summary?.machines ?? []).filter((m) => m.seenInLastSync && (m.inventoryAt === null || m.stale));
}
