import { Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { toAsciiJson } from '../deployments/powershell-executor';

// Lê o ProductCode de um MSI guardado pelo sistema, NO PRÓPRIO SERVIDOR (DECISIONS.md,
// desinstalação remota): roda o script fixo backend/scripts/read-msi-info.ps1 com o
// mesmo powershell.exe do executor. O pacote é aberto só para leitura; nada é executado.
// É isso que permite desinstalar sem copiar o instalador para a máquina de destino.
//
// Só funciona com o backend em Windows — coerente com a implantação, que também só
// roda em Windows. Fora dele, o leitor fica indisponível e o MSI só não ganha
// desinstalação.

export const READ_MSI_SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'read-msi-info.ps1');
export const READ_MSI_TIMEOUT_MS = 30_000;

/** ProductCode do Windows Installer: GUID entre chaves. Guardado em maiúsculas. */
export const PRODUCT_CODE_PATTERN = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/;

export interface MsiInfo {
  productCode: string;
  productName: string | null;
  productVersion: string | null;
  manufacturer: string | null;
}

export type MsiInfoResult = { ok: true; info: MsiInfo } | { ok: false; message: string };

export interface MsiInfoReaderConfig {
  command: string;
  args: string[];
  timeoutMs: number;
  /** Preenchido quando a leitura não pode rodar neste servidor (e o motivo). */
  unavailableReason: string | null;
}

export function loadMsiInfoReaderConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): MsiInfoReaderConfig {
  const command = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const base: MsiInfoReaderConfig = {
    command,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', READ_MSI_SCRIPT_PATH],
    timeoutMs: READ_MSI_TIMEOUT_MS,
    unavailableReason: null,
  };
  if (platform !== 'win32') {
    return { ...base, unavailableReason: 'a leitura do ProductCode exige o backend em Windows (powershell.exe).' };
  }
  if (!existsSync(command)) return { ...base, unavailableReason: `PowerShell não encontrado em ${command}.` };
  if (!existsSync(READ_MSI_SCRIPT_PATH)) {
    return { ...base, unavailableReason: `script de leitura do MSI não encontrado em ${READ_MSI_SCRIPT_PATH}.` };
  }
  return base;
}

export class MsiInfoReader {
  private readonly logger = new Logger(MsiInfoReader.name);

  constructor(private readonly config: MsiInfoReaderConfig) {}

  get isAvailable(): boolean {
    return this.config.unavailableReason === null;
  }

  get unavailableReason(): string | null {
    return this.config.unavailableReason;
  }

  /** Nunca lança: problema vira { ok: false } com o motivo. */
  read(path: string): Promise<MsiInfoResult> {
    if (!this.isAvailable) return Promise.resolve({ ok: false, message: this.config.unavailableReason! });

    return new Promise<MsiInfoResult>((resolvePromise) => {
      let settled = false;
      let stdout = '';
      let timedOut = false;
      const finish = (value: MsiInfoResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if ('message' in value) this.logger.warn(`ProductCode não lido de ${path}: ${value.message}`);
        resolvePromise(value);
      };

      const child = spawn(this.config.command, this.config.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.config.timeoutMs);

      child.on('error', (err) => finish({ ok: false, message: `Não foi possível iniciar o PowerShell: ${err.message}` }));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < 64 * 1024) stdout += chunk;
      });
      child.on('close', () => {
        if (timedOut) {
          finish({ ok: false, message: `A leitura do MSI passou de ${this.config.timeoutMs / 1000} s e foi encerrada.` });
          return;
        }
        finish(parseMsiInfoOutput(stdout));
      });
      child.stdin.on('error', () => {
        // O processo pode morrer antes de ler a entrada; o 'close' relata o resultado.
      });
      child.stdin.end(toAsciiJson({ path }));
    });
  }
}

/** Primeira linha JSON da saída → resultado validado (formato do ProductCode inclusive). */
export function parseMsiInfoOutput(stdout: string): MsiInfoResult {
  const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
  if (!line) return { ok: false, message: 'O script de leitura do MSI terminou sem resultado.' };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { ok: false, message: 'Saída inválida do script de leitura do MSI.' };
  }
  if (raw.ok !== true) {
    return { ok: false, message: typeof raw.message === 'string' ? raw.message.trim() : 'Falha ao ler o MSI.' };
  }
  const code = typeof raw.productCode === 'string' ? raw.productCode.toUpperCase() : '';
  if (!PRODUCT_CODE_PATTERN.test(code)) return { ok: false, message: 'O ProductCode lido do MSI não está no formato {GUID}.' };
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  return {
    ok: true,
    info: {
      productCode: code,
      productName: text(raw.productName),
      productVersion: text(raw.productVersion),
      manufacturer: text(raw.manufacturer),
    },
  };
}
