import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MachineStatus, UserRole } from '@prisma/client';
import { createServer, type Server } from 'node:net';
import { AddressInfo } from 'node:net';
import { ROLES_KEY } from '../auth/roles.decorator';
import { DashboardService } from '../dashboard/dashboard.service';
import {
  DEFAULT_REACHABILITY_INTERVAL_MINUTES,
  MachineReachabilityScheduler,
  PROBE_PARALLEL,
  PROBE_TIMEOUT_MS,
  WINRM_PORT,
  parseReachabilityInterval,
} from './machine-reachability.scheduler';
import { MachinesController } from './machines.controller';
import { DNS_LOOKUP_PARALLEL, createLookupLimiter, mapWithLimit, probePort } from './port-probe';

// Verificação de quais máquinas respondem no WinRM (porta 5985, só teste de conexão).

const SYNC = new Date('2026-11-20T10:00:00Z');
const OLD = new Date('2026-11-01T10:00:00Z');

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

describe('probePort (sockets de verdade, só na própria máquina)', () => {
  it('porta aberta → respondendo', async () => {
    const server = createServer((s) => s.destroy());
    const port = await listen(server);
    try {
      expect(await probePort('127.0.0.1', port, 1000)).toEqual({ responding: true, outcome: 'connected' });
    } finally {
      server.close();
    }
  });

  it('porta fechada → sem resposta (recusada), sem esperar o tempo limite', async () => {
    const server = createServer();
    const port = await listen(server);
    await new Promise((r) => server.close(r));
    const t0 = Date.now();
    expect(await probePort('127.0.0.1', port, 5000)).toEqual({ responding: false, outcome: 'refused' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('endereço que não responde (192.0.2.1, reservado para documentação) → sem resposta, dentro do limite', async () => {
    const t0 = Date.now();
    const result = await probePort('192.0.2.1', WINRM_PORT, 300);
    // Em geral o pacote some (tempo esgotado); algumas redes (roteador, firewall do CI)
    // recusam na hora. Os dois são "sem resposta" — o que importa é não passar do limite.
    expect(result.responding).toBe(false);
    expect(['timeout', 'refused']).toContain(result.outcome);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('nome que não existe no DNS (.invalid) → sem resposta (dns)', async () => {
    expect(await probePort('rsd-inexistente.invalid', WINRM_PORT, 3000)).toMatchObject({ responding: false });
  });

  it('nenhum byte é enviado: o servidor só vê a conexão abrir e fechar', async () => {
    let received = 0;
    const server = createServer((s) => {
      s.on('data', (d) => (received += d.length));
    });
    const port = await listen(server);
    try {
      await probePort('127.0.0.1', port, 1000);
      await new Promise((r) => setTimeout(r, 100));
      expect(received).toBe(0);
    } finally {
      server.close();
    }
  });
});

describe('probePort: DNS limitado (não trava o DNS do resto do backend)', () => {
  it('no máximo DNS_LOOKUP_PARALLEL (2) consultas de DNS ao mesmo tempo, por mais sondas que rodem', async () => {
    let active = 0;
    let peak = 0;
    const slowFail = jest.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      throw Object.assign(new Error('não encontrado'), { code: 'ENOTFOUND' });
    });
    const lookup = createLookupLimiter(DNS_LOOKUP_PARALLEL, slowFail);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => probePort(`ws-${i}`, WINRM_PORT, 1000, lookup)));
    expect(DNS_LOOKUP_PARALLEL).toBe(2);
    expect(peak).toBe(2);
    expect(results.every((r) => r.outcome === 'dns' && !r.responding)).toBe(true);
  });

  it('o tempo limite vale só para a conexão: esperar a vez no DNS não vira "sem resposta"', async () => {
    const server = createServer((s) => s.destroy());
    const port = await listen(server);
    try {
      const slowOk = async () => {
        await new Promise((r) => setTimeout(r, 300)); // mais que o tempo limite abaixo
        return '127.0.0.1';
      };
      expect(await probePort('maquina-lenta-no-dns', port, 100, slowOk)).toEqual({ responding: true, outcome: 'connected' });
    } finally {
      server.close();
    }
  });

  it('endereço IP não passa pelo DNS', async () => {
    const lookup = jest.fn();
    await probePort('127.0.0.1', 1, 500, lookup);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('mapWithLimit', () => {
  it('no máximo N ao mesmo tempo, resultado na ordem dos itens e progresso por item', async () => {
    let active = 0;
    let peak = 0;
    let done = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    const out = await mapWithLimit(
      items,
      7,
      async (i) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, (i * 7) % 5));
        active--;
        return i * 2;
      },
      () => done++,
    );
    expect(peak).toBe(7);
    expect(out).toEqual(items.map((i) => i * 2));
    expect(done).toBe(50);
  });

  it('lista vazia: nada a fazer', async () => {
    expect(await mapWithLimit([], 20, async () => 1)).toEqual([]);
  });
});

describe('parseReachabilityInterval', () => {
  it.each([
    [undefined, 15],
    ['', 15],
    ['15', 15],
    ['0', 0], // desliga a automática
    ['5', 5],
    ['3', 5], // mínimo
    ['1440', 1440],
    ['5000', 1440], // teto
    ['-1', 15],
    ['abc', 15],
    ['7.5', 15],
  ])('%p → %p', (raw, expected) => {
    expect(parseReachabilityInterval(raw)).toBe(expected);
  });

  it('padrão de 15 min, tempo limite de 2 s e até 20 ao mesmo tempo (decisões aprovadas)', () => {
    expect(DEFAULT_REACHABILITY_INTERVAL_MINUTES).toBe(15);
    expect(PROBE_TIMEOUT_MS).toBe(2000);
    expect(PROBE_PARALLEL).toBe(20);
    expect(WINRM_PORT).toBe(5985);
  });
});

describe('MachineReachabilityScheduler', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));
  const ORIGINAL_ENV = process.env;
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.useRealTimers();
  });

  function setup(options: { available?: boolean; interval?: string; machines?: Array<{ id: string; hostname: string; lastSync: Date }> } = {}) {
    process.env = { ...ORIGINAL_ENV, MACHINE_REACHABILITY_INTERVAL_MINUTES: options.interval ?? '15' };
    const machines = options.machines ?? [
      { id: 'vm', hostname: 'RSD-ALVO-01', lastSync: SYNC },
      { id: 'f1', hostname: 'WS-FIN-001', lastSync: SYNC },
      { id: 'f2', hostname: 'WS-RH-001', lastSync: SYNC },
      { id: 'old', hostname: 'SAIU-DO-AD', lastSync: OLD },
    ];
    const updates: Array<{ where: { id: { in: string[] } }; data: { status: MachineStatus; statusCheckedAt: Date } }> = [];
    const prisma = {
      machine: {
        aggregate: jest.fn(async () => ({ _max: { lastSync: machines.length ? new Date(Math.max(...machines.map((m) => m.lastSync.getTime()))) : null } })),
        findMany: jest.fn(async ({ where }: { where: { lastSync: Date } }) =>
          machines.filter((m) => m.lastSync.getTime() === where.lastSync.getTime()).map(({ id, hostname }) => ({ id, hostname })),
        ),
        updateMany: jest.fn((args) => {
          updates.push(args);
          return args;
        }),
      },
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    };
    const executor = {
      isAvailable: options.available ?? true,
      unavailableReason: options.available === false ? 'a implantação remota exige o backend em Windows (powershell.exe).' : null,
    };
    const scheduler = new MachineReachabilityScheduler(prisma as never, executor as never);
    const probed: string[] = [];
    scheduler.probe = jest.fn(async (host: string, port: number, timeout: number) => {
      probed.push(`${host}:${port}:${timeout}`);
      return host === 'RSD-ALVO-01' ? { responding: true, outcome: 'connected' as const } : { responding: false, outcome: 'dns' as const };
    });
    return { prisma, scheduler, updates, probed };
  }

  it('verifica só as máquinas presentes no AD, na porta 5985 com 2 s, e grava em dois lotes com a mesma data', async () => {
    const { scheduler, updates, probed } = setup();
    const result = await scheduler.run('MANUAL');
    expect(probed.sort()).toEqual(['RSD-ALVO-01:5985:2000', 'WS-FIN-001:5985:2000', 'WS-RH-001:5985:2000']);
    expect(result).toMatchObject({ total: 3, responding: 1, notResponding: 2 });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ where: { id: { in: ['vm'] } }, data: { status: MachineStatus.ONLINE } });
    expect(updates[1].where.id.in.sort()).toEqual(['f1', 'f2']);
    expect(updates[1].data.status).toBe(MachineStatus.OFFLINE);
    expect(updates[0].data.statusCheckedAt).toBe(updates[1].data.statusCheckedAt);
    expect(result.checkedAt).toBe(updates[0].data.statusCheckedAt.toISOString());
  });

  it('nunca sincronizado: nenhuma máquina verificada, nada quebra', async () => {
    const { scheduler, probed } = setup({ machines: [] });
    expect(await scheduler.run('MANUAL')).toMatchObject({ total: 0, responding: 0 });
    expect(probed).toEqual([]);
  });

  it('uma sonda que lança conta como "sem resposta" e não para a rodada', async () => {
    const { scheduler, updates } = setup();
    scheduler.probe = jest.fn(async (host: string) => {
      if (host === 'WS-FIN-001') throw new Error('boom');
      return { responding: true, outcome: 'connected' as const };
    });
    const result = await scheduler.run('MANUAL');
    expect(result).toMatchObject({ total: 3, responding: 2, notResponding: 1 });
    expect(updates[1].where.id.in).toEqual(['f1']);
  });

  it('"Verificar agora" responde na hora com a rodada em andamento e o progresso; uma segunda dá 409', async () => {
    const { scheduler } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    scheduler.probe = jest.fn(async () => {
      await gate;
      return { responding: true, outcome: 'connected' as const };
    });
    const started = scheduler.start('MANUAL');
    expect(started.running).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(scheduler.getStatus().progress).toEqual({ checked: 0, total: 3 });
    expect(() => scheduler.start('MANUAL')).toThrow(ConflictException);
    release();
    for (let i = 0; i < 20 && scheduler.getStatus().running; i++) await new Promise((r) => setImmediate(r));
    const status = scheduler.getStatus();
    expect(status).toMatchObject({ running: false, progress: null, lastTrigger: 'MANUAL', lastResult: { total: 3, responding: 3 } });
  });

  it('agenda a próxima a cada 15 min ao fim de cada rodada; "Verificar agora" reinicia a contagem', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-20T12:00:00Z'), doNotFake: ['setImmediate', 'nextTick'] });
    const { scheduler } = setup();
    await scheduler.run('STARTUP');
    expect(scheduler.getStatus().nextRunAt).toBe('2026-11-20T12:15:00.000Z');
    jest.setSystemTime(new Date('2026-11-20T12:10:00Z'));
    await scheduler.run('MANUAL');
    expect(scheduler.getStatus().nextRunAt).toBe('2026-11-20T12:25:00.000Z');
    scheduler.onModuleDestroy();
  });

  it('intervalo 0: sem verificação automática, mas o botão continua valendo', async () => {
    const { scheduler } = setup({ interval: '0' });
    expect(scheduler.getStatus()).toMatchObject({ autoCheckEnabled: false, intervalMinutes: 0 });
    await scheduler.run('MANUAL');
    expect(scheduler.getStatus().nextRunAt).toBeNull();
  });

  it('modo demonstração (sem WinRM): desligada, com o motivo; botão 503; nada verificado na subida', async () => {
    const { scheduler, probed, prisma } = setup({ available: false });
    expect(scheduler.getStatus()).toMatchObject({
      available: false,
      autoCheckEnabled: false,
      unavailableReason: 'a implantação remota exige o backend em Windows (powershell.exe).',
    });
    expect(() => scheduler.start('MANUAL')).toThrow(ServiceUnavailableException);
    scheduler.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    expect(probed).toEqual([]);
    expect(prisma.machine.updateMany).not.toHaveBeenCalled();
  });

  it('"Verificar agora" só para ADMIN e OPERATOR; o status, para qualquer usuário logado', () => {
    const reflector = new Reflector();
    expect(reflector.get<UserRole[]>(ROLES_KEY, MachinesController.prototype.checkReachability)).toEqual([UserRole.ADMIN, UserRole.OPERATOR]);
    expect(reflector.get<UserRole[] | undefined>(ROLES_KEY, MachinesController.prototype.reachabilityStatus)).toBeUndefined();
  });
});

