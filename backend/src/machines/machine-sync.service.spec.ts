import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { MachineStatus } from '@prisma/client';
import { MachineSyncService } from './machine-sync.service';
import {
  LdapAuthenticationError,
  LdapConnectionError,
  LdapEntry,
  LdapService,
} from '../ldap/ldap.service';
import { PrismaService } from '../prisma/prisma.service';

function adEntry(cn: string, ou: string, os = 'Windows 11 Pro'): LdapEntry {
  return {
    dn: `CN=${cn},OU=${ou},DC=exemplo,DC=local`,
    attributes: { cn: [cn], operatingsystem: [os] },
  };
}

describe('MachineSyncService', () => {
  let ldapService: { searchComputers: jest.Mock };
  let prisma: {
    machine: { findMany: jest.Mock; upsert: jest.Mock; count: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: MachineSyncService;

  beforeEach(() => {
    delete process.env.LDAP_COMPUTER_OS_ATTRIBUTE;
    ldapService = { searchComputers: jest.fn() };
    prisma = {
      machine: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn((args) => args),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn(async (ops) => ops),
    };
    service = new MachineSyncService(
      ldapService as unknown as LdapService,
      prisma as unknown as PrismaService,
    );
  });

  it('cria máquinas novas com status UNKNOWN e lastSync da sincronização', async () => {
    ldapService.searchComputers.mockResolvedValue([adEntry('WS-ADM-001', 'ADMINISTRACAO')]);

    const result = await service.sync();

    const args = prisma.machine.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ hostname: 'WS-ADM-001' });
    expect(args.create).toEqual({
      hostname: 'WS-ADM-001',
      operatingSystem: 'Windows 11 Pro',
      department: 'ADMINISTRACAO',
      status: MachineStatus.UNKNOWN,
      lastSync: new Date(result.syncedAt),
    });
    expect(result).toMatchObject({ total: 1, created: 1, updated: 0 });
  });

  it('nunca sobrescreve o status de uma máquina existente', async () => {
    prisma.machine.findMany.mockResolvedValue([{ hostname: 'WS-ADM-001' }]);
    ldapService.searchComputers.mockResolvedValue([adEntry('WS-ADM-001', 'ADMINISTRACAO')]);

    const result = await service.sync();

    const { update } = prisma.machine.upsert.mock.calls[0][0];
    expect(update).not.toHaveProperty('status');
    expect(update).toEqual({
      operatingSystem: 'Windows 11 Pro',
      department: 'ADMINISTRACAO',
      lastSync: new Date(result.syncedAt),
    });
    expect(result).toMatchObject({ total: 1, created: 0, updated: 1 });
  });

  it('conta como "não vistas" as máquinas com lastSync anterior a esta sincronização', async () => {
    ldapService.searchComputers.mockResolvedValue([adEntry('WS-ADM-001', 'ADMINISTRACAO')]);
    prisma.machine.count.mockResolvedValue(3);

    const result = await service.sync();

    const { where } = prisma.machine.count.mock.calls[0][0];
    expect(where).toEqual({
      OR: [{ lastSync: null }, { lastSync: { lt: new Date(result.syncedAt) } }],
    });
    expect(result.notSeen).toBe(3);
  });

  it('nunca apaga máquinas do banco', async () => {
    ldapService.searchComputers.mockResolvedValue([]);
    await service.sync();
    expect(prisma.machine).not.toHaveProperty('delete');
    expect(prisma.machine).not.toHaveProperty('deleteMany');
  });

  it('normaliza hostnames e descarta duplicados e entradas sem hostname', async () => {
    ldapService.searchComputers.mockResolvedValue([
      adEntry('ws-fin-001', 'FINANCEIRO'),
      adEntry('WS-FIN-001', 'OUTRA'),
      { dn: 'CN=,OU=TI,DC=exemplo', attributes: {} },
    ]);

    const result = await service.sync();

    expect(prisma.machine.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.machine.upsert.mock.calls[0][0].create.department).toBe('FINANCEIRO');
    expect(result.total).toBe(1);
  });

  it('lê o SO do atributo configurado em LDAP_COMPUTER_OS_ATTRIBUTE', async () => {
    process.env.LDAP_COMPUTER_OS_ATTRIBUTE = 'description';
    ldapService.searchComputers.mockResolvedValue([
      { dn: 'cn=ws-1,ou=TI,dc=rsd,dc=local', attributes: { cn: ['ws-1'], description: ['Windows 10 Pro'] } },
    ]);

    await service.sync();

    expect(prisma.machine.upsert.mock.calls[0][0].create.operatingSystem).toBe('Windows 10 Pro');
  });

  it('grava em lotes de 200 por transação', async () => {
    ldapService.searchComputers.mockResolvedValue(
      Array.from({ length: 450 }, (_, i) => adEntry(`WS-${i}`, 'TI')),
    );

    await service.sync();

    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(prisma.$transaction.mock.calls.map(([ops]) => ops.length)).toEqual([200, 200, 50]);
  });

  it.each([
    ['conta de serviço recusada', new LdapAuthenticationError('invalid credentials')],
    ['LDAP inacessível', new LdapConnectionError('ECONNREFUSED')],
    ['variável de ambiente ausente', new Error('LDAP_COMPUTER_BASE_DN não configurado')],
  ])('responde 503 genérico quando %s, sem tocar no banco', async (_caso, err) => {
    ldapService.searchComputers.mockRejectedValue(err);

    await expect(service.sync()).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.machine.upsert).not.toHaveBeenCalled();
  });

  it('rejeita com 409 uma segunda sincronização enquanto a primeira roda', async () => {
    let release!: (value: LdapEntry[]) => void;
    ldapService.searchComputers.mockReturnValue(new Promise((resolve) => (release = resolve)));

    const first = service.sync();
    await expect(service.sync()).rejects.toThrow(ConflictException);

    release([]);
    await first;
    ldapService.searchComputers.mockResolvedValue([]);
    await expect(service.sync()).resolves.toBeDefined();
  });

  it('libera a trava mesmo quando a sincronização falha', async () => {
    ldapService.searchComputers.mockRejectedValueOnce(new LdapConnectionError('timeout'));
    await expect(service.sync()).rejects.toThrow(ServiceUnavailableException);

    ldapService.searchComputers.mockResolvedValue([]);
    await expect(service.sync()).resolves.toBeDefined();
  });
});
