import type { Software } from '../../types/software';

// Monta o comando que o backend/scripts/deploy-target.ps1 executa em cada máquina —
// manter em sincronia com ele. Só para EXIBIR na revisão: quem executa é o script, com
// os argumentos como itens do -ArgumentList (nunca como linha de comando montada).

/** Pasta temporária criada em cada máquina; <alvo> é o id da máquina na implantação. */
export const REMOTE_DIR = 'C:\\Windows\\Temp\\rsd\\<alvo>';

export function installerPlaceholder(software: Pick<Software, 'installType'>): string {
  return `${REMOTE_DIR}\\<instalador>.${software.installType.toLowerCase()}`;
}

/** Os itens da linha de comando, na ordem em que o script os passa. */
export function commandParts(software: Pick<Software, 'installType' | 'installArgs'>): string[] {
  const file = installerPlaceholder(software);
  if (software.installType === 'MSI') {
    // REBOOT=ReallySuppress por último: garante que o sistema nunca reinicia a máquina.
    return ['msiexec.exe', '/i', file, '/qn', '/norestart', ...software.installArgs, 'REBOOT=ReallySuppress'];
  }
  return [file, ...software.installArgs];
}

export function commandText(software: Pick<Software, 'installType' | 'installArgs'>): string {
  return commandParts(software).join(' ');
}
