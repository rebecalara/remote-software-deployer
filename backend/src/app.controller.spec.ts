import { ServiceUnavailableException } from '@nestjs/common';
import { AppController } from './app.controller';
import { PrismaService } from './prisma/prisma.service';

function setup(queryRaw: jest.Mock) {
  const prisma = { $queryRaw: queryRaw, machine: { count: jest.fn() } };
  return { controller: new AppController(prisma as unknown as PrismaService), prisma };
}

describe('GET /health', () => {
  it('com o banco respondendo: só { status: "ok" }, sem nenhum dado do sistema', async () => {
    const { controller, prisma } = setup(jest.fn().mockResolvedValue([{ '?column?': 1 }]));
    await expect(controller.check()).resolves.toStrictEqual({ status: 'ok' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    // Nada de contagem de máquinas (era público e saiu).
    expect(prisma.machine.count).not.toHaveBeenCalled();
  });

  it('sem banco: 503 com { status: "error" }, sem detalhe do erro (o deploy faz rollback)', async () => {
    const { controller } = setup(jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432')));
    const error = await controller.check().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as ServiceUnavailableException).getResponse()).toStrictEqual({ status: 'error' });
  });
});
