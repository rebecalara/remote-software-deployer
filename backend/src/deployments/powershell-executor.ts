import { Logger } from '@nestjs/common';
import { InstallType, LogLevel } from '@prisma/client';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// ÚNICO ponto de acesso ao PowerShell (DECISIONS.md, Bloco 4: "backend chama o
// powershell.exe 5.1"). Um processo por máquina de destino, rodando o script fixo
// backend/scripts/deploy-target.ps1. A entrada vai pelo stdin, em JSON; a saída
// volta como um evento JSON por linha. Este arquivo não decide se um código de
// saída é sucesso — só devolve o que o script relatou.

export const DEFAULT_INSTALL_TIMEOUT_MINUTES = 30;
export const MAX_INSTALL_TIMEOUT_MINUTES = 240;
export const CONNECT_TIMEOUT_SECONDS = 30;
/** Piso de velocidade assumido para a cópia, só para calcular o limite geral. */
export const COPY_MIN_BYTES_PER_SECOND = 1024 * 1024;
export const COPY_BASE_SECONDS = 60;
export const WATCHDOG_MARGIN_SECONDS = 120;
/** Mensagens e stderr são truncados: o log é para gente ler, não para guardar dump. */
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_STDERR_LENGTH = 4000;

const REDACTED = '***';

export type DeployPhase =
  | 'validate'
  | 'resolve'
  | 'connect'
  | 'copy'
  | 'verify'
  | 'check'
  | 'install'
  | 'uninstall'
  | 'cleanup'
  | 'executor';

export type DeployFailureReason =
  | 'invalid-input'
  | 'dns'
  | 'unreachable'
  | 'winrm-refused'
  | 'access-denied'
  | 'not-trusted'
  | 'session'
  | 'smb-failed'
  | 'copy-failed'
  | 'hash-mismatch'
  | 'install-timeout'
  | 'uninstall-timeout'
  | 'unexpected'
  // Do lado do Node:
  | 'unavailable'
  | 'spawn-failed'
  | 'watchdog-timeout'
  | 'no-result';

export interface InstallTargetInput {
  action: 'INSTALL';
  /** Id do DeploymentTarget — vira o nome da pasta temporária na máquina. */
  targetId: string;
  computerName: string;
  /** Caminho local do instalador guardado (<uuid>.msi|exe). */
  installerPath: string;
  installerSizeBytes: number;
  /** SHA-256 em hexadecimal maiúsculo, como no catálogo. */
  sha256: string;
  installType: InstallType;
  installArgs: string[];
}

/**
 * Desinstalação (só MSI): nada é copiado e nenhum argumento do catálogo é repassado.
 * O comando na máquina é sempre msiexec /x {ProductCode} /qn /norestart REBOOT=ReallySuppress.
 */
export interface UninstallTargetInput {
  action: 'UNINSTALL';
  targetId: string;
  computerName: string;
  installType: 'MSI';
  /** ProductCode do MSI, lido pelo servidor do pacote ({GUID} em maiúsculas). */
  productCode: string;
}

export type DeployTargetInput = InstallTargetInput | UninstallTargetInput;

export interface DeployEvent {
  level: LogLevel;
  phase: DeployPhase;
  message: string;
}

/**
 * `ok: true` com `exitCode` = o instalador executou e terminou (qualquer código).
 * `ok: true` com `alreadyInstalled` = MSI cujo ProductCode já estava instalado na
 * máquina; nada foi executado.
 * `ok: true` com `notInstalled` = desinstalação de um produto que não estava instalado
 * na máquina; nada foi executado.
 * `ok: false` = parou antes ou durante, por um motivo conhecido. Nunca lança.
 */
export type DeployResult =
  | { ok: true; exitCode: number }
  | { ok: true; alreadyInstalled: true; productCode: string }
  | { ok: true; notInstalled: true; productCode: string }
  | { ok: false; phase: DeployPhase; reason: DeployFailureReason; message: string };

export interface WinRmCredential {
  username: string;
  password: string;
}

