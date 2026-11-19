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

/** GET /machines/:id/inventory */
export interface InventoryState {
  inventory: MachineInventory | null;
  collectAvailable: boolean;
  collectUnavailableReason: string | null;
}
