import { describe, expect, it } from 'vitest';
import { ARGS_PRESETS, argIndexFromField, argsToText, textToArgs } from './installArgsPresets';

describe('argumentos de instalação — um por linha', () => {
  it('um argumento com espaço entre aspas continua UM argumento', () => {
    expect(textToArgs('/S\nINSTALLDIR="C:\\Program Files\\App"')).toEqual(['/S', 'INSTALLDIR="C:\\Program Files\\App"']);
  });

  it('linhas vazias e espaços nas pontas são ignorados; aceita CRLF colado do Windows', () => {
    expect(textToArgs('  /VERYSILENT  \r\n\r\n/NORESTART\n   ')).toEqual(['/VERYSILENT', '/NORESTART']);
  });

  it('ida e volta entre lista e texto', () => {
    const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
    expect(textToArgs(argsToText(args))).toEqual(args);
  });

  it('erro do backend no campo installArgs[2] aponta a 3ª linha (índice 2)', () => {
    expect(argIndexFromField('installArgs[2]')).toBe(2);
    expect(argIndexFromField('name')).toBeNull();
    expect(argIndexFromField(undefined)).toBeNull();
  });
});

describe('modelos prontos', () => {
  it('MSI só tem propriedades NOME=valor (o msiexec /qn /norestart é fixo)', () => {
    for (const preset of ARGS_PRESETS.MSI) {
      for (const arg of preset.args) expect(arg).toMatch(/^[A-Z]+=\S+$/);
    }
  });

  it('nenhum modelo de MSI deixa a máquina reiniciar', () => {
    const all = ARGS_PRESETS.MSI.flatMap((p) => p.args);
    expect(all.filter((a) => a.startsWith('REBOOT='))).toEqual(['REBOOT=ReallySuppress']);
  });

  it('modelos de EXE para as famílias mais comuns', () => {
    expect(ARGS_PRESETS.EXE.map((p) => p.label)).toEqual(['Inno Setup', 'NSIS', 'InstallShield', 'Sem argumentos']);
    expect(ARGS_PRESETS.EXE.find((p) => p.id === 'nsis')?.args).toEqual(['/S']);
  });
});
