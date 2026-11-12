import { ConflictException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService, parseListLimit } from './deployments.service';

// Etapa D: consulta, logs por máquina e cancelamento das máquinas pendentes.

const SW_ID = '11111111-1111-4111-8111-111111111111';
const M1 = '22222222-2222-4222-8222-222222222222';
const M2 = '33333333-3333-4333-8333-333333333333';
const DEP = '44444444-4444-4444-8444-444444444444';
const T1 = '55555555-5555-4555-8555-555555555555';
const T2 = '66666666-6666-4666-8666-666666666666';
const T3 = '77777777-7777-4777-8777-777777777777';
const at = (s: number) => new Date(Date.UTC(2026, 10, 12, 10, 0, s));

function depRow(targets: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return {
    id: DEP,
    name: '7-Zip 26.06 — 3 máquinas',
    status: 'RUNNING',
    createdAt: at(0),
    startedAt: at(1),
    finishedAt: null,
    software: { id: SW_ID, name: '7-Zip', version: '26.06', installType: 'MSI' },
    user: { username: 'testuser', displayName: 'Test User' },
    targets,
    ...overrides,
  };
}

function setup() {
  const prisma = {
    deployment: { findMany: jest.fn(), findUnique: jest.fn() },
    deploymentTarget: { findFirst: jest.fn(), updateMany: jest.fn() },
    deploymentLog: { findMany: jest.fn(), createMany: jest.fn() },
  };
  const runner = { enqueue: jest.fn(), finalizeDeployment: jest.fn() };
  const service = new DeploymentsService(prisma as never, {} as never, {} as never, runner as never);
  return { prisma, runner, service };
}

describe('DeploymentsService.list e get', () => {
  it('lista as mais recentes com a contagem por status, sem as máquinas', async () => {
    const { prisma, service } = setup();
    prisma.deployment.findMany.mockResolvedValue([
      depRow([{ status: 'SUCCEEDED' }, { status: 'RUNNING' }, { status: 'PENDING' }, { status: 'FAILED' }]),
    ]);
    const [item] = await service.list(10);

    expect(prisma.deployment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, take: 10 }),
    );
    expect(item.counts).toEqual({ total: 4, pending: 1, running: 1, succeeded: 1, failed: 1, cancelled: 0 });
    expect(item).not.toHaveProperty('targets');
    expect(item).toMatchObject({ id: DEP, startedAt: at(1).toISOString(), finishedAt: null });
  });

  it('detalhe traz cada máquina com o último passo registrado', async () => {
    const { prisma, service } = setup();
    prisma.deployment.findUnique.mockResolvedValue(
      depRow([
        {
          id: T1, machineId: M1, status: 'RUNNING', startedAt: at(2), finishedAt: null, exitCode: null,
          machine: { hostname: 'WS-001' },
          logs: [{ timestamp: at(5), level: 'INFO', message: 'Copiando o instalador (1,5 MB).' }],
        },
        {
          id: T2, machineId: M2, status: 'PENDING', startedAt: null, finishedAt: null, exitCode: null,
          machine: { hostname: 'WS-002' }, logs: [],
        },
      ]),
    );
    const view = await service.get(DEP);

    expect(view.counts).toMatchObject({ total: 2, running: 1, pending: 1 });
    expect(view.targets[0].lastLog).toEqual({
      timestamp: at(5).toISOString(), level: 'INFO', message: 'Copiando o instalador (1,5 MB).',
    });
    expect(view.targets[1].lastLog).toBeNull();
  });

  it('404 para implantação inexistente', async () => {
    const { prisma, service } = setup();
    prisma.deployment.findUnique.mockResolvedValue(null);
    await expect(service.get(DEP)).rejects.toThrow(new NotFoundException('Implantação não encontrada.'));
  });
});

