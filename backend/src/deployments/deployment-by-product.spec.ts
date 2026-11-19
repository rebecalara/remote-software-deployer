import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DeploymentStatus as S, LogLevel, UserRole } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { ROLES_KEY } from '../auth/roles.decorator';
import { InventoryController, parseSummaryBody } from '../inventory/inventory.controller';
import { INVENTORY_STALE_DAYS, InventoryService } from '../inventory/inventory.service';
import { DeploymentRunner } from './deployment-runner';
import { OUTSIDE_CATALOG, parseDeploymentListQuery, validateDeploymentCreate } from './deployment-validation';
import { DeploymentsService, deploymentListWhere, toSummaryView } from './deployments.service';
import { DeployEvent, DeployResult, DeployTargetInput, INVENTORY_SCRIPT_PATH } from './powershell-executor';
import { createInMemoryPrisma } from './testing/in-memory-prisma';

// Desinstalação pelo inventário, inclusive de MSI fora do catálogo (aprovada pela autora).

const PUTTY = '{11111111-2222-3333-4444-555555555555}';
const ZIP = '{23170F69-40C1-2702-2606-000001000000}';
const SW = '11111111-1111-4111-8111-111111111111';
const M1 = '22222222-2222-4222-8222-222222222222';
const M2 = '33333333-3333-4333-8333-333333333333';
const SYNC = new Date('2026-11-20T10:00:00Z');

describe('validateDeploymentCreate — por ProductCode', () => {
  const field = (body: Record<string, unknown>) => {
    try {
      validateDeploymentCreate({ machineIds: [M1], ...body });
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      return ((err as BadRequestException).getResponse() as { field: string }).field;
    }
    throw new Error('deveria ter recusado');
  };

  it('desinstalar por ProductCode (normalizado em maiúsculas), sem software do catálogo', () => {
    expect(validateDeploymentCreate({ action: 'UNINSTALL', productCode: PUTTY.toLowerCase(), machineIds: [M1] })).toMatchObject({
      action: 'UNINSTALL',
      softwareId: null,
      productCode: PUTTY,
    });
  });

  it.each([
    [{ action: 'INSTALL', productCode: PUTTY }, 'productCode'],
    [{ productCode: PUTTY }, 'productCode'],
    [{ action: 'UNINSTALL', productCode: PUTTY, softwareId: SW }, 'productCode'],
    [{ action: 'UNINSTALL', productCode: '{x}; Remove-Item' }, 'productCode'],
    [{ action: 'UNINSTALL' }, 'softwareId'],
  ])('recusa %p no campo %p', (body, expected) => {
    expect(field(body)).toBe(expected);
  });
});

describe('Histórico — filtro "Fora do catálogo"', () => {
  it('softwareId=none → implantações sem software do catálogo', () => {
    expect(parseDeploymentListQuery({ softwareId: OUTSIDE_CATALOG }).softwareId).toBe('none');
    expect(deploymentListWhere(parseDeploymentListQuery({ softwareId: 'none' }), 'u')).toEqual({ softwareId: null });
  });
});