export interface PowerShellExecutorConfig {
  /** Executável e argumentos fixos. Em produção: powershell.exe -File deploy-target.ps1. */
  command: string;
  args: string[];
  /** RF08: argumentos para o inventory-target.ps1 (padrão: os de cima, trocando o script). */
  inventoryArgs?: string[];
  /** RF08: limite geral do processo da consulta (padrão INVENTORY_WATCHDOG_MS). */
  inventoryWatchdogMs?: number;
  /** RF08: preenchido quando a consulta não pode rodar (ex.: script ausente). */
  inventoryUnavailableReason?: string | null;
  /** null = identidade do próprio processo (produção, conta de serviço via Kerberos). */
  credential: WinRmCredential | null;
  connectTimeoutSeconds: number;
  installTimeoutSeconds: number;
  copyMinBytesPerSecond: number;
  copyBaseSeconds: number;
  watchdogMarginSeconds: number;
  /** Preenchido quando a implantação não pode rodar neste servidor (e o motivo). */
  unavailableReason: string | null;
}

export class PowerShellExecutor {
  constructor(private readonly config: PowerShellExecutorConfig) {}

  get isAvailable(): boolean {
    return this.config.unavailableReason === null;
  }

  get unavailableReason(): string | null {
    return this.config.unavailableReason;
  }

  /**
   * Limite do processo inteiro, acima da soma dos limites do script: só dispara se o
   * próprio script travar (ex.: cópia parada no meio). Encerrar o powershell.exe local
   * não garante que o instalador pare na máquina de destino.
   */
  watchdogMs(installerSizeBytes: number): number {
    const c = this.config;
    const copySeconds = c.copyBaseSeconds + Math.ceil(installerSizeBytes / c.copyMinBytesPerSecond);
    return (2 * c.connectTimeoutSeconds + copySeconds + c.installTimeoutSeconds + c.watchdogMarginSeconds) * 1000;
  }

