// RF08 — espelha backend/src/inventory/inventory.service.ts (views). Manter em sincronia.

export interface InventoryCatalogMatch {
  softwareId: string;
  name: string;
  version: string;
  active: boolean;
  uninstallAvailable: boolean;
}

export interface InventoryItem {
  name: string;
  version: string | null;
  publisher: string | null;
  /** aaaa-mm-dd, quando o instalador registrou. */
  installDate: string | null;
  /** Só MSI. */
  productCode: string | null;
  arch: '64' | '32';
  /** Software do catálogo com o mesmo ProductCode (só MSI). */
  catalog: InventoryCatalogMatch | null;
}

export interface MachineInventory {
  machineId: string;
  collectedAt: string;
  collectedBy: { username: string; displayName: string | null };
  items: InventoryItem[];
}

/** Um item (ou grupo de itens iguais) do software instalado nas máquinas selecionadas. */
export interface InventoryProductGroup {
  key: string;
  /** MSI = pode ser desinstalado pelo ProductCode; OTHER = não. */
  kind: 'MSI' | 'OTHER';
  productCode: string | null;
  name: string;
  version: string | null;
  publisher: string | null;
  /** Máquinas selecionadas que têm o item. */
  machineIds: string[];
  catalog: InventoryCatalogMatch | null;
}

/** POST /machines/inventory-summary */
export interface InventorySummary {
  staleAfterDays: number;
  machines: Array<{ id: string; hostname: string; seenInLastSync: boolean; inventoryAt: string | null; stale: boolean }>;
  products: InventoryProductGroup[];
  /** MSI do catálogo que nenhum inventário das máquinas selecionadas encontrou. */
  catalogNotFound: Array<{ softwareId: string; name: string; version: string; active: boolean; productCode: string }>;
}

/** GET /machines/:id/inventory */
export interface InventoryState {
  inventory: MachineInventory | null;
  collectAvailable: boolean;
  collectUnavailableReason: string | null;
}