describe('DeploymentsService.create — desinstalação pelo inventário', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

  function setup(options: { catalog?: Record<string, unknown> | null } = {}) {
    const prisma = {
      machine: {
        findMany: jest.fn().mockResolvedValue([
          { id: M1, hostname: 'RSD-ALVO-01', lastSync: SYNC },
          { id: M2, hostname: 'WS-FIN-001', lastSync: SYNC },
        ]),
        aggregate: jest.fn().mockResolvedValue({ _max: { lastSync: SYNC } }),
      },
      machineInventory: {
        // A mais recente primeiro (o service pede orderBy collectedAt desc).
        findMany: jest.fn().mockResolvedValue([
          { items: [{ name: 'PuTTY release 0.85 (64-bit)', version: '0.85.0.0', publisher: 'Simon Tatham', productCode: PUTTY }] },
          { items: [{ name: 'PuTTY (nome antigo)', version: '0.84', publisher: null, productCode: PUTTY }] },
        ]),
      },
      software: {
        findFirst: jest.fn().mockResolvedValue(options.catalog ?? null),
        findUnique: jest.fn(),
      },
      deployment: {
        create: jest.fn(async ({ data }) => ({
          id: 'dep-1',
          ...data,
          softwareId: data.software?.connect.id ?? null,
          status: 'PENDING',
          createdAt: SYNC,
          startedAt: null,
          finishedAt: null,
          software: data.software ? { id: data.software.connect.id, name: '7-Zip', version: '26.06', installType: 'MSI' } : null,
          user: { username: 'testuser', displayName: null },
          targets: [],
        })),
      },
    };
    const service = new DeploymentsService(
      prisma as never,
      { isAvailable: true, unavailableReason: null } as never,
      { isAvailable: true, exists: jest.fn() } as never,
      { enqueue: jest.fn() } as never,
    );
    const input = { action: 'UNINSTALL' as const, softwareId: null, productCode: PUTTY, machineIds: [M1, M2], name: null };
    return { prisma, service, input };
  }

  it('fora do catálogo: sem software, com a cópia do produto tirada do inventário MAIS RECENTE (nunca do navegador)', async () => {
    const { prisma, service, input } = setup();
    const view = await service.create(input, 'user-1');
    const data = prisma.deployment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      action: 'UNINSTALL',
      name: 'Desinstalar PuTTY release 0.85 (64-bit) 0.85.0.0 — 2 máquinas',
      productCode: PUTTY,
      productName: 'PuTTY release 0.85 (64-bit)',
      productVersion: '0.85.0.0',
      productPublisher: 'Simon Tatham',
    });
    expect(data).not.toHaveProperty('software');
    expect(prisma.machineInventory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { machineId: { in: [M1, M2] } }, orderBy: { collectedAt: 'desc' } }),
    );
    expect(view.software).toBeNull();
    expect(view.product).toEqual({ productCode: PUTTY, name: 'PuTTY release 0.85 (64-bit)', version: '0.85.0.0', publisher: 'Simon Tatham' });
  });

  it('ProductCode que não está no inventário guardado de nenhuma das máquinas: 409, nada é criado', async () => {
    const { prisma, service, input } = setup();
    await expect(service.create({ ...input, productCode: '{99999999-9999-9999-9999-999999999999}' }, 'u')).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.deployment.create).not.toHaveBeenCalled();
  });

  it('mesmo pacote no catálogo: a implantação fica ligada ao software (ativo primeiro, depois o mais antigo)', async () => {
    const { prisma, service, input } = setup({ catalog: { id: SW, name: '7-Zip', version: '26.06', installType: 'MSI', active: true } });
    await service.create(input, 'u');
    expect(prisma.software.findFirst).toHaveBeenCalledWith({
      where: { installType: 'MSI', msiProductCode: PUTTY },
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
    });
    expect(prisma.deployment.create.mock.calls[0][0].data).toMatchObject({ software: { connect: { id: SW } }, productCode: PUTTY });
  });

  it('máquina inexistente continua 400 antes de olhar o inventário', async () => {
    const { prisma, service, input } = setup();
    prisma.machine.findMany.mockResolvedValue([{ id: M1, hostname: 'X', lastSync: SYNC }]);
    await expect(service.create(input, 'u')).rejects.toThrow(BadRequestException);
    expect(prisma.machineInventory.findMany).not.toHaveBeenCalled();
  });
});

describe('visões e runner sem software do catálogo', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

  it('item da lista: software nulo e o produto', () => {
    const view = toSummaryView({
      id: 'd',
      name: 'Desinstalar PuTTY',
      action: 'UNINSTALL',
      status: 'SUCCEEDED',
      createdAt: SYNC,
      startedAt: SYNC,
      finishedAt: SYNC,
      software: null,
      productCode: PUTTY,
      productName: 'PuTTY',
      productVersion: '0.85',
      productPublisher: null,
      user: { username: 'testuser', displayName: null },
      targets: [{ status: 'SUCCEEDED' }],
    } as never);
    expect(view).toMatchObject({ software: null, product: { productCode: PUTTY, name: 'PuTTY', version: '0.85', publisher: null } });
  });

  it('runner: desinstala pelo ProductCode da implantação, com o nome do produto no log', async () => {
    const db = createInMemoryPrisma();
    db.deployments.set('d1', {
      id: 'd1', softwareId: null, status: S.PENDING, startedAt: null, finishedAt: null, action: 'UNINSTALL',
      productCode: PUTTY, productName: 'PuTTY release 0.85 (64-bit)', productVersion: '0.85.0.0',
    } as never);
    db.machines.set('m1', { id: 'm1', hostname: 'RSD-ALVO-01' });
    db.targets.set('t1', { id: 't1', deploymentId: 'd1', machineId: 'm1', status: S.PENDING, startedAt: null, finishedAt: null, exitCode: null });
    const run = jest.fn<Promise<DeployResult>, [DeployTargetInput, (e: DeployEvent) => void]>().mockResolvedValue({ ok: true, exitCode: 0 });
    const runner = new DeploymentRunner(db.prisma as never, { isAvailable: true, run } as never, { exists: jest.fn() } as never);
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });

    expect(run).toHaveBeenCalledWith(
      { action: 'UNINSTALL', targetId: 't1', computerName: 'RSD-ALVO-01', installType: 'MSI', productCode: PUTTY },
      expect.any(Function),
    );
    const logs = db.logs.map((l) => [l.level, l.message]);
    expect(logs[0]).toEqual([LogLevel.INFO, 'Iniciando a desinstalação de PuTTY release 0.85 (64-bit) 0.85.0.0 em RSD-ALVO-01.']);
    expect(db.targets.get('t1')).toMatchObject({ status: S.SUCCEEDED, exitCode: 0 });
  });
});