describe('DeploymentsService.logs', () => {
  it('devolve os passos da máquina em ordem, inclusive DEBUG', async () => {
    const { prisma, service } = setup();
    prisma.deploymentTarget.findFirst.mockResolvedValue({ id: T1 });
    prisma.deploymentLog.findMany.mockResolvedValue([
      { timestamp: at(2), level: 'INFO', message: 'a' },
      { timestamp: at(3), level: 'DEBUG', message: 'b' },
    ]);

    expect(await service.logs(DEP, T1)).toEqual([
      { timestamp: at(2).toISOString(), level: 'INFO', message: 'a' },
      { timestamp: at(3).toISOString(), level: 'DEBUG', message: 'b' },
    ]);
    expect(prisma.deploymentTarget.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: T1, deploymentId: DEP } }),
    );
    expect(prisma.deploymentLog.findMany).toHaveBeenCalledWith({
      where: { deploymentTargetId: T1 },
      orderBy: { timestamp: 'asc' },
    });
  });

  it('404 se a máquina não é desta implantação', async () => {
    const { prisma, service } = setup();
    prisma.deploymentTarget.findFirst.mockResolvedValue(null);
    await expect(service.logs(DEP, T2)).rejects.toThrow(
      new NotFoundException('Máquina não encontrada nesta implantação.'),
    );
    expect(prisma.deploymentLog.findMany).not.toHaveBeenCalled();
  });
});

describe('DeploymentsService.cancel', () => {
  it('cancela só as PENDING, registra quem cancelou e tenta fechar a implantação', async () => {
    const { prisma, runner, service } = setup();
    prisma.deployment.findUnique
      .mockResolvedValueOnce(
        depRow([
          { id: T1, status: 'RUNNING' },
          { id: T2, status: 'PENDING' },
          { id: T3, status: 'PENDING' },
        ]),
      )
      .mockResolvedValueOnce(depRow([]));
    // A fila pegou a T3 entre a leitura e o UPDATE: ela segue executando, sem log de cancelada.
    prisma.deploymentTarget.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await service.cancel(DEP, 'testuser');

    expect(prisma.deploymentTarget.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.deploymentTarget.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: T2, status: 'PENDING' },
      data: { status: 'CANCELLED', finishedAt: expect.any(Date) },
    });
    expect(prisma.deploymentLog.createMany).toHaveBeenCalledWith({
      data: [
        {
          deploymentTargetId: T2,
          timestamp: expect.any(Date),
          level: 'WARN',
          message: 'Cancelada por testuser antes de executar.',
        },
      ],
    });
    expect(runner.finalizeDeployment).toHaveBeenCalledWith(DEP);
  });

  it('409 quando só há máquinas em execução (não interrompe instalação em curso)', async () => {
    const { prisma, runner, service } = setup();
    prisma.deployment.findUnique.mockResolvedValue(depRow([{ id: T1, status: 'RUNNING' }]));

    await expect(service.cancel(DEP, 'testuser')).rejects.toThrow(
      new ConflictException(
        'Não há máquinas pendentes para cancelar. As que estão em execução não podem ser interrompidas.',
      ),
    );
    expect(prisma.deploymentTarget.updateMany).not.toHaveBeenCalled();
    expect(prisma.deploymentLog.createMany).not.toHaveBeenCalled();
    expect(runner.finalizeDeployment).not.toHaveBeenCalled();
  });

  it('409 para implantação já terminada; 404 para inexistente', async () => {
    const { prisma, service } = setup();
    prisma.deployment.findUnique.mockResolvedValueOnce(
      depRow([{ id: T1, status: 'SUCCEEDED' }], { finishedAt: at(9) }),
    );
    await expect(service.cancel(DEP, 'u')).rejects.toThrow(new ConflictException('Esta implantação já terminou.'));

    prisma.deployment.findUnique.mockResolvedValueOnce(null);
    await expect(service.cancel(DEP, 'u')).rejects.toThrow(NotFoundException);
  });
});

describe('DeploymentsController — permissões', () => {
  const rolesOf = (method: keyof DeploymentsController) =>
    new Reflector().get<UserRole[] | undefined>(ROLES_KEY, DeploymentsController.prototype[method]);

  it('consultar é para qualquer usuário logado (inclusive VIEWER)', () => {
    expect(rolesOf('list')).toBeUndefined();
    expect(rolesOf('get')).toBeUndefined();
    expect(rolesOf('logs')).toBeUndefined();
  });

  it('cancelar é para ADMIN e OPERATOR', () => {
    expect(rolesOf('cancel')).toEqual([UserRole.ADMIN, UserRole.OPERATOR]);
  });
});

describe('parseListLimit', () => {
  it.each([
    [undefined, 50],
    ['10', 10],
    ['0', 50],
    ['abc', 50],
    ['2.5', 50],
    ['999', 200],
    [['5', '6'], 50],
  ])('%p → %p', (raw, expected) => {
    expect(parseListLimit(raw)).toBe(expected);
  });
});
