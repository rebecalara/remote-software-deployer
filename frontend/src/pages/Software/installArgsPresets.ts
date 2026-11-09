import type { InstallType } from '../../types/software';

// Modelos de argumentos de instalação silenciosa por família de instalador. A PoC
// mostrou que esses parâmetros variam por instalador; os modelos só preenchem o
// campo — a pessoa pode ajustar. O backend valida cada argumento (lista de
// caracteres permitidos; em MSI, só propriedades NOME=valor) e eles sempre vão como
// PARÂMETROS do instalador, nunca como linha de comando (ver DECISIONS.md).

export interface ArgsPreset {
  id: string;
  label: string;
  args: string[];
}

export const ARGS_PRESETS: Record<InstallType, ArgsPreset[]> = {
  EXE: [
    { id: 'inno', label: 'Inno Setup', args: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'] },
    { id: 'nsis', label: 'NSIS', args: ['/S'] },
    { id: 'installshield', label: 'InstallShield', args: ['/s', '/v"/qn"'] },
    { id: 'none', label: 'Sem argumentos', args: [] },
  ],
  // O comando-base msiexec /i <arquivo> /qn /norestart é fixo; aqui só entram
  // propriedades públicas do Windows Installer.
  MSI: [
    { id: 'none', label: 'Sem propriedades extras', args: [] },
    { id: 'allusers', label: 'Para todos os usuários (ALLUSERS=1)', args: ['ALLUSERS=1'] },
    { id: 'noreboot', label: 'Nunca reiniciar (REBOOT=ReallySuppress)', args: ['REBOOT=ReallySuppress'] },
  ],
};

/** Um argumento por linha: espaços dentro de um argumento (entre aspas) são preservados. */
export function argsToText(args: string[]): string {
  return args.join('\n');
}

export function textToArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** "installArgs[2]" → índice 2 do argumento com problema (linha 3 na tela). */
export function argIndexFromField(field: string | undefined): number | null {
  const match = field?.match(/^installArgs\[(\d+)\]$/);
  return match ? Number(match[1]) : null;
}