describe('InventoryService.summary (lista agrupada para o assistente)', () => {
  const NOW = new Date('2026-11-20T12:00:00Z');
  const OLD = new Date(NOW.getTime() - (INVENTORY_STALE_DAYS + 1) * 24 * 3600 * 1000);
  const M3 = '44444444-4444-4444-8444-444444444444';

  function setup() {
    const prisma = {
      machine: {
        findMany: jest.fn().mockResolvedValue([
          { id: M2, hostname: 'WS-FIN-001', lastSync: SYNC },
          { id: M1, hostname: 'RSD-ALVO-01', lastSync: SYNC },
          { id: M3, hostname: 'WS-RH-005', lastSync: SYNC },
        ]),
        aggregate: jest.fn().mockResolvedValue({ _max: { lastSync: SYNC } }),
      },
      machineInventory: {
        findMany: jest.fn().mockResolvedValue([
          {
            machineId: M1,
            collectedAt: NOW,
            items: [
              { name: 'PuTTY release 0.85 (64-bit)', version: '0.85.0.0', publisher: 'Simon Tatham', productCode: PUTTY, arch: '64' },
              { name: 'Microsoft Edge', version: '157', publisher: 'Microsoft', productCode: null, arch: '32' },
            ],
          },
          {
            machineId: M2,
            collectedAt: OLD,
            items: [
              { name: 'PuTTY (antigo)', version: '0.84', publisher: null, productCode: PUTTY, arch: '64' },
              { name: 'microsoft edge', version: '157', publisher: 'Microsoft', productCode: null, arch: '32' },
              { name: '7-Zip 26.06', version: '26.06', publisher: 'Igor Pavlov', productCode: ZIP, arch: '64' },
            ],
          },
        ]),
      },
      software: {
        findMany: jest
          .fn()
          // 1ª: marcação do catálogo para os códigos encontrados; 2ª: MSI do catálogo não encontrados.
          .mockResolvedValueOnce([{ id: 'sw-zip', name: '7-Zip', version: '26.06', active: true, msiProductCode: ZIP }])
          .mockResolvedValueOnce([{ id: 'sw-x', name: 'Outro MSI', version: '1', active: false, msiProductCode: '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}' }]),
      },
    };
    return { prisma, service: new InventoryService(prisma as never, {} as never) };
  }

  it('agrupa MSI pelo ProductCode e o resto por nome e versão, com quantas máquinas têm cada um', async () => {
    const { service } = setup();
    const s = await service.summary([M1, M2, M3], NOW);
    expect(s.products.map((p) => [p.kind, p.name, p.machineIds, p.catalog?.softwareId ?? null])).toEqual([
      ['OTHER', 'Microsoft Edge', [M1, M2], null],
      ['MSI', 'PuTTY release 0.85 (64-bit)', [M1, M2], null], // nome da consulta mais recente
      ['MSI', '7-Zip 26.06', [M2], 'sw-zip'],
    ]);
  });

  it('máquinas sem inventário e com inventário antigo (> 7 dias); MSI do catálogo não encontrados', async () => {
    const { service } = setup();
    const s = await service.summary([M1, M2, M3], NOW);
    expect(s.staleAfterDays).toBe(7);
    expect(s.machines.map((m) => [m.hostname, m.inventoryAt !== null, m.stale])).toEqual([
      ['RSD-ALVO-01', true, false],
      ['WS-FIN-001', true, true],
      ['WS-RH-005', false, false],
    ]);
    expect(s.catalogNotFound).toEqual([
      { softwareId: 'sw-x', name: 'Outro MSI', version: '1', active: false, productCode: '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}' },
    ]);
  });

  it('máquina que não existe mais: 404', async () => {
    const { prisma, service } = setup();
    prisma.machine.findMany.mockResolvedValue([]);
    await expect(service.summary([M1], NOW)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('corpo: 1 a 50 ids válidos, sem repetir; só ADMIN e OPERATOR', () => {
    expect(parseSummaryBody({ machineIds: [M1, M1.toUpperCase(), M2] })).toEqual([M1, M2]);
    expect(() => parseSummaryBody({ machineIds: [] })).toThrow(BadRequestException);
    expect(() => parseSummaryBody({ machineIds: ['x'] })).toThrow(BadRequestException);
    expect(() => parseSummaryBody({ machineIds: Array.from({ length: 51 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`) })).toThrow(
      BadRequestException,
    );
    expect(new Reflector().get<UserRole[]>(ROLES_KEY, InventoryController.prototype.summary)).toEqual([UserRole.ADMIN, UserRole.OPERATOR]);
  });
});

describe('inventory-target.ps1 — nunca o comando de desinstalação do registro', () => {
  it('não lê UninstallString nem QuietUninstallString (seria execução arbitrária)', () => {
    expect(readFileSync(INVENTORY_SCRIPT_PATH, 'utf8')).not.toMatch(/UninstallString/i);
  });
});
