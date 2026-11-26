import { describe, expect, it } from 'vitest';
import { REMOTE_DIR, commandParts, commandText, installerPlaceholder, uninstallCommandText } from './installCommand';

// O comando mostrado no passo Revisar precisa ser o mesmo que o deploy-target.ps1 executa.

describe('comando de instalação mostrado na revisão', () => {
  it('a pasta temporária é a protegida (C:\\ProgramData\\RSD), não mais o C:\\Windows\\Temp', () => {
    expect(REMOTE_DIR).toBe('C:\\ProgramData\\RSD\\<alvo>');
    expect(installerPlaceholder({ installType: 'MSI' })).toBe('C:\\ProgramData\\RSD\\<alvo>\\<instalador>.msi');
  });

  it('MSI: msiexec silencioso, propriedades do catálogo e REBOOT=ReallySuppress POR ÚLTIMO', () => {
    const parts = commandParts({ installType: 'MSI', installArgs: ['ALLUSERS=1', 'REBOOT=Force'] });
    expect(parts.slice(0, 5)).toEqual(['msiexec.exe', '/i', 'C:\\ProgramData\\RSD\\<alvo>\\<instalador>.msi', '/qn', '/norestart']);
    // Na linha do msiexec vale a última ocorrência: o catálogo nunca consegue reiniciar a máquina.
    expect(parts.at(-1)).toBe('REBOOT=ReallySuppress');
    expect(parts).toContain('ALLUSERS=1');
  });

  it('EXE: o próprio arquivo seguido dos argumentos, sem nada acrescentado', () => {
    expect(commandText({ installType: 'EXE', installArgs: ['/S'] })).toBe('C:\\ProgramData\\RSD\\<alvo>\\<instalador>.exe /S');
  });

  it('desinstalação: comando fixo pelo ProductCode, sem argumentos do catálogo', () => {
    expect(uninstallCommandText({ msiProductCode: '{23170F69-40C1-2702-2606-000001000000}' })).toBe(
      'msiexec.exe /x {23170F69-40C1-2702-2606-000001000000} /qn /norestart REBOOT=ReallySuppress',
    );
    expect(uninstallCommandText({ msiProductCode: null })).toContain('{ProductCode}');
  });
});