  /**
   * Executa a implantação em uma máquina. `onEvent` recebe cada passo assim que o
   * script o relata (já sem a senha e truncado). Nunca lança: qualquer falha volta
   * como `{ ok: false }`.
   */
  run(input: DeployTargetInput, onEvent: (event: DeployEvent) => void): Promise<DeployResult> {
    if (!this.isAvailable) {
      return Promise.resolve(fail('executor', 'unavailable', this.config.unavailableReason!));
    }

    const secrets = this.config.credential?.password ? [this.config.credential.password] : [];
    const clean = (text: string) => truncate(redact(text, secrets), MAX_MESSAGE_LENGTH);
    const emit = (event: DeployEvent) => {
      try {
        onEvent({ ...event, message: clean(event.message) });
      } catch {
        // Quem consome o evento não derruba a execução.
      }
    };

    return new Promise<DeployResult>((resolvePromise) => {
      let settled = false;
      let result: DeployResult | null = null;
      let stderr = '';
      let watchdogFired = false;

      const finish = (value: DeployResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        resolvePromise(value);
      };

      const child = spawn(this.config.command, this.config.args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Na desinstalação não há cópia: o limite geral não conta tempo de transferência.
      const watchdogMs = this.watchdogMs('installerSizeBytes' in input ? input.installerSizeBytes : 0);
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        child.kill();
      }, watchdogMs);

      child.on('error', (err) => {
        finish(fail('executor', 'spawn-failed', clean(`Não foi possível iniciar o PowerShell: ${err.message}`)));
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR_LENGTH) stderr += chunk;
      });

      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        if (line.trim() === '') return;
        const event = parseLine(line);
        if (event === null) {
          // Saída fora do protocolo (ex.: um aviso do próprio PowerShell).
          emit({ level: LogLevel.DEBUG, phase: 'executor', message: line });
        } else if (event.type === 'log') {
          emit({ level: event.level, phase: event.phase, message: event.message });
        } else if (result === null) {
          const r = event.result;
          result = 'message' in r ? { ...r, message: clean(r.message) } : r;
        }
      });

      child.on('close', (code) => {
        if (watchdogFired) {
          finish(
            fail(
              'executor',
              'watchdog-timeout',
              `O processo de implantação passou do limite geral (${Math.round(watchdogMs / 1000)} s) e foi encerrado. ` +
                'A instalação pode continuar na máquina de destino — confira a máquina.',
            ),
          );
          return;
        }
        if (result !== null) {
          finish(result);
          return;
        }
        const detail = stderr.trim() ? `: ${stderr.trim()}` : '.';
        finish(fail('executor', 'no-result', clean(`O script terminou sem relatar resultado (código ${code})${detail}`)));
      });

      // A credencial só existe aqui e no stdin do processo filho. Nunca vai para log.
      const payload = {
        ...input,
        connectTimeoutSeconds: this.config.connectTimeoutSeconds,
        installTimeoutSeconds: this.config.installTimeoutSeconds,
        credential: this.config.credential,
      };
      child.stdin.on('error', () => {
        // O processo pode morrer antes de ler a entrada; o 'close' relata o resultado.
      });
      child.stdin.end(toAsciiJson(payload));
    });
  }

  get isInventoryAvailable(): boolean {
    return this.isAvailable && !this.config.inventoryUnavailableReason;
  }

  get inventoryUnavailableReason(): string | null {
    return this.config.unavailableReason ?? this.config.inventoryUnavailableReason ?? null;
  }

  /**
   * RF08: lê o software instalado numa máquina, ao vivo, com o script fixo
   * inventory-target.ps1 (só leitura) — mesma credencial, mesmo powershell.exe e mesmo
   * filtro de senha da implantação. Método à parte: o run() da implantação não muda.
   * Nunca lança: tudo volta como resultado.
   */
  inventory(computerName: string): Promise<InventoryResult> {
    if (!this.isInventoryAvailable) {
      return Promise.resolve({ ok: false, reason: 'unavailable', message: this.inventoryUnavailableReason! });
    }
    const secrets = this.config.credential?.password ? [this.config.credential.password] : [];
    const clean = (text: string) => truncate(redact(text, secrets), MAX_MESSAGE_LENGTH);
    const args = this.config.inventoryArgs ?? this.config.args.map((a) => (a === DEPLOY_SCRIPT_PATH ? INVENTORY_SCRIPT_PATH : a));
    const watchdogMs = this.config.inventoryWatchdogMs ?? INVENTORY_WATCHDOG_MS;

    return new Promise<InventoryResult>((resolvePromise) => {
      let settled = false;
      let result: InventoryResult | null = null;
      let stderr = '';
      let watchdogFired = false;
      const finish = (value: InventoryResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        resolvePromise(value);
      };

      const child = spawn(this.config.command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        child.kill();
      }, watchdogMs);

      child.on('error', (err) => {
        finish({ ok: false, reason: 'spawn-failed', message: clean(`Não foi possível iniciar o PowerShell: ${err.message}`) });
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR_LENGTH) stderr += chunk;
      });
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        if (result !== null || line.trim() === '') return;
        const parsed = parseInventoryLine(line);
        if (parsed) result = 'message' in parsed ? { ...parsed, message: clean(parsed.message) } : parsed;
      });
      child.on('close', (code) => {
        if (watchdogFired) {
          finish({
            ok: false,
            reason: 'watchdog-timeout',
            message: `A consulta passou do limite geral (${Math.round(watchdogMs / 1000)} s) e foi encerrada.`,
          });
          return;
        }
        if (result !== null) {
          finish(result);
          return;
        }
        const detail = stderr.trim() ? `: ${stderr.trim()}` : '.';
        finish({ ok: false, reason: 'no-result', message: clean(`O script de consulta terminou sem relatar resultado (código ${code})${detail}`) });
      });

      // A credencial só existe aqui e no stdin do processo filho. Nunca vai para log.
      child.stdin.on('error', () => {
        // O processo pode morrer antes de ler a entrada; o 'close' relata o resultado.
      });
      child.stdin.end(
        toAsciiJson({
          computerName,
          connectTimeoutSeconds: this.config.connectTimeoutSeconds,
          readTimeoutSeconds: INVENTORY_READ_TIMEOUT_SECONDS,
          credential: this.config.credential,
        }),
      );
    });
  }
}

/**
 * Lê a configuração do ambiente. Problemas de configuração não derrubam o backend:
 * deixam a implantação indisponível, com o motivo (o resto do sistema funciona).
 */
