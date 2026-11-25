import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { LdapAuthenticationError, LdapConnectionError } from '../ldap/ldap.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService, LDAP_CHECK_CACHE_MS } from './dashboard.service';

const SYNC = new Date('2026-11-14T10:00:00Z');
const t = (iso: string) => new Date(iso);

function setup(overrides: { summary?: Record<string, unknown>; available?: boolean; reason?: string | null } = {}) {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    machine: {
      count: jest.fn((args?: { where?: unknown }) => Promise.resolve(args?.where ? 15 : 16)),
      aggregate: jest.fn().mockResolvedValue({ _max: { lastSync: SYNC } }),
    },
    deployment: { findMany: jest.fn().mockResolvedValue([]) },
    software: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const deployments = {
    summary: jest.fn().mockResolvedValue({
      activeDeployments: 1,
      runningTargets: 2,
      pendingTargets: 3,
      windowHours: 24,
      finishedInWindow: { succeeded: 9, failed: 1, cancelled: 0 },
      ...overrides.summary,
    }),
  };
  const executor = { isAvailable: overrides.available ?? true, unavailableReason: overrides.reason ?? null };
  const ldap = { checkServiceAccount: jest.fn().mockResolvedValue(undefined) };
  const service = new DashboardService(prisma as never, deployments as never, executor as never, ldap as never);
  return { prisma, deployments, executor, ldap, service };
}

