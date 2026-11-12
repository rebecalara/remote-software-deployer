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
  | 'install'
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
  | 'unexpected'
  // Do lado do Node:
  | 'unavailable'
  | 'spawn-failed'
  | 'watchdog-timeout'
  | 'no-result';

export interface DeployTargetInput {
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

export interface DeployEvent {
  level: LogLevel;
  phase: DeployPhase;
  message: string;
}

/**
 * `ok: true` = o instalador executou e terminou (qualquer código de saída).
 * `ok: false` = parou antes ou durante, por um motivo conhecido. Nunca lança.
 */
export type DeployResult =
  | { ok: true; exitCode: number }
  | { ok: false; phase: DeployPhase; reason: DeployFailureReason; message: string };

export interface WinRmCredential {
  username: string;
  password: string;
}

export interface PowerShellExecutorConfig {
  /** Executável e argumentos fixos. Em produção: powershell.exe -File deploy-target.ps1. */
  command: string;
  args: string[];
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

      const watchdogMs = this.watchdogMs(input.installerSizeBytes);
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

const PHASES = new Set<DeployPhase>(['validate', 'resolve', 'connect', 'copy', 'verify', 'install', 'cleanup', 'executor']);
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
  if (e.type === 'result' && e.ok === false && typeof e.message === 'string') {
    const reason = typeof e.reason === 'string' ? (e.reason as DeployFailureReason) : 'unexpected';
    return { type: 'result', result: { ok: false, phase, reason, message: e.message } };
  }
  return null;
}
