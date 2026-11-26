import { Logger } from '@nestjs/common';
import { DeploymentStatus as S } from '@prisma/client';
import { DeploymentRunner, MachineChangedEvent, mayHaveChangedMachine } from '../deployments/deployment-runner';
import { DeployResult } from '../deployments/powershell-executor';
import { createInMemoryPrisma } from '../deployments/testing/in-memory-prisma';
import { InventoryService, MAX_CONCURRENT_INVENTORIES } from './inventory.service';

// Inventário refeito sozinho depois de cada implantação (em segundo plano).

const FILE = '0f0e0d0c-0b0a-4908-8706-050403020100.msi';
const fail = (phase: string, reason: string, exitCode?: number | null) =>
  ({ ok: false, phase, reason, message: 'x', ...(exitCode === undefined ? {} : { exitCode }) }) as DeployResult;

describe('mayHaveChangedMachine', () => {
  it.each<[string, DeployResult, boolean]>([
    ['sucesso com código', { ok: true, exitCode: 0 }, true],
    ['já instalado', { ok: true, alreadyInstalled: true, productCode: '{X}' }, true],
    ['não estava instalado', { ok: true, notInstalled: true, productCode: null }, true],
    ['comando do fabricante: saiu do registro', { ok: true, removed: true, exitCode: 0 }, true],
    ['falha com código de saída (ex.: 1603)', fail('install', 'unexpected', 1603), true],
    ['tempo esgotado na instalação', fail('install', 'install-timeout'), true],
    ['tempo esgotado na desinstalação', fail('uninstall', 'uninstall-timeout'), true],
    ['ainda registrado depois do desinstalador', fail('confirm', 'still-installed', 0), true],
    ['processo do PowerShell travado (pode ter instalado)', fail('executor', 'watchdog-timeout'), true],
    ['DNS', fail('resolve', 'dns'), false],
    ['sem resposta', fail('connect', 'unreachable'), false],
    ['WinRM recusado', fail('connect', 'winrm-refused'), false],
    ['acesso negado', fail('connect', 'access-denied'), false],
    ['entrada inválida / desligado', fail('validate', 'invalid-input'), false],
    ['falha na cópia', fail('copy', 'smb-failed'), false],
    ['hash diferente (não executou)', fail('verify', 'hash-mismatch'), false],
    ['comando do fabricante alterado (não executou)', fail('check', 'command-changed'), false],
    ['powershell.exe não iniciou', fail('executor', 'spawn-failed'), false],
  ])('%s → %s', (_name, result, expected) => {
    expect(mayHaveChangedMachine(result)).toBe(expected);
  });
});

