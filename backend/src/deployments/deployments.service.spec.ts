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
    deploymentTarget: { findMany: jest.fn().mockResolvedValue([]) },
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
  };
  // Transação de mentira: roda o callback com o próprio objeto (os testes de corrida usam o
  // banco em memória de memorySetup, que respeita a trava de verdade).
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const executor = { isAvailable: true, unavailableReason: null as string | null };
  const storage = { isAvailable: true, exists: jest.fn().mockResolvedValue(true) };
  const runner = { enqueue: jest.fn() };
  const service = new DeploymentsService(prisma as never, executor as never, storage as never, runner as never);
  return { prisma, executor, storage, runner, service };
}

const input = (overrides = {}) => ({
  action: 'INSTALL' as 'INSTALL' | 'UNINSTALL',
  softwareId: SW_ID as string | null,
  productCode: null as string | null,
  programId: null as string | null,
  machineIds: [M1, M2],
  name: null,
  ...overrides,
});

describe('DeploymentsService.create', () => {
  it('cria com as máquinas PENDING, nome gerado, enfileira e devolve na hora', async () => {
    const { prisma, runner, service } = setup();
    const view = await service.create(input(), 'user-1');

    expect(prisma.deployment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: '7-Zip 26.06 — 2 máquinas',
          action: 'INSTALL',
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

const CODE = '{23170F69-40C1-2702-2606-000001000000}';

describe('DeploymentsService.create — implantação igual já em andamento', () => {
  it('409 listando as máquinas (em ordem), sem criar nem enfileirar', async () => {
    const { prisma, runner, service } = setup();
    prisma.deploymentTarget.findMany.mockResolvedValue([
      { machine: { hostname: 'WS-002' } },
      { machine: { hostname: 'WS-001' } },
    ]);
    await expect(service.create(input(), 'u')).rejects.toThrow(
      new ConflictException('Já existe uma implantação igual em andamento em: WS-001, WS-002.'),
    );
    expect(prisma.deployment.create).not.toHaveBeenCalled();
    expect(runner.enqueue).not.toHaveBeenCalled();
  });

  it('procura só alvos PENDING ou RUNNING das máquinas selecionadas, com a mesma ação e o mesmo software', async () => {
    const { prisma, service } = setup();
    await service.create(input(), 'u');
    expect(prisma.deploymentTarget.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          machineId: { in: [M1, M2] },
          status: { in: ['PENDING', 'RUNNING'] },
          deployment: { action: 'INSTALL', softwareId: SW_ID },
        },
      }),
    );
  });

  it('desinstalação: compara pelo ProductCode (pelo catálogo ou pelo inventário, é o mesmo produto)', async () => {
    const { prisma, service } = setup();
    prisma.software.findUnique.mockResolvedValue(softwareRow({ msiProductCode: CODE }));
    await service.create(input({ action: 'UNINSTALL' }), 'u');
    expect(prisma.deploymentTarget.findMany.mock.calls[0][0].where.deployment).toEqual({
      action: 'UNINSTALL',
      productCode: CODE,
    });
  });

  it('trava, checagem e criação na MESMA transação, nessa ordem; enfileira só depois do commit', async () => {
    const { prisma, runner, service } = setup();
    const order: string[] = [];
    const tx = {
      $executeRaw: jest.fn(async () => order.push('trava')),
      deploymentTarget: { findMany: jest.fn(async () => (order.push('checagem'), [])) },
      deployment: {
        create: jest.fn(async (args: unknown) => (order.push('criação'), prisma.deployment.create(args as never))),
      },
    };
    prisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => {
      const result = await fn(tx);
      order.push('commit');
      return result;
    });
    runner.enqueue.mockImplementation(() => order.push('fila'));

    await service.create(input(), 'u');

    expect(order).toEqual(['trava', 'checagem', 'criação', 'commit', 'fila']);
    expect(prisma.deploymentTarget.findMany).not.toHaveBeenCalled(); // tudo pelo tx, nada por fora
  });
});

/**
 * Banco em memória com a trava de verdade: pg_advisory_xact_lock vira um mutex que só é
 * solto no fim da transação. A criação demora um pouco (20 ms), para dois pedidos
 * simultâneos se cruzarem de fato.
 */
function memorySetup() {
  const hostnames: Record<string, string> = { [M1]: 'WS-002', [M2]: 'WS-001' };
  type Dep = { action: string; softwareId: string | null; productCode: string | null; uninstallKey: string | null; uninstallArch: string | null };
  const rows: Array<{ machineId: string; status: string; deployment: Dep }> = [];
  let useLock = true;
  let tail = Promise.resolve();
  const acquire = (): Promise<() => void> => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const previous = tail;
    tail = tail.then(() => held);
    return previous.then(() => release);
  };
  let seq = 0;
  const base = {
    software: { findUnique: jest.fn().mockResolvedValue(softwareRow({ msiProductCode: CODE })) },
    machine: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => machine(id, hostnames[id]))),
      aggregate: jest.fn().mockResolvedValue({ _max: { lastSync: SYNC } }),
    },
    deploymentTarget: {
      findMany: jest.fn(async ({ where }: { where: { machineId: { in: string[] }; status: { in: string[] }; deployment: Partial<Dep> } }) =>
        rows
          .filter(
            (r) =>
              where.machineId.in.includes(r.machineId) &&
              where.status.in.includes(r.status) &&
              Object.entries(where.deployment).every(([k, v]) => r.deployment[k as keyof Dep] === v),
          )
          .map((r) => ({ machine: { hostname: hostnames[r.machineId] } })),
      ),
    },
    deployment: {
      create: jest.fn(async ({ data }: { data: Record<string, any> }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const deployment: Dep = {
          action: data.action,
          softwareId: data.software?.connect.id ?? null,
          productCode: data.productCode ?? null,
          uninstallKey: data.uninstallKey ?? null,
          uninstallArch: data.uninstallArch ?? null,
        };
        const ids: string[] = data.targets.create.map((t: { machine: { connect: { id: string } } }) => t.machine.connect.id);
        ids.forEach((machineId) => rows.push({ machineId, status: 'PENDING', deployment }));
        const n = ++seq;
        return {
          id: `dep-${n}`, name: data.name, action: data.action, status: 'PENDING', createdAt: SYNC, startedAt: null, finishedAt: null,
          software: { id: SW_ID, name: '7-Zip', version: '26.06', installType: 'MSI' },
          user: { username: 'testuser', displayName: null },
          targets: ids.map((machineId, i) => ({
            id: `t-${n}-${i}`, machineId, status: 'PENDING', startedAt: null, finishedAt: null, exitCode: null,
            machine: { hostname: hostnames[machineId] }, logs: [],
          })),
        };
      }),
    },
  };
  const prisma = {
    ...base,
    $transaction: async (fn: (tx: unknown) => unknown) => {
      let release = () => {};
      const tx = {
        ...base,
        $executeRaw: async () => {
          if (useLock) release = await acquire();
          return 0;
        },
      };
      try {
        return await fn(tx);
      } finally {
        release();
      }
    },
  };
  const runner = { enqueue: jest.fn() };
  const service = new DeploymentsService(
    prisma as never,
    { isAvailable: true, unavailableReason: null } as never,
    { isAvailable: true, exists: jest.fn().mockResolvedValue(true) } as never,
    runner as never,
  );
  return { rows, service, runner, withoutLock: () => (useLock = false) };
}

