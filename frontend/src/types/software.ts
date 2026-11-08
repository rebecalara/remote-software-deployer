// Espelha backend/src/software/software.service.ts (SoftwareView) e
// software-validation.ts (entradas) — manter em sincronia.

export type InstallType = 'MSI' | 'EXE';

export interface UserRef {
  username: string;
  displayName: string;
}

export interface InstallerInfo {
  originalName: string | null;
  sizeBytes: number | null;
  /** SHA-256 em hexadecimal maiúsculo, calculado pelo servidor no envio. */
  sha256: string | null;
  uploadedAt: string | null;
}

export interface Software {
  id: string;
  name: string;
  version: string;
  vendor: string | null;
  installType: InstallType;
  /** Argumentos como lista de tokens — nunca uma linha de comando. */
  installArgs: string[];
  active: boolean;
  /** null = ainda sem instalador enviado. */
  installer: InstallerInfo | null;
  /** Contagem real de implantações (0 até o Bloco 4). */
  deploymentCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

export interface SoftwareCreateInput {
  name: string;
  version: string;
  vendor?: string | null;
  installType: InstallType;
  installArgs?: string[];
}

export type SoftwareUpdateInput = Partial<SoftwareCreateInput>;