export function loadPowerShellExecutorConfig(
  env: NodeJS.ProcessEnv,
  logger?: Logger,
  platform: NodeJS.Platform = process.platform,
): PowerShellExecutorConfig {
  const command = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const scriptPath = DEPLOY_SCRIPT_PATH;
  const base: PowerShellExecutorConfig = {
    // Caminho absoluto, não "powershell" pelo PATH: outro executável com o mesmo nome
    // não pode ser chamado no lugar.
    command,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    credential: null,
    connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS,
    installTimeoutSeconds: parseInstallTimeoutMinutes(env.DEPLOYMENT_INSTALL_TIMEOUT_MINUTES, logger) * 60,
    copyMinBytesPerSecond: COPY_MIN_BYTES_PER_SECOND,
    copyBaseSeconds: COPY_BASE_SECONDS,
    watchdogMarginSeconds: WATCHDOG_MARGIN_SECONDS,
    unavailableReason: null,
  };

  const unavailable = (reason: string): PowerShellExecutorConfig => {
    logger?.error(`Implantação remota indisponível: ${reason}`);
    return { ...base, unavailableReason: reason };
  };

  if (platform !== 'win32') {
    return unavailable('a implantação remota exige o backend em Windows (powershell.exe).');
  }
  if (!existsSync(command)) return unavailable(`PowerShell não encontrado em ${command}.`);
  if (!existsSync(scriptPath)) return unavailable(`script de implantação não encontrado em ${scriptPath}.`);
  if (!existsSync(INVENTORY_SCRIPT_PATH)) {
    base.inventoryUnavailableReason = `script de consulta não encontrado em ${INVENTORY_SCRIPT_PATH}.`;
  }

  const username = env.WINRM_USERNAME?.trim() ?? '';
  const password = env.WINRM_PASSWORD ?? '';
  if (username && !password) return unavailable('WINRM_USERNAME definido sem WINRM_PASSWORD.');
  if (!username && password) return unavailable('WINRM_PASSWORD definido sem WINRM_USERNAME.');

  if (username) {
    logger?.log(`Implantação remota com a credencial de ${username} (definida no .env).`);
    return { ...base, credential: { username, password } };
  }
  logger?.log('Implantação remota com a identidade do próprio processo do backend.');
  return base;
}

/** backend/scripts/deploy-target.ps1 — vale para src/ (ts-node, testes) e dist/. */
export const DEPLOY_SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'deploy-target.ps1');
/** RF08: backend/scripts/inventory-target.ps1 (só leitura). */
export const INVENTORY_SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'inventory-target.ps1');

export function parseInstallTimeoutMinutes(raw: string | undefined, logger?: Logger): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INSTALL_TIMEOUT_MINUTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    logger?.warn(
      `DEPLOYMENT_INSTALL_TIMEOUT_MINUTES inválido ("${raw}"); usando ${DEFAULT_INSTALL_TIMEOUT_MINUTES}.`,
    );
    return DEFAULT_INSTALL_TIMEOUT_MINUTES;
  }
  if (value > MAX_INSTALL_TIMEOUT_MINUTES) {
    logger?.warn(
      `DEPLOYMENT_INSTALL_TIMEOUT_MINUTES=${value} acima do teto; usando ${MAX_INSTALL_TIMEOUT_MINUTES}.`,
    );
    return MAX_INSTALL_TIMEOUT_MINUTES;
  }
  return value;
}

/** Substitui cada segredo por "***" — inclusive dentro de mensagens de erro do Windows. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * JSON só com ASCII: o stdin do powershell.exe é lido na página de código do console
 * (cp850 no Windows pt-BR), que corromperia acentos — inclusive numa senha.
 */
