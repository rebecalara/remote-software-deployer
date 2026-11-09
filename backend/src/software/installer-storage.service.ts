import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InstallType } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// ÚNICO ponto de acesso a disco para instaladores (DECISIONS.md: "Instalador guardado
// em disco gerenciado pelo sistema"). O resto do código só conhece o nome gerado.
// Trocar o destino (ex.: pasta de rede) deve mexer só neste arquivo.

export const DEFAULT_MAX_SIZE_MB = 500;
// installerSizeBytes é Int no banco (máx. 2047 MB); o teto deixa folga.
export const MAX_SIZE_CEILING_MB = 2000;

const TMP_DIR = '.tmp';
const PART_SUFFIX = '.part';
const STORED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(msi|exe)$/;
const RENAME_ATTEMPTS = 3;
const RENAME_RETRY_MS = 200;

// Checagem de bom senso, não de segurança (ver DECISIONS.md): pega arquivo errado
// ou extensão trocada antes de gravar centenas de MB.
const SIGNATURES: Record<InstallType, Buffer> = {
  MSI: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), // OLE Compound File
  EXE: Buffer.from([0x4d, 0x5a]), // "MZ"
};
const EXTENSIONS: Record<InstallType, 'msi' | 'exe'> = { MSI: 'msi', EXE: 'exe' };

export interface StoredInstaller {
  fileName: string;
  sizeBytes: number;
  /** SHA-256 em hexadecimal maiúsculo — mesmo formato do Get-FileHash. */
  sha256: string;
}

export class InstallerStorageUnavailableError extends Error {
  constructor() {
    super('Armazenamento de instaladores não configurado.');
    this.name = 'InstallerStorageUnavailableError';
  }
}