describe('DeploymentRunner avisa quando a máquina pode ter mudado', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

  function setup(result: DeployResult) {
    const db = createInMemoryPrisma();
    db.software.set('sw', {
      id: 'sw', name: '7-Zip', version: '26.06', installType: 'MSI', installArgs: [],
      installerFileName: FILE, installerSizeBytes: 1, installerSha256: 'A'.repeat(64),
    });
    db.deployments.set('d1', { id: 'd1', softwareId: 'sw', userId: 'quem-pediu', status: S.PENDING, startedAt: null, finishedAt: null });
    db.machines.set('m1', { id: 'm1', hostname: 'WS-001' });
    db.targets.set('t1', { id: 't1', deploymentId: 'd1', machineId: 'm1', status: S.PENDING, startedAt: null, finishedAt: null, exitCode: null });
    const executor = { isAvailable: true, run: jest.fn().mockResolvedValue(result) };
    const storage = { exists: jest.fn().mockResolvedValue(true), localPath: (n: string) => `C:\\x\\${n}` };
    const runner = new DeploymentRunner(db.prisma as never, executor as never, storage as never);
    const events: MachineChangedEvent[] = [];
    runner.onMachineChanged((e) => events.push(e));
    return { db, runner, events };
  }

  it('sucesso: avisa com a máquina e quem pediu a implantação, depois de gravar o status', async () => {
    const { db, runner, events } = setup({ ok: true, exitCode: 0 });
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });
    expect(events).toEqual([{ machineId: 'm1', hostname: 'WS-001', userId: 'quem-pediu' }]);
    expect(db.targets.get('t1')!.status).toBe(S.SUCCEEDED);
  });

  it('falha de conexão: não avisa', async () => {
    const { db, runner, events } = setup(fail('connect', 'unreachable'));
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });
    expect(events).toEqual([]);
    expect(db.targets.get('t1')!.status).toBe(S.FAILED);
  });

  it('falha depois de executar (1603): avisa', async () => {
    const { runner, events } = setup(fail('install', 'unexpected', 1603));
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });
    expect(events).toHaveLength(1);
  });

  it('cancelada antes de executar: não avisa', async () => {
    const { db, runner, events } = setup({ ok: true, exitCode: 0 });
    db.targets.get('t1')!.status = S.CANCELLED;
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });
    expect(events).toEqual([]);
  });

  it('ouvinte que lança não muda o resultado da implantação', async () => {
    const { db, runner } = setup({ ok: true, exitCode: 0 });
    runner.onMachineChanged(() => {
      throw new Error('boom');
    });
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });
    expect(db.targets.get('t1')!.status).toBe(S.SUCCEEDED);
    expect(db.deployments.get('d1')!.status).toBe(S.SUCCEEDED);
  });
});