describe('DashboardService.overview', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

  it('máquinas cadastradas e presentes na última sincronização; taxa de falha das 24 h', async () => {
    const { prisma, service } = setup();
    const view = await service.overview(t('2026-11-14T12:00:00Z'));

    expect(view.machines).toEqual({ total: 16, seenInLastSync: 15, lastSyncAt: SYNC.toISOString() });
    expect(prisma.machine.count).toHaveBeenCalledWith({ where: { lastSync: SYNC } });
    expect(view.deployments).toMatchObject({ activeDeployments: 1, pendingTargets: 3, failureRate: 0.1 });
    expect(view.system).toEqual({
      database: { ok: true, detail: null, reason: null },
      ldap: { ok: true, detail: null, reason: null },
      deployment: { available: true, detail: null },
      lastSyncAt: SYNC.toISOString(),
      checkedAt: '2026-11-14T12:00:00.000Z',
    });
  });

  it('sem implantação encerrada na janela, taxa de falha nula (não 0%)', async () => {
    const { service } = setup({ summary: { finishedInWindow: { succeeded: 0, failed: 0, cancelled: 2 } } });
    expect((await service.overview()).deployments.failureRate).toBeNull();
  });

  it('nunca sincronizado: nenhuma máquina presente, sem data', async () => {
    const { prisma, service } = setup();
    prisma.machine.aggregate.mockResolvedValue({ _max: { lastSync: null } });
    const view = await service.overview();
    expect(view.machines).toEqual({ total: 16, seenInLastSync: 0, lastSyncAt: null });
  });

  it('implantação indisponível neste ambiente, com o motivo', async () => {
    const { service } = setup({ available: false, reason: 'a implantação remota exige o backend em Windows (powershell.exe).' });
    expect((await service.overview()).system.deployment).toEqual({
      available: false,
      detail: 'a implantação remota exige o backend em Windows (powershell.exe).',
    });
  });

  it('LDAP fora do ar ou recusando a conta de serviço aparece com o motivo', async () => {
    const down = setup();
    down.ldap.checkServiceAccount.mockRejectedValue(new LdapConnectionError('connect ECONNREFUSED 127.0.0.1:389'));
    expect((await down.service.overview()).system.ldap).toEqual({
      ok: false,
      detail: 'O AD/LDAP não respondeu: connect ECONNREFUSED 127.0.0.1:389',
      reason: 'no-response',
    });

    // Recusou a conta: a tela mostra "Recusou a conta de serviço" (o AD respondeu).
    const refused = setup();
    refused.ldap.checkServiceAccount.mockRejectedValue(new LdapAuthenticationError('Invalid Credentials'));
    expect((await refused.service.overview()).system.ldap).toEqual({
      ok: false,
      detail: 'O AD/LDAP respondeu, mas recusou a conta de serviço de leitura.',
      reason: 'refused',
    });

    // Conta de serviço não configurada (erro comum, não do LDAP): continua "sem resposta".
    const missing = setup();
    missing.ldap.checkServiceAccount.mockRejectedValue(new Error('LDAP_SEARCH_BIND_DN não configurado no ambiente.'));
    expect((await missing.service.overview()).system.ldap.reason).toBe('no-response');
  });

  it('o bind no LDAP é cacheado: duas visitas seguidas fazem um bind só', async () => {
    const { ldap, service } = setup();
    await service.overview(t('2026-11-14T12:00:00Z'));
    await service.overview(t('2026-11-14T12:00:10Z'));
    expect(ldap.checkServiceAccount).toHaveBeenCalledTimes(1);
    await service.overview(new Date(t('2026-11-14T12:00:00Z').getTime() + LDAP_CHECK_CACHE_MS + 1));
    expect(ldap.checkServiceAccount).toHaveBeenCalledTimes(2);
  });

  it('banco sem responder aparece como não ok', async () => {
    const { prisma, service } = setup();
    prisma.$queryRaw.mockRejectedValue(new Error('Connection refused'));
    expect((await service.overview()).system.database).toEqual({ ok: false, detail: 'Connection refused', reason: 'no-response' });
  });

  it('atividade: implantações encerradas e softwares cadastrados, mais recentes primeiro', async () => {
    const { prisma, service } = setup();
    prisma.deployment.findMany.mockResolvedValue([
      {
        id: 'd1',
        action: 'INSTALL',
        status: 'FAILED',
        finishedAt: t('2026-11-14T11:00:00Z'),
        software: { name: '7-Zip', version: '26.06' },
        user: { username: 'testuser', displayName: null },
        targets: [{ status: 'SUCCEEDED' }, { status: 'FAILED' }],
      },
    ]);
    prisma.software.findMany.mockResolvedValue([
      { name: 'Notepad++', version: '8.6', createdAt: t('2026-11-14T11:30:00Z'), createdBy: { username: 'admin', displayName: 'Admin' } },
      { name: 'Antigo', version: '1', createdAt: t('2026-11-01T08:00:00Z'), createdBy: null },
    ]);
    const { activity } = await service.overview();
    expect(activity).toEqual([
      { kind: 'software', at: '2026-11-14T11:30:00.000Z', by: 'Admin', softwareName: 'Notepad++', softwareVersion: '8.6' },
      {
        kind: 'deployment',
        at: '2026-11-14T11:00:00.000Z',
        by: 'testuser',
        deploymentId: 'd1',
        action: 'INSTALL',
        status: 'FAILED',
        succeeded: 1,
        failed: 1,
        total: 2,
        softwareName: '7-Zip',
        softwareVersion: '26.06',
        inCatalog: true,
      },
      { kind: 'software', at: '2026-11-01T08:00:00.000Z', by: null, softwareName: 'Antigo', softwareVersion: '1' },
    ]);
    expect(prisma.deployment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { finishedAt: { not: null } } }));
  });
});

describe('DashboardController', () => {
  it('é leitura para qualquer usuário logado', () => {
    expect(new Reflector().get<UserRole[] | undefined>(ROLES_KEY, DashboardController.prototype.overview)).toBeUndefined();
  });
});

describe('DashboardService — LDAP sem mensagem de erro', () => {
  it('erro de conexão sem texto (ex.: conexão recusada) vira uma frase completa', async () => {
    Logger.overrideLogger(false);
    const { ldap, service } = setup();
    ldap.checkServiceAccount.mockRejectedValue(new LdapConnectionError(''));
    expect((await service.overview()).system.ldap.detail).toBe(
      'O AD/LDAP não respondeu (conexão recusada ou tempo esgotado).',
    );
  });
});
