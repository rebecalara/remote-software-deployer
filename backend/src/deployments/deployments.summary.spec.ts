import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService, SUMMARY_WINDOW_HOURS } from './deployments.service';

// Bloco 5: contadores do painel de Monitoramento (GET /deployments/summary).

function setup() {
  const prisma = {
    deployment: { count: jest.fn(), groupBy: jest.fn() },
    deploymentTarget: { groupBy: jest.fn() },
  };
  const service = new DeploymentsService(prisma as never, {} as never, {} as never, {} as never);
  return { prisma, service };
}

describe('DeploymentsService.summary', () => {
  it('conta implantações abertas, máquinas em execução/fila e encerradas nas últimas 24 h', async () => {
    const { prisma, service } = setup();
    // 1ª contagem: abertas; 2ª: parciais na janela (FAILED com alguma máquina concluída).
    prisma.deployment.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    prisma.deploymentTarget.groupBy.mockResolvedValue([
      { status: 'RUNNING', _count: { _all: 3 } },
      { status: 'PENDING', _count: { _all: 7 } },
    ]);
    prisma.deployment.groupBy.mockResolvedValue([
      { status: 'SUCCEEDED', _count: { _all: 5 } },
      { status: 'FAILED', _count: { _all: 3 } },
    ]);
    const now = new Date('2026-11-14T12:00:00Z');

    expect(await service.summary(now)).toEqual({
      activeDeployments: 2,
      runningTargets: 3,
      pendingTargets: 7,
      windowHours: 24,
      // 3 FAILED no banco: 1 parcial e 2 em que nenhuma máquina concluiu.
      finishedInWindow: { succeeded: 5, partial: 1, failed: 2, cancelled: 0 },
    });
    expect(prisma.deployment.count).toHaveBeenCalledWith({ where: { finishedAt: null } });
    expect(prisma.deployment.count).toHaveBeenCalledWith({
      where: {
        finishedAt: { gte: new Date('2026-11-13T12:00:00Z') },
        status: 'FAILED',
        targets: { some: { status: 'SUCCEEDED' } },
      },
    });
    expect(prisma.deployment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { finishedAt: { gte: new Date('2026-11-13T12:00:00Z') } } }),
    );
    expect(SUMMARY_WINDOW_HOURS).toBe(24);
  });

  it('sem nada no banco, tudo zero', async () => {
    const { prisma, service } = setup();
    prisma.deployment.count.mockResolvedValue(0);
    prisma.deploymentTarget.groupBy.mockResolvedValue([]);
    prisma.deployment.groupBy.mockResolvedValue([]);
    expect(await service.summary()).toMatchObject({
      activeDeployments: 0,
      runningTargets: 0,
      pendingTargets: 0,
      finishedInWindow: { succeeded: 0, partial: 0, failed: 0, cancelled: 0 },
    });
  });
});

describe('DeploymentsController.summary', () => {
  it('é leitura para qualquer usuário logado', () => {
    expect(new Reflector().get<UserRole[] | undefined>(ROLES_KEY, DeploymentsController.prototype.summary)).toBeUndefined();
  });

  it('é declarada ANTES de :id (senão ":id" capturaria "summary")', () => {
    const methods = Object.getOwnPropertyNames(DeploymentsController.prototype);
    expect(methods.indexOf('summary')).toBeGreaterThan(-1);
    expect(methods.indexOf('summary')).toBeLessThan(methods.indexOf('get'));
    expect(Reflect.getMetadata(PATH_METADATA, DeploymentsController.prototype.summary)).toBe('summary');
  });
});
