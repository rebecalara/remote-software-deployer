import { DeploymentStatus as S, LogLevel } from '@prisma/client';
import { aggregateDeploymentStatus, interpretExitCode, interpretResult } from './deployment-outcome';

describe('interpretExitCode', () => {
  it.each(['MSI', 'EXE'] as const)('0 é sucesso (%s)', (type) => {
    expect(interpretExitCode(0, type)).toEqual({
      status: S.SUCCEEDED,
      level: LogLevel.INFO,
      message: 'Instalação concluída (código 0).',
    });
  });

  it.each(['MSI', 'EXE'] as const)('3010 é sucesso com aviso de reinício pendente, sem reiniciar (%s)', (type) => {
    const outcome = interpretExitCode(3010, type);
    expect(outcome.status).toBe(S.SUCCEEDED);
    expect(outcome.level).toBe(LogLevel.WARN);
    expect(outcome.message).toContain('precisa ser reiniciada');
    expect(outcome.message).toContain('o sistema não reinicia a máquina');
  });

  it('1641 é sucesso com aviso de reinício iniciado pelo instalador', () => {
    expect(interpretExitCode(1641, 'MSI')).toMatchObject({ status: S.SUCCEEDED, level: LogLevel.WARN });
  });

  it.each([
    [
      1603,
      'Erro fatal durante a instalação (código 1603). O produto pode já estar instalado na máquina ' +
        'ou ter uma instalação anterior incompleta.',
    ],
    [1618, 'Outra instalação estava em andamento na máquina (código 1618). Tente de novo mais tarde.'],
    [1638, 'Outra versão deste produto já está instalada na máquina (código 1638).'],
  ])('código %i do MSI tem mensagem própria', (code, message) => {
    expect(interpretExitCode(code, 'MSI')).toEqual({ status: S.FAILED, level: LogLevel.ERROR, message });
  });

  it('em EXE, códigos do msiexec não ganham o significado do Windows Installer', () => {
    expect(interpretExitCode(1603, 'EXE')).toEqual({
      status: S.FAILED,
      level: LogLevel.ERROR,
      message: 'O instalador terminou com o código 1603, que indica falha.',
    });
  });

  it.each([1, 2, -1, 5])('qualquer outro código é falha (%i)', (code) => {
    expect(interpretExitCode(code, 'MSI').status).toBe(S.FAILED);
  });
});

describe('interpretResult', () => {
  it('código de saída: segue a tabela e grava o código', () => {
    expect(interpretResult({ ok: true, exitCode: 3010 }, 'MSI')).toMatchObject({
      status: S.SUCCEEDED,
      level: LogLevel.WARN,
      exitCode: 3010,
    });
  });

  it('MSI já instalado: sucesso com aviso "já instalado", sem código (nada rodou)', () => {
    const code = '{23170F69-40C1-2702-2606-000001000000}';
    expect(interpretResult({ ok: true, alreadyInstalled: true, productCode: code }, 'MSI')).toEqual({
      status: S.SUCCEEDED,
      level: LogLevel.WARN,
      message: `Já instalado: o produto deste pacote (ProductCode ${code}) já está instalado na máquina. A instalação não foi executada.`,
      exitCode: null,
    });
  });

  it('falha: FAILED com a mensagem do executor, sem código', () => {
    expect(
      interpretResult({ ok: false, phase: 'connect', reason: 'unreachable', message: 'não respondeu' }, 'MSI'),
    ).toEqual({ status: S.FAILED, level: LogLevel.ERROR, message: 'não respondeu', exitCode: null });
  });
});

describe('aggregateDeploymentStatus', () => {
  it.each([
    [[S.SUCCEEDED, S.RUNNING], null],
    [[S.SUCCEEDED, S.PENDING], null],
    [[S.SUCCEEDED, S.SUCCEEDED], S.SUCCEEDED],
    [[S.SUCCEEDED, S.FAILED], S.FAILED],
    [[S.FAILED, S.CANCELLED], S.FAILED],
    [[S.SUCCEEDED, S.CANCELLED], S.CANCELLED],
    [[S.CANCELLED, S.CANCELLED], S.CANCELLED],
  ])('%p → %p', (statuses, expected) => {
    expect(aggregateDeploymentStatus(statuses)).toBe(expected);
  });
});