describe('DeploymentsService.create — implantação duplicada (banco em memória com a trava)', () => {
  const duplicate = (hosts: string) => new ConflictException(`Já existe uma implantação igual em andamento em: ${hosts}.`);

  it('pedido repetido: o segundo é recusado', async () => {
    const { service } = memorySetup();
    await service.create(input({ machineIds: [M1] }), 'u');
    await expect(service.create(input({ machineIds: [M1, M2] }), 'u')).rejects.toThrow(duplicate('WS-002'));
  });

  it('dois pedidos simultâneos: só um passa', async () => {
    const { rows, runner, service } = memorySetup();
    const results = await Promise.allSettled([service.create(input(), 'u'), service.create(input(), 'u')]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toEqual(duplicate('WS-001, WS-002'));
    expect(rows).toHaveLength(2); // uma implantação, duas máquinas
    expect(runner.enqueue).toHaveBeenCalledTimes(1);
  });

  it('prova do teste: sem a trava, os dois pedidos simultâneos passariam', async () => {
    const { withoutLock, service } = memorySetup();
    withoutLock();
    const results = await Promise.allSettled([service.create(input(), 'u'), service.create(input(), 'u')]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('máquina diferente passa', async () => {
    const { service } = memorySetup();
    await service.create(input({ machineIds: [M1] }), 'u');
    await expect(service.create(input({ machineIds: [M2] }), 'u')).resolves.toMatchObject({ id: 'dep-2' });
  });

  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED'])('máquina com implantação finalizada (%s) não bloqueia', async (status) => {
    const { rows, service } = memorySetup();
    await service.create(input({ machineIds: [M1] }), 'u');
    rows.forEach((r) => (r.status = status));
    await expect(service.create(input({ machineIds: [M1] }), 'u')).resolves.toMatchObject({ id: 'dep-2' });
  });

  it('em execução (RUNNING) bloqueia como a pendente', async () => {
    const { rows, service } = memorySetup();
    await service.create(input({ machineIds: [M1] }), 'u');
    rows.forEach((r) => (r.status = 'RUNNING'));
    await expect(service.create(input({ machineIds: [M1] }), 'u')).rejects.toThrow(duplicate('WS-002'));
  });

  it('instalar e desinstalar o mesmo software não se bloqueiam; duas desinstalações iguais, sim', async () => {
    const { service } = memorySetup();
    await service.create(input({ machineIds: [M1] }), 'u');
    await expect(service.create(input({ action: 'UNINSTALL', machineIds: [M1] }), 'u')).resolves.toMatchObject({ id: 'dep-2' });
    await expect(service.create(input({ action: 'UNINSTALL', machineIds: [M1] }), 'u')).rejects.toThrow(duplicate('WS-002'));
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