describe('InventoryService.refreshAfterDeployment', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));
  const SYNC = new Date('2026-11-19T10:00:00Z');
  const ITEMS = [{ name: '7-Zip', version: '26.06', publisher: null, installDate: null, productCode: null, arch: '64' }];
  const ev = (n: number, userId = 'quem-pediu'): MachineChangedEvent => ({ machineId: `m${n}`, hostname: `WS-${n}`, userId });

  function setup(executorOverrides: Record<string, unknown> = {}) {
    const prisma = {
      machine: {
        findUnique: jest.fn(async ({ where }) => ({ id: where.id, hostname: 'H', lastSync: SYNC })),
        aggregate: jest.fn().mockResolvedValue({ _max: { lastSync: SYNC } }),
      },
      machineInventory: {
        upsert: jest.fn(async ({ create }) => ({ ...create, collectedBy: { username: 'u', displayName: null } })),
      },
      software: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const executor = {
      isInventoryAvailable: true,
      inventoryUnavailableReason: null as string | null,
      inventory: jest.fn().mockResolvedValue({ ok: true, items: ITEMS }),
      ...executorOverrides,
    };
    const listeners: Array<(e: MachineChangedEvent) => void> = [];
    const runner = { onMachineChanged: (l: (e: MachineChangedEvent) => void) => listeners.push(l) };
    const service = new InventoryService(prisma as never, executor as never, runner as never);
    service.onModuleInit();
    return { prisma, executor, service, notify: (e: MachineChangedEvent) => listeners.forEach((l) => l(e)) };
  }

  it('se inscreve no runner e grava a foto com collectedBy = quem pediu a implantação', async () => {
    const { prisma, executor, service, notify } = setup();
    notify(ev(1));
    await service.whenRefreshIdle();
    expect(executor.inventory).toHaveBeenCalledWith('WS-1');
    expect(prisma.machineInventory.upsert.mock.calls[0][0]).toMatchObject({
      where: { machineId: 'm1' },
      create: { machineId: 'm1', collectedById: 'quem-pediu', items: ITEMS },
      update: { collectedById: 'quem-pediu', items: ITEMS },
    });
  });

  it('falha na consulta: só log, nada gravado (a última foto fica), sem lançar', async () => {
    const { prisma, service, notify } = setup({
      inventory: jest.fn().mockResolvedValue({ ok: false, reason: 'unreachable', message: 'não respondeu' }),
    });
    expect(() => notify(ev(1))).not.toThrow();
    await service.whenRefreshIdle();
    expect(prisma.machineInventory.upsert).not.toHaveBeenCalled();

    const broken = setup({ inventory: jest.fn().mockRejectedValue(new Error('boom')) });
    broken.notify(ev(1));
    await broken.service.whenRefreshIdle();
    expect(broken.prisma.machineInventory.upsert).not.toHaveBeenCalled();
  });

  it('modo demonstração: não faz nada', async () => {
    const { executor, service, notify } = setup({ isInventoryAvailable: false, inventoryUnavailableReason: 'exige Windows.' });
    notify(ev(1));
    await service.whenRefreshIdle();
    expect(executor.inventory).not.toHaveBeenCalled();
  });

  it('com consulta em andamento na máquina, não duplica', async () => {
    let release!: () => void;
    const pending = new Promise((r) => (release = () => r({ ok: true, items: ITEMS })));
    const { executor, service, notify } = setup({ inventory: jest.fn(() => pending) });
    const manual = service.collect('m1', 'u', 'testuser');
    await new Promise((r) => setImmediate(r));
    notify(ev(1));
    notify(ev(1));
    release();
    await manual;
    await service.whenRefreshIdle();
    expect(executor.inventory).toHaveBeenCalledTimes(1);
  });

  it('respeita o limite: a sexta espera vaga e roda quando uma termina; repetidas da mesma máquina viram uma', async () => {
    const releases: Array<() => void> = [];
    const inventory = jest.fn(() => new Promise((r) => releases.push(() => r({ ok: true, items: ITEMS }))));
    const { prisma, service, notify } = setup({ inventory });
    for (let n = 1; n <= MAX_CONCURRENT_INVENTORIES; n++) notify(ev(n));
    notify(ev(6, 'primeiro'));
    notify(ev(6, 'segundo')); // a mais recente vale
    await new Promise((r) => setImmediate(r));
    expect(inventory).toHaveBeenCalledTimes(MAX_CONCURRENT_INVENTORIES);

    // Enquanto as automáticas ocupam as vagas, a manual continua recebendo 429.
    const manual = await service.collect('m9', 'u', 'testuser').catch((e) => e);
    expect(manual.getStatus()).toBe(429);

    releases[0]();
    for (let i = 0; i < 20 && inventory.mock.calls.length < 6; i++) await new Promise((r) => setTimeout(r, 1));
    expect(inventory).toHaveBeenCalledTimes(6);
    expect(inventory).toHaveBeenLastCalledWith('WS-6');
    releases.slice(1).forEach((r) => r());
    await service.whenRefreshIdle();
    expect(inventory).toHaveBeenCalledTimes(6);
    const m6 = prisma.machineInventory.upsert.mock.calls.find((c) => c[0].where.machineId === 'm6')![0];
    expect(m6.create.collectedById).toBe('segundo');
  });

  it('consulta manual da máquina que esperava vaga vale pela automática', async () => {
    const releases: Array<() => void> = [];
    const inventory = jest.fn(() => new Promise((r) => releases.push(() => r({ ok: true, items: ITEMS }))));
    const { service, notify } = setup({ inventory });
    for (let n = 1; n <= MAX_CONCURRENT_INVENTORIES; n++) notify(ev(n));
    notify(ev(6));
    await new Promise((r) => setImmediate(r));
    releases[0]();
    // A vaga liberada vai para a automática da m6; a manual da m6 recebe 409 (já em consulta).
    for (let i = 0; i < 20 && inventory.mock.calls.length < 6; i++) await new Promise((r) => setTimeout(r, 1));
    await expect(service.collect('m6', 'u', 'testuser')).rejects.toThrow('Já existe uma consulta em andamento');
    releases.slice(1).forEach((r) => r());
    await service.whenRefreshIdle();
    expect(inventory).toHaveBeenCalledTimes(6);
  });
});
