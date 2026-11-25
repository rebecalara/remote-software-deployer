import { Logger } from '@nestjs/common';
import { LogLevel } from '@prisma/client';
import { LOG_LINES_PER_TARGET, LOG_TRUNCATED_MESSAGE, TargetLogWriter } from './deployment-runner';

// Limite de linhas de log por máquina: um script que escreva sem parar não enche o banco.

function setup() {
  const created: Array<{ level: LogLevel; message: string; timestamp: Date }> = [];
  const prisma = {
    deploymentLog: {
      create: jest.fn(async ({ data }: { data: { level: LogLevel; message: string; timestamp: Date } }) => {
        created.push(data);
      }),
    },
  };
  const writer = new TargetLogWriter(prisma as never, 'alvo-1', new Logger('teste'));
  return { writer, created };
}

describe('TargetLogWriter — limite de linhas por máquina', () => {
  it('o limite é 500 e a mensagem final é a combinada', () => {
    expect(LOG_LINES_PER_TARGET).toBe(500);
    expect(LOG_TRUNCATED_MESSAGE).toBe('Log truncado: limite de 500 linhas.');
  });

  it('abaixo do limite grava tudo, na ordem', async () => {
    const { writer, created } = setup();
    for (let i = 1; i <= 10; i++) writer.write(LogLevel.INFO, `passo ${i}`);
    await writer.flush();
    expect(created.map((c) => c.message)).toEqual(Array.from({ length: 10 }, (_, i) => `passo ${i + 1}`));
  });

  it('ao atingir o limite: 499 linhas + "Log truncado…" como a 500ª, e o resto é ignorado', async () => {
    const { writer, created } = setup();
    for (let i = 1; i <= 800; i++) writer.write(LogLevel.DEBUG, `linha ${i}`);
    writer.write(LogLevel.INFO, 'Instalação concluída (código 0).'); // depois do limite: ignorada
    await writer.flush();

    expect(created).toHaveLength(500);
    expect(created[498].message).toBe('linha 499');
    expect(created[499]).toMatchObject({ level: LogLevel.WARN, message: 'Log truncado: limite de 500 linhas.' });
    expect(created.some((c) => c.message === 'linha 500' || c.message.startsWith('Instalação concluída'))).toBe(false);
    // Os horários continuam estritamente crescentes (a ordem da consulta depende disso).
    for (let i = 1; i < created.length; i++) {
      expect(created[i].timestamp.getTime()).toBeGreaterThan(created[i - 1].timestamp.getTime());
    }
  });

  it('a linha de truncado só é gravada uma vez', async () => {
    const { writer, created } = setup();
    for (let i = 0; i < 2000; i++) writer.write(LogLevel.INFO, 'x');
    await writer.flush();
    expect(created.filter((c) => c.message === LOG_TRUNCATED_MESSAGE)).toHaveLength(1);
  });
});
