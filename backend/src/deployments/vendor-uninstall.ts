import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Desinstalação de programa que NÃO é MSI: EXCEÇÃO CONTROLADA à regra "nunca executar
// comando que não seja do sistema" (DECISIONS.md). Só o QuietUninstallString que o
// próprio programa declarou no registro, validado aqui (servidor) e de novo na máquina
// (uninstall-command-rules.ps1) com os MESMOS casos de teste (uninstall-command-cases.json).
// O UninstallString (sem "Quiet") nunca é lido nem executado.

/** Liga a exceção. Padrão DESLIGADO (decisão da autora); documentado no .env.example. */
export function vendorUninstallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DEPLOYMENT_ALLOW_VENDOR_UNINSTALL ?? '').trim().toLowerCase() === 'true';
}

export const VENDOR_UNINSTALL_DISABLED =
  'A desinstalação por comando do fabricante está desligada neste servidor (DEPLOYMENT_ALLOW_VENDOR_UNINSTALL).';

/** Raízes onde o executável pode estar (no servidor; na máquina valem as dela). */
export const DEFAULT_ALLOWED_ROOTS = ['C:\\Program Files', 'C:\\Program Files (x86)'];

export const UNINSTALL_RULES_SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'uninstall-command-rules.ps1');
export const UNINSTALL_CASES_PATH = join(__dirname, '..', '..', 'scripts', 'uninstall-command-cases.json');

export const MAX_COMMAND_LENGTH = 1024;

/**
 * Executáveis recusados pelo nome, mesmo dentro de Program Files (ex.: o pwsh.exe do
 * PowerShell 7 mora lá). Intérpretes, ferramentas do sistema e "LOLBins".
 */
export const BLOCKED_EXECUTABLES = [
  'cmd', 'powershell', 'powershell_ise', 'pwsh', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32',
  'msiexec', 'conhost', 'bash', 'wsl', 'certutil', 'bitsadmin', 'schtasks', 'reg', 'regedit', 'sc', 'net',
  'net1', 'taskkill', 'explorer', 'curl', 'ftp', 'msbuild', 'installutil', 'regasm', 'regsvcs', 'cmstp',
  'forfiles', 'hh', 'wmic', 'control', 'msdt', 'odbcconf', 'at', 'psexec', 'psexec64', 'python', 'pythonw',
  'node', 'java', 'javaw', 'wt', 'tar', 'expand', 'makecab', 'esentutl', 'diskshadow', 'ntdsutil',
];

export type CommandCheck =
  | { ok: true; executable: string; arguments: string }
  | { ok: false; reason: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const FORBIDDEN_IN_ARGS = /[&|;<>^%$`]/;
const FORBIDDEN_IN_EXE = /[%$<>|*?^&;`]/;

/**
 * Tira as barras invertidas do fim ("C:\Program Files\\" → "C:\Program Files"). Laço do fim
 * para trás, linear: a regex /\\+$/ fazia retrocesso (tempo quadrático) com muitas barras
 * seguidas de outro caractere.
 */
export function trimTrailingBackslashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '\\') end--;
  return value.slice(0, end);
}

/** Separa e valida o comando. Função pura: o PowerShell implementa as mesmas regras. */
export function checkUninstallCommand(command: string, roots: string[] = DEFAULT_ALLOWED_ROOTS): CommandCheck {
  const fail = (reason: string): CommandCheck => ({ ok: false, reason });
  if (typeof command !== 'string' || command.trim() === '') return fail('Comando vazio.');
  if (command.length > MAX_COMMAND_LENGTH) return fail(`Comando com mais de ${MAX_COMMAND_LENGTH} caracteres.`);
  if (CONTROL_CHARS.test(command)) return fail('Comando com caracteres de controle (ex.: quebra de linha).');
  const text = command.trim();

  let exe: string;
  let rest: string;
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1);
    if (close < 0) return fail('Aspas sem fechar no executável.');
    exe = text.slice(1, close);
    rest = text.slice(close + 1);
    if (rest !== '' && !rest.startsWith(' ')) return fail('Falta espaço entre o executável e os argumentos.');
  } else {
    const space = text.indexOf(' ');
    exe = space < 0 ? text : text.slice(0, space);
    rest = space < 0 ? '' : text.slice(space);
    if (!exe.toLowerCase().endsWith('.exe') && rest !== '' && /^[A-Za-z]:\\/.test(exe)) {
      return fail('O caminho do executável tem espaço e precisa estar entre aspas.');
    }
  }
  const args = rest.trim();

  if (!/^[A-Za-z]:\\/.test(exe) || exe.startsWith('\\\\')) {
    return fail('O executável precisa ter caminho absoluto (C:\\...), sem caminho de rede nem variável.');
  }
  if (FORBIDDEN_IN_EXE.test(exe) || exe.includes('"')) return fail('O caminho do executável tem caractere não permitido.');
  if (exe.split('\\').some((part) => part === '..' || part === '.')) return fail("O caminho do executável não pode ter '..'.");
  if (exe.includes('~')) return fail("O caminho do executável não pode ter '~' (nome curto 8.3).");
  if (!exe.toLowerCase().endsWith('.exe')) return fail('O executável precisa ser um .exe.');

  const lower = exe.toLowerCase();
  const inRoot = roots.some((root) => {
    const r = trimTrailingBackslashes(root).toLowerCase();
    return r !== '' && lower.startsWith(`${r}\\`);
  });
  if (!inRoot) return fail('O executável precisa estar dentro de Program Files ou Program Files (x86).');

  const base = lower.slice(lower.lastIndexOf('\\') + 1).replace(/\.exe$/, '');
  if (BLOCKED_EXECUTABLES.includes(base)) return fail(`O executável ${base}.exe não é permitido.`);

  if (FORBIDDEN_IN_ARGS.test(args)) {
    return fail('Os argumentos têm caractere não permitido (&, |, ;, <, >, ^, %, $ ou crase).');
  }
  if ((args.match(/"/g) ?? []).length % 2 !== 0) return fail('Aspas desbalanceadas nos argumentos.');
  return { ok: true, executable: exe, arguments: args };
}

/**
 * Identifica UM programa desinstalável: visão (64/32), subchave Uninstall e o comando
 * exato. Calculado no servidor; o navegador só devolve este id (nunca o comando).
 */
export function programId(arch: string, uninstallKey: string, command: string): string {
  return createHash('sha256').update(`${arch}\n${uninstallKey}\n${command}`, 'utf8').digest('hex');
}