describe('Dashboard: "N de M respondendo no WinRM"', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));
  const CHECKED = new Date('2026-11-20T11:55:00Z');

  function setup(available = true) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      machine: {
        count: jest.fn((args?: { where?: { status?: string } }) => Promise.resolve(args?.where?.status ? 1 : args?.where ? 15 : 16)),
        aggregate: jest.fn((args?: { _max: Record<string, true> }) =>
          Promise.resolve(args?._max.statusCheckedAt ? { _max: { statusCheckedAt: CHECKED } } : { _max: { lastSync: SYNC } }),
        ),
      },
      deployment: { findMany: jest.fn().mockResolvedValue([]) },
      software: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const deployments = {
      summary: jest.fn().mockResolvedValue({
        activeDeployments: 0, runningTargets: 0, pendingTargets: 0, windowHours: 24,
        finishedInWindow: { succeeded: 0, failed: 0, cancelled: 0 },
      }),
    };
    const executor = { isAvailable: available, unavailableReason: available ? null : 'exige Windows.' };
    const ldap = { checkServiceAccount: jest.fn().mockResolvedValue(undefined) };
    return { prisma, service: new DashboardService(prisma as never, deployments as never, executor as never, ldap as never) };
  }

  it('conta só as presentes no AD, respondendo, e a data da última verificação', async () => {
    const { prisma, service } = setup();
    const view = await service.overview();
    expect(view.reachability).toEqual({ available: true, detail: null, responding: 1, total: 15, checkedAt: CHECKED.toISOString() });
    expect(prisma.machine.count).toHaveBeenCalledWith({ where: { lastSync: SYNC, status: 'ONLINE', statusCheckedAt: { not: null } } });
  });

  it('modo demonstração: desligada, com o motivo e sem números enganosos', async () => {
    const { service } = setup(false);
    expect((await service.overview()).reachability).toEqual({ available: false, detail: 'exige Windows.', responding: 0, total: 15, checkedAt: null });
  });
});