export class InstallerTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`O instalador excede o tamanho máximo de ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    this.name = 'InstallerTooLargeError';
  }
}

export class InvalidInstallerHeaderError extends Error {
  constructor(readonly expected: InstallType) {
    super(
      expected === 'MSI'
        ? 'O arquivo não é um instalador MSI válido.'
        : 'O arquivo não é um executável (.exe) válido.',
    );
    this.name = 'InvalidInstallerHeaderError';
  }
}

export class InvalidStoredFileNameError extends Error {
  constructor() {
    super('Nome de arquivo de instalador inválido.');
    this.name = 'InvalidStoredFileNameError';
  }
}

@Injectable()
export class InstallerStorageService implements OnModuleInit {
  private readonly logger = new Logger(InstallerStorageService.name);
  private readonly dir: string | null;
  readonly maxSizeBytes: number;

  constructor() {
    this.dir = resolveStorageDir(process.env.INSTALLER_STORAGE_DIR, this.logger);
    this.maxSizeBytes = parseMaxSizeMb(process.env.INSTALLER_MAX_SIZE_MB, this.logger) * 1024 * 1024;
  }

  /** false = rotas de envio devolvem 503; o resto do catálogo funciona. */
  get isAvailable(): boolean {
    return this.dir !== null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.dir) return; // o motivo já foi logado uma vez em resolveStorageDir
    await fsp.mkdir(join(this.dir, TMP_DIR), { recursive: true });
    const removed = await this.cleanupPartials();
    if (removed > 0) {
      this.logger.warn(`${removed} envio(s) interrompido(s) encontrados na subida; arquivos parciais apagados.`);
    }
    this.logger.log(`Instaladores em ${this.dir} (limite ${this.maxSizeBytes / 1024 / 1024} MB).`);
  }

  /**
   * Grava o instalador em stream, sem carregá-lo na memória: confere o cabeçalho nos
   * primeiros bytes, calcula SHA-256 e tamanho no caminho e aborta assim que o limite
   * é passado. Grava num .part e só no fim faz o rename atômico para <uuid>.<ext>.
   * Em qualquer falha, o .part é apagado — nunca sobra arquivo órfão.
   */
  async save(source: Readable, installType: InstallType): Promise<StoredInstaller> {
    const dir = this.requireDir();
    const id = randomUUID();
    const partPath = join(dir, TMP_DIR, `${id}${PART_SUFFIX}`);
    const fileName = `${id}.${EXTENSIONS[installType]}`;
    const inspector = new InstallerInspector(SIGNATURES[installType], installType, this.maxSizeBytes);

    try {
      await fsp.mkdir(join(dir, TMP_DIR), { recursive: true });
      await pipeline(source, inspector, createWriteStream(partPath, { flags: 'wx' }));
      await renameWithRetry(partPath, join(dir, fileName));
    } catch (err) {
      await fsp.rm(partPath, { force: true });
      throw err;
    }

    return { fileName, sizeBytes: inspector.bytes, sha256: inspector.digest() };
  }

  /** Para o Bloco 4 copiar o arquivo até a máquina. Nenhuma rota HTTP usa isto. */
  openRead(fileName: string): ReadStream {
    return createReadStream(this.pathFor(fileName));
  }

  /** Idempotente: não falha se o arquivo já não existir. */
  async delete(fileName: string): Promise<void> {
    await fsp.rm(this.pathFor(fileName), { force: true });
  }

  /** Nomes dos instaladores guardados (para conferir contra o banco na subida). */
  async listFiles(): Promise<string[]> {
    const entries = await fsp.readdir(this.requireDir());
    return entries.filter((name) => STORED_NAME.test(name));
  }

  /** Na subida nada está em andamento: todo .part é resto de envio interrompido. */
  async cleanupPartials(): Promise<number> {
    const tmp = join(this.requireDir(), TMP_DIR);
    let entries: string[];
    try {
      entries = await fsp.readdir(tmp);
    } catch {
      return 0;
    }
    const parts = entries.filter((name) => name.endsWith(PART_SUFFIX));
    await Promise.all(parts.map((name) => fsp.rm(join(tmp, name), { force: true })));
    return parts.length;
  }

  private requireDir(): string {
    if (!this.dir) throw new InstallerStorageUnavailableError();
    return this.dir;
  }

  // Defesa extra: só nomes gerados pelo próprio sistema chegam ao disco — um nome
  // forjado (ex.: "../../x") nunca sai da pasta.
  private pathFor(fileName: string): string {
    if (!STORED_NAME.test(fileName)) throw new InvalidStoredFileNameError();
    return join(this.requireDir(), fileName);
  }
}

/** Confere cabeçalho, conta bytes, calcula o hash e corta no limite — tudo em trânsito. */
class InstallerInspector extends Transform {
  bytes = 0;
  private readonly hash = createHash('sha256');
  private head = Buffer.alloc(0);
  private headerChecked = false;

  constructor(
    private readonly signature: Buffer,
    private readonly installType: InstallType,
    private readonly maxBytes: number,
  ) {
    super();
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new InstallerTooLargeError(this.maxBytes));
      return;
    }
    if (!this.headerChecked) {
      this.head = Buffer.concat([this.head, chunk]);
      if (this.head.length >= this.signature.length) {
        if (!this.head.subarray(0, this.signature.length).equals(this.signature)) {
          callback(new InvalidInstallerHeaderError(this.installType));
          return;
        }
        this.headerChecked = true;
        this.head = Buffer.alloc(0);
      }
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }

  _flush(callback: TransformCallback): void {
    // Arquivo menor que a assinatura (inclusive vazio) nunca passou pela checagem.
    callback(this.headerChecked ? null : new InvalidInstallerHeaderError(this.installType));
  }

  digest(): string {
    return this.hash.digest('hex').toUpperCase();
  }
}

// O antivírus (Defender) ou o indexador do Windows podem segurar um .exe recém-gravado
// por instantes — por isso o rename tenta de novo antes de desistir.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retriable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!retriable || attempt >= RENAME_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, RENAME_RETRY_MS * attempt));
    }
  }
}

/**
 * Pasta obrigatória para o envio. Recusada (null) se ausente, dentro do repositório
 * ou dentro do OneDrive — ver DECISIONS.md, "Pasta de instaladores fora do OneDrive
 * e fora do repositório". O motivo é logado uma única vez, na construção do serviço.
 */
export function resolveStorageDir(raw: string | undefined, logger?: Logger): string | null {
  if (!raw?.trim()) {
    logger?.warn('INSTALLER_STORAGE_DIR não configurada: envio de instaladores desativado (503).');
    return null;
  }
  const dir = resolve(raw.trim());

  // backend/src/software (ou backend/dist/software) → raiz do repositório
  const repoRoot = resolve(__dirname, '..', '..', '..');
  if (isInside(dir, repoRoot)) {
    logger?.error(`INSTALLER_STORAGE_DIR (${dir}) está dentro do repositório: envio desativado.`);
    return null;
  }

  const oneDriveRoots = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]
    .filter((p): p is string => Boolean(p))
    .map((p) => resolve(p));
  if (oneDriveRoots.some((root) => isInside(dir, root)) || /[\\/]onedrive[^\\/]*([\\/]|$)/i.test(dir)) {
    logger?.error(`INSTALLER_STORAGE_DIR (${dir}) está numa pasta do OneDrive: envio desativado.`);
    return null;
  }
  return dir;
}

/** Limite em MB: padrão 500, mínimo 1, teto 2000. */
export function parseMaxSizeMb(raw: string | undefined, logger?: Logger): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_SIZE_MB;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    logger?.warn(`INSTALLER_MAX_SIZE_MB inválido ("${raw}"); usando ${DEFAULT_MAX_SIZE_MB}.`);
    return DEFAULT_MAX_SIZE_MB;
  }
  if (value > MAX_SIZE_CEILING_MB) {
    logger?.warn(`INSTALLER_MAX_SIZE_MB=${value} acima do teto; usando ${MAX_SIZE_CEILING_MB}.`);
    return MAX_SIZE_CEILING_MB;
  }
  return value;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}
