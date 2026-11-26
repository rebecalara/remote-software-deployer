import { describe, expect, it } from 'vitest';
import type { DeploymentStatus } from '../../types/deployment';
import { phaseOf } from './targetPhase';

const target = (status: DeploymentStatus, message: string | null = null, exitCode: number | null = null) => ({
  status,
  exitCode,
  lastLog: message === null ? null : { timestamp: '2026-11-25T12:00:00.000Z', level: 'INFO' as const, message },
});

describe('phaseOf — fase da máquina no lugar de uma porcentagem', () => {
  it('na fila', () => {
    expect(phaseOf(target('PENDING'))).toEqual({ label: 'Aguardando na fila', tone: 'waiting' });
  });

  it.each([
    ['Conectando a RSD-ALVO-01 pelo WinRM (porta 5985).', 'Conectando'],
    ['Copiando o instalador (1,9 MB) para C:\\ProgramData\\RSD\\x\\y.msi.', 'Copiando o instalador'],
    ['SHA-256 conferido na máquina de destino.', 'Conferindo o hash'],
    ['Executando o instalador em RSD-ALVO-01.', 'Instalando'],
    ['Executando a desinstalação (MSI) em RSD-ALVO-01.', 'Desinstalando'],
    ['Executando o desinstalador do fabricante em RSD-ALVO-01.', 'Desinstalando'],
    ['Arquivos temporários apagados de RSD-ALVO-01.', 'Finalizando'],
  ])('em execução, a última mensagem do script define a fase: "%s" → %s', (message, label) => {
    expect(phaseOf(target('RUNNING', message))).toEqual({ label, tone: 'running' });
  });

  it('comando do fabricante esperando a chave sair do registro', () => {
    expect(phaseOf(target('RUNNING', 'Conferindo se o programa saiu do registro (até 120 s).')).label).toBe('Confirmando a remoção');
  });

  it('mensagem desconhecida não quebra a tela: "Em execução"', () => {
    expect(phaseOf(target('RUNNING', 'Mensagem nova que o script passou a gravar'))).toEqual({ label: 'Em execução', tone: 'running' });
    expect(phaseOf(target('RUNNING', null)).label).toBe('Em execução');
  });

  it('MSI que já estava na máquina: sucesso sem executar', () => {
    expect(phaseOf(target('SUCCEEDED', 'Já instalado: o produto deste pacote já está instalado.'))).toEqual({
      label: 'Já estava instalado',
      tone: 'success',
    });
    expect(phaseOf(target('SUCCEEDED', 'Não estava instalado na máquina.')).label).toBe('Não estava instalado');
  });

  it.each([3010, 1641])('código %i: concluído, mas com reinício pendente (aviso, não sucesso puro)', (code) => {
    expect(phaseOf(target('SUCCEEDED', 'Instalação concluída', code))).toEqual({ label: 'Concluído, reinício pendente', tone: 'warning' });
  });

  it('resultados finais', () => {
    expect(phaseOf(target('SUCCEEDED', 'Instalação concluída (código 0).', 0))).toEqual({ label: 'Concluído', tone: 'success' });
    expect(phaseOf(target('FAILED', 'Pasta temporária insegura'))).toEqual({ label: 'Falhou', tone: 'danger' });
    expect(phaseOf(target('CANCELLED'))).toEqual({ label: 'Cancelado', tone: 'muted' });
  });
});
