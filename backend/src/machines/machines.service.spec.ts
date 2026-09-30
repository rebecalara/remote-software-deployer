import { MachineStatus } from '@prisma/client';
import { MachinesService } from './machines.service';
import { PrismaService } from '../prisma/prisma.service';

describe('MachinesService', () => {
  const lastSyncRun = new Date('2026-09-24T10:00:00Z');
  const olderSync = new Date('2026-09-20T10:00:00Z');

  function machine(hostname: string, lastSync: Date | null) {
    return {
      id: `id-${hostname}`,
      hostname,
      ipAddress: null,
      operatingSystem: 'Windows 11 Pro',
      department: 'TI',
      status: MachineStatus.UNKNOWN,
      lastSync,
    };
  }

  let prisma: { machine: { findMany: jest.Mock; aggregate: jest.Mock } };
  let service: MachinesService;

  beforeEach(() => {
    prisma = {
      machine: {
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _max: { lastSync: lastSyncRun } }),
      },
    };
    service = new MachinesService(prisma as unknown as PrismaService);
  });

  it('marca seenInLastSync conforme o lastSync da máquina bate com a última sincronização', async () => {
    prisma.machine.findMany.mockResolvedValue([
      machine('WS-ATUAL', lastSyncRun),
      machine('WS-SUMIU', olderSync),
      machine('WS-NUNCA', null),
    ]);

    const result = await service.list();

    expect(result.lastSyncAt).toBe(lastSyncRun.toISOString());
    expect(result.machines.map((m) => [m.hostname, m.seenInLastSync])).toEqual([
      ['WS-ATUAL', true],
      ['WS-SUMIU', false],
      ['WS-NUNCA', false],
    ]);
  });

  it('primeira sincronização: todas as máquinas gravadas por ela aparecem como vistas', async () => {
    // A sync grava o mesmo syncedAt em todas; logo, o MAX(lastSync) é esse mesmo valor.
    const firstSync = new Date('2026-09-24T12:00:00.123Z');
    prisma.machine.aggregate.mockResolvedValue({ _max: { lastSync: firstSync } });
    prisma.machine.findMany.mockResolvedValue([
      machine('WS-A', new Date(firstSync)),
      machine('WS-B', new Date(firstSync)),
      machine('WS-C', new Date(firstSync)),
    ]);

    const result = await service.list();

    expect(result.machines.every((m) => m.seenInLastSync)).toBe(true);
  });

  it('retorna lastSyncAt nulo quando nunca houve sincronização', async () => {
    prisma.machine.aggregate.mockResolvedValue({ _max: { lastSync: null } });
    const result = await service.list();
    expect(result).toEqual({ machines: [], lastSyncAt: null });
  });

  it('sem busca, lista tudo ordenado por hostname', async () => {
    await service.list();
    expect(prisma.machine.findMany).toHaveBeenCalledWith({ where: {}, orderBy: { hostname: 'asc' } });
  });

  it('com busca, filtra por hostname, setor ou SO sem diferenciar maiúsculas', async () => {
    await service.list('  saude ');
    const { where } = prisma.machine.findMany.mock.calls[0][0];
    expect(where.OR).toEqual([
      { hostname: { contains: 'saude', mode: 'insensitive' } },
      { department: { contains: 'saude', mode: 'insensitive' } },
      { operatingSystem: { contains: 'saude', mode: 'insensitive' } },
    ]);
  });

  it('busca só com espaços é tratada como sem busca', async () => {
    await service.list('   ');
    expect(prisma.machine.findMany.mock.calls[0][0].where).toEqual({});
  });
});