export function toAsciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (truncado)` : text;
}

function fail(phase: DeployPhase, reason: DeployFailureReason, message: string): DeployResult {
  return { ok: false, phase, reason, message };
}

const PHASES = new Set<DeployPhase>([
  'validate', 'resolve', 'connect', 'copy', 'verify', 'check', 'install', 'uninstall', 'cleanup', 'executor',
]);
/** ProductCode do Windows Installer: GUID entre chaves. */
const PRODUCT_CODE = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;
const LEVELS = new Set<string>(Object.values(LogLevel));

type ParsedLine =
  | { type: 'log'; level: LogLevel; phase: DeployPhase; message: string }
  | { type: 'result'; result: DeployResult };

/** Valida o formato de cada linha: o que não segue o protocolo vira null (DEBUG). */
export function parseLine(line: string): ParsedLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const phase = PHASES.has(e.phase as DeployPhase) ? (e.phase as DeployPhase) : 'executor';

  if (e.type === 'log' && typeof e.message === 'string' && LEVELS.has(e.level as string)) {
    return { type: 'log', level: e.level as LogLevel, phase, message: e.message };
  }
  if (e.type === 'result' && e.ok === true && Number.isInteger(e.exitCode)) {
    return { type: 'result', result: { ok: true, exitCode: e.exitCode as number } };
  }
  if (e.type === 'result' && e.ok === true && e.alreadyInstalled === true && typeof e.productCode === 'string' &&
      PRODUCT_CODE.test(e.productCode)) {
    return { type: 'result', result: { ok: true, alreadyInstalled: true, productCode: e.productCode.toUpperCase() } };
  }
  if (e.type === 'result' && e.ok === true && e.notInstalled === true && typeof e.productCode === 'string' &&
      PRODUCT_CODE.test(e.productCode)) {
    return { type: 'result', result: { ok: true, notInstalled: true, productCode: e.productCode.toUpperCase() } };
  }
  if (e.type === 'result' && e.ok === false && typeof e.message === 'string') {
    const reason = typeof e.reason === 'string' ? (e.reason as DeployFailureReason) : 'unexpected';
    return { type: 'result', result: { ok: false, phase, reason, message: e.message } };
  }
  return null;
}


// ---------- RF08: inventário de software por máquina ----------

/** Tempo limite da leitura na máquina (OperationTimeout da sessão WinRM). */
export const INVENTORY_READ_TIMEOUT_SECONDS = 60;
/** Limite geral do processo: conexão (30 s) + leitura (60 s) + margem. */
export const INVENTORY_WATCHDOG_MS = 120_000;
export const MAX_INVENTORY_ITEMS = 3000;
const MAX_INVENTORY_TEXT = 256;

export interface InventoryItem {
  name: string;
  version: string | null;
  publisher: string | null;
  /** aaaa-mm-dd, quando o instalador registrou. */
  installDate: string | null;
  /** Só MSI: o nome da subchave Uninstall ({GUID} em maiúsculas). */
  productCode: string | null;
  arch: '64' | '32';
}

export type InventoryFailureReason =
  | 'invalid-input'
  | 'dns'
  | 'unreachable'
  | 'winrm-refused'
  | 'access-denied'
  | 'not-trusted'
  | 'session'
  | 'timeout'
  | 'read-failed'
  | 'unexpected'
  // Do lado do Node:
  | 'unavailable'
  | 'spawn-failed'
  | 'watchdog-timeout'
  | 'no-result';

export type InventoryResult =
  | { ok: true; items: InventoryItem[] }
  | { ok: false; reason: InventoryFailureReason; message: string };

/**
 * Linha de resultado do inventory-target.ps1 → resultado validado. Logs e saída fora do
 * protocolo viram null (ignorados). Os itens são normalizados aqui: textos aparados e
 * truncados, ProductCode só no formato {GUID}, data só aaaa-mm-dd, sem repetição (o
 * mesmo programa nas visões de 64 e 32 bits) e em ordem de nome, até MAX_INVENTORY_ITEMS.
 */
export function parseInventoryLine(line: string): InventoryResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (e.type !== 'result') return null;
  if (e.ok === false && typeof e.message === 'string') {
    const reason = typeof e.reason === 'string' ? (e.reason as InventoryFailureReason) : 'unexpected';
    return { ok: false, reason, message: e.message };
  }
  if (e.ok !== true) return null;
  return { ok: true, items: normalizeInventoryItems(Array.isArray(e.items) ? e.items : e.items ? [e.items] : []) };
}

export function normalizeInventoryItems(rawItems: unknown[]): InventoryItem[] {
  const text = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t === '' ? null : t.length > MAX_INVENTORY_TEXT ? t.slice(0, MAX_INVENTORY_TEXT) : t;
  };
  const byKey = new Map<string, InventoryItem>();
  for (const r of rawItems) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    const name = text(o.name);
    if (!name) continue;
    const code = typeof o.productCode === 'string' ? o.productCode.trim().toUpperCase() : '';
    const date = typeof o.installDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.installDate) ? o.installDate : null;
    const item: InventoryItem = {
      name,
      version: text(o.version),
      publisher: text(o.publisher),
      installDate: date,
      productCode: PRODUCT_CODE.test(code) ? code : null,
      arch: o.arch === '32' ? '32' : '64',
    };
    const key = `${item.name.toLowerCase()}|${item.version ?? ''}|${item.productCode ?? ''}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || (a.version ?? '').localeCompare(b.version ?? ''))
    .slice(0, MAX_INVENTORY_ITEMS);
}
