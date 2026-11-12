import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ROLES_KEY } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';

const SYNC = new Date('2026-11-12T10:00:00Z');
const OLD_SYNC = new Date('2026-11-11T10:00:00Z');
const SW_ID = '11111111-1111-4111-8111-111111111111';
const M1 = '22222222-2222-4222-8222-222222222222';
const M2 = '33333333-3333-4333-8333-333333333333';

function softwareRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SW_ID,
    name: '7-Zip',
    version: '26.06',
    installType: 'MSI',
    active: true,
    installerFileName: '0f0e0d0c-0b0a-4908-8706-050403020100.msi',
    ...overrides,
  };
}

function machine(id: string, hostname: string, lastSync: Date | null = SYNC) {
  return { id, hostname, lastSync };
}

function setup() {
  const prisma = {
    software: { findUnique: jest.fn().mockResolvedValue(softwareRow()) },
    machine: {
      findMany: jest.fn().mockResolvedValue([machine(M1, 'WS-002'), machine(M2, 'WS-001')]),
      aggregate: jest.fn().mockResolvedValue({ _max: { lastSync: SYNC } }),
    },
    deployment: {
      create: jest.fn(async ({ data }) => ({
        id: 'dep-1',
        name: data.name,
        status: 'PENDING',
        createdAt: SYNC,
        startedAt: null,
        finishedAt: null,
        software: { id: SW_ID, name: '7-Zip', version: '26.06', installType: 'MSI' },
        user: { username: 'testuser', displayName: 'Test User' },
        targets: [
          { id: 't-1', machineId: M1, status: 'PENDING', startedAt: null, finishedAt: null, exitCode: null, machine: { hostname: 'WS-002' }, logs: [] },
          { id: 't-2', machineId: M2, status: 'PENDING', startedAt: null, finishedAt: null, exitCode: null, machine: { hostname: 'WS-001' }, logs: [] },
        ],
      })),
    },
  };
  const executor = { isAvailable: true, unavailableReason: null as string | null };
  const storage = { isAvailable: true, exists: jest.fn().mockResolvedValue(true) };
  const runner = { enqueue: jest.fn() };
  const service = new DeploymentsService(prisma as never, executor as never, storage as never, runner as never);
  return { prisma, executor, storage, runner, service };
}

const input = (overrides = {}) => ({ softwareId: SW_ID, machineIds: [M1, M2], name: null, ...overrides });

describe('DeploymentsService.create', () => {
  it('cria com as máquinas PENDING, nome gerado, enfileira e devolve na hora', async () => {
    const { prisma, runner, service } = setup();
    const view = await service.create(input(), 'user-1');

    expect(prisma.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: '7-Zip 26.06 — 2 máquinas',
          user: { connect: { id: 'user-1' } },
          software: { connect: { id: SW_ID } },
          targets: { create: [{ machine: { connect: { id: M1 } } }, { machine: { connect: { id: M2 } } }] },
        },
      }),
    );
    expect(runner.enqueue).toHaveBeenCalledWith([
      { targetId: 't-1', machineId: M1 },
      { targetId: 't-2', machineId: M2 },
    ]);
    expect(view).toMatchObject({ id: 'dep-1', status: 'PENDING', requestedBy: { username: 'testuser' } });
    expect(view.targets.map((t) => t.hostname)).toEqual(['WS-001', 'WS-002']); // ordenado por nome
    expect(view.targets[0]).toEqual({
      id: 't-2', machineId: M2, hostname: 'WS-001', status: 'PENDING', startedAt: null, finishedAt: null, exitCode: null, lastLog: null,
    });
  });

  it('enfileira na ordem da seleção, não na ordem em que o banco devolve os alvos', async () => {
    const { runner, service } = setup();
    await service.create(input({ machineIds: [M2, M1] }), 'user-1');
    expect(runner.enqueue).toHaveBeenCalledWith([
      { targetId: 't-2', machineId: M2 },
      { targetId: 't-1', machineId: M1 },
    ]);
  });

  it('usa o nome informado e o singular para uma máquina', async () => {
    const { prisma, service } = setup();
    prisma.machine.findMany.mockResolvedValue([machine(M1, 'WS-002')]);
    await service.create(input({ machineIds: [M1] }), 'user-1');
    expect(prisma.deployment.create.mock.calls[0][0].data.name).toBe('7-Zip 26.06 — 1 máquina');

    await service.create(input({ machineIds: [M1], name: 'Laboratório 2' }), 'user-1');
    expect(prisma.deployment.create.mock.calls[1][0].data.name).toBe('Laboratório 2');
  });

  it('503 com o motivo quando a implantação está indisponível no servidor', async () => {
    const { executor, prisma, service } = setup();
    executor.isAvailable = false;
    executor.unavailableReason = 'a implantação remota exige o backend em Windows (powershell.exe).';
    await expect(service.create(input(), 'u')).rejects.toThrow(
      new ServiceUnavailableException(
        'A implantação remota está indisponível neste servidor: a implantação remota exige o backend em Windows (powershell.exe).',
      ),
    );
    expect(prisma.software.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['inexistente', null, NotFoundException, 'Software não encontrado.'],
    ['desativado', softwareRow({ active: false }), ConflictException, 'Este software está desativado e não pode ser implantado.'],
    ['sem instalador', softwareRow({ installerFileName: null }), ConflictException, 'Este software ainda não tem instalador enviado.'],
  ])('recusa software %s', async (_case, row, type, message) => {
    const { prisma, runner, service } = setup();
    prisma.software.findUnique.mockResolvedValue(row);
    await expect(service.create(input(), 'u')).rejects.toThrow(new (type as typeof ConflictException)(message));
    expect(prisma.deployment.create).not.toHaveBeenCalled();
    expect(runner.enqueue).not.toHaveBeenCalled();
  });

  it('503 sem pasta de instaladores; 409 se o arquivo sumiu da pasta', async () => {
    const { storage, service } = setup();
    storage.isAvailable = false;
    await expect(service.create(input(), 'u')).rejects.toThrow(ServiceUnavailableException);

    storage.isAvailable = true;
    storage.exists.mockResolvedValue(false);
    await expect(service.create(input(), 'u')).rejects.toThrow(ConflictException);
  });

  it('400 no campo machineIds quando uma máquina não existe', async () => {
    const { prisma, service } = setup();
    prisma.machine.findMany.mockResolvedValue([machine(M1, 'WS-002')]);
    const err = await service.create(input(), 'u').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ field: 'machineIds' });
  });

  it('409 listando as máquinas que não apareceram na última sincronização com o AD', async () => {
    const { prisma, service } = setup();
    prisma.machine.findMany.mockResolvedValue([
      machine(M1, 'WS-009', OLD_SYNC),
      machine(M2, 'WS-003', null),
    ]);
    await expect(service.create(input(), 'u')).rejects.toThrow(
      new ConflictException('Máquina(s) não encontrada(s) no AD na última sincronização: WS-003, WS-009.'),
    );
    expect(prisma.deployment.create).not.toHaveBeenCalled();
  });
});

describe('DeploymentsController', () => {
  it('exige JWT e passa pelo RolesGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, DeploymentsController)).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it('criar implantação é para ADMIN e OPERATOR (VIEWER não)', () => {
    const roles = new Reflector().get<UserRole[]>(ROLES_KEY, DeploymentsController.prototype.create);
    expect(roles).toEqual([UserRole.ADMIN, UserRole.OPERATOR]);
  });
});
