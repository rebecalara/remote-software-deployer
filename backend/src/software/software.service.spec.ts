import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SoftwareService } from './software.service';
import { SoftwareValidationError } from './software-validation';

const USER_ID = 'user-1';
const ID = '11111111-1111-4111-8111-111111111111';

/** Linha do banco como o Prisma devolve com o include do service. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    name: '7-Zip',
    version: '23.01',
    vendor: 'Igor Pavlov',
    installType: 'EXE',
    installArgs: ['/S'],
    active: true,
    installerFileName: null,
    installerOriginalName: null,
    installerSizeBytes: null,
    installerSha256: null,
    installerUploadedAt: null,
    createdById: USER_ID,
    updatedById: USER_ID,
    createdAt: new Date('2026-11-07T10:00:00Z'),
    updatedAt: new Date('2026-11-07T10:00:00Z'),
    _count: { deployments: 0 },
    createdBy: { username: 'testuser', displayName: 'Test User' },
    updatedBy: { username: 'testuser', displayName: 'Test User' },
    ...overrides,
  };
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
  });
}

describe('SoftwareService', () => {
  let prisma: {
    software: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let service: SoftwareService;

  beforeEach(() => {
    prisma = {
      software: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(row()),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }) => row(data)),
        update: jest.fn(async ({ data }) => row({ ...data, updatedBy: { username: 'outro', displayName: 'Outro' } })),
      },
    };
    service = new SoftwareService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('por padrão lista só os ativos, por nome e versão', async () => {
      await service.list();
      expect(prisma.software.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { active: true }, orderBy: [{ name: 'asc' }, { version: 'asc' }] }),
      );
    });

    it('com includeInactive, lista todos', async () => {
      await service.list({ includeInactive: true });
      expect(prisma.software.findMany.mock.calls[0][0].where).toEqual({});
    });
  });

  describe('get / formato da resposta', () => {
    it('sem instalador: installer null e contagem real de implantações', async () => {
      prisma.software.findUnique.mockResolvedValue(row({ _count: { deployments: 0 } }));
      const view = await service.get(ID);
      expect(view.installer).toBeNull();
      expect(view.deploymentCount).toBe(0);
      expect(view.createdBy).toEqual({ username: 'testuser', displayName: 'Test User' });
    });

    it('com instalador: expõe nome original, tamanho e hash — nunca o nome interno do arquivo', async () => {
      prisma.software.findUnique.mockResolvedValue(
        row({
          installerFileName: 'c0ffee00-0000-4000-8000-000000000000.exe',
          installerOriginalName: '7z2301-x64.exe',
          installerSizeBytes: 1_572_864,
          installerSha256: 'AB'.repeat(32),
          installerUploadedAt: new Date('2026-11-07T11:00:00Z'),
        }),
      );

      const view = await service.get(ID);

      expect(view.installer).toEqual({
        originalName: '7z2301-x64.exe',
        sizeBytes: 1_572_864,
        sha256: 'AB'.repeat(32),
        uploadedAt: '2026-11-07T11:00:00.000Z',
      });
      expect(JSON.stringify(view)).not.toContain('c0ffee00');
    });

    it('404 quando não existe', async () => {
      prisma.software.findUnique.mockResolvedValue(null);
      await expect(service.get(ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    const input = { name: '7-Zip', version: '23.01', vendor: null, installType: 'EXE' as const, installArgs: ['/S'] };

    it('grava quem cadastrou (createdBy e updatedBy) a partir do usuário do token', async () => {
      await service.create(input, USER_ID);
      expect(prisma.software.create.mock.calls[0][0].data).toEqual({
        ...input,
        createdById: USER_ID,
        updatedById: USER_ID,
      });
    });

    it('409 para nome+versão já existente, sem diferenciar maiúsculas', async () => {
      prisma.software.findFirst.mockResolvedValue({ id: 'outro' });

      await expect(service.create({ ...input, name: '7-ZIP' }, USER_ID)).rejects.toThrow(ConflictException);
      expect(prisma.software.findFirst.mock.calls[0][0].where).toEqual({
        name: { equals: '7-ZIP', mode: 'insensitive' },
        version: { equals: '23.01', mode: 'insensitive' },
      });
      expect(prisma.software.create).not.toHaveBeenCalled();
    });

    it('409 quando a corrida passa pela checagem e colide no @@unique do banco (P2002)', async () => {
      prisma.software.create.mockRejectedValue(uniqueViolation());
      await expect(service.create(input, USER_ID)).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('grava quem alterou por último', async () => {
      await service.update(ID, { vendor: 'Outro' }, 'user-2');
      expect(prisma.software.update.mock.calls[0][0].data).toEqual({
        vendor: 'Outro',
        updatedBy: { connect: { id: 'user-2' } },
      });
    });

    it('404 quando não existe', async () => {
      prisma.software.findUnique.mockResolvedValue(null);
      await expect(service.update(ID, { vendor: 'x' }, USER_ID)).rejects.toThrow(NotFoundException);
      expect(prisma.software.update).not.toHaveBeenCalled();
    });

    describe('depois da primeira implantação', () => {
      beforeEach(() => prisma.software.findUnique.mockResolvedValue(row({ _count: { deployments: 3 } })));

      it.each([
        ['version', { version: '24.00' }],
        ['installType', { installType: 'MSI' as const }],
        ['installArgs', { installArgs: ['/S', '/D=C:\\Apps'] }],
      ])('trava %s (409: cadastre uma nova versão)', async (field, input) => {
        const error = await service.update(ID, input, USER_ID).catch((e) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect(error.message).toContain(field);
        expect(error.message).toContain('nova versão');
        expect(prisma.software.update).not.toHaveBeenCalled();
      });

      it('nome e fabricante continuam editáveis', async () => {
        await expect(service.update(ID, { name: '7-Zip x64', vendor: 'Igor' }, USER_ID)).resolves.toBeDefined();
      });

      it('reenviar o mesmo valor de um campo de execução não conta como mudança', async () => {
        await expect(service.update(ID, { version: '23.01', installArgs: ['/S'] }, USER_ID)).resolves.toBeDefined();
      });
    });

    describe('installArgs conferido contra o tipo que vai valer depois da edição', () => {
      it('mudar só o tipo para MSI com argumentos de EXE salvos → 400', async () => {
        prisma.software.findUnique.mockResolvedValue(row({ installType: 'EXE', installArgs: ['/S'] }));
        await expect(service.update(ID, { installType: 'MSI' }, USER_ID)).rejects.toThrow(SoftwareValidationError);
      });

      it('mudar o tipo junto com argumentos compatíveis → ok', async () => {
        await service.update(ID, { installType: 'MSI', installArgs: ['ALLUSERS=1'] }, USER_ID);
        expect(prisma.software.update.mock.calls[0][0].data).toMatchObject({
          installType: 'MSI',
          installArgs: ['ALLUSERS=1'],
        });
      });

      it('só argumentos novos, sem tipo: conferidos contra o tipo salvo (MSI)', async () => {
        prisma.software.findUnique.mockResolvedValue(row({ installType: 'MSI', installArgs: [] }));
        await expect(service.update(ID, { installArgs: ['/S'] }, USER_ID)).rejects.toThrow(SoftwareValidationError);
      });
    });

    it('tipo não muda depois que o instalador foi enviado (a extensão e o cabeçalho dependem dele)', async () => {
      prisma.software.findUnique.mockResolvedValue(
        row({ installerFileName: 'c0ffee00-0000-4000-8000-000000000000.exe', installArgs: [] }),
      );
      const error = await service.update(ID, { installType: 'MSI' }, USER_ID).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toContain('arquivo foi enviado');
    });

    describe('duplicidade ao renomear', () => {
      it('confere nome+versão novos, ignorando o próprio registro', async () => {
        await service.update(ID, { name: 'Outro Nome' }, USER_ID);
        expect(prisma.software.findFirst.mock.calls[0][0].where).toEqual({
          name: { equals: 'Outro Nome', mode: 'insensitive' },
          version: { equals: '23.01', mode: 'insensitive' },
          NOT: { id: ID },
        });
      });

      it('409 se colidir com outro software', async () => {
        prisma.software.findFirst.mockResolvedValue({ id: 'outro' });
        await expect(service.update(ID, { name: 'Outro Nome' }, USER_ID)).rejects.toThrow(ConflictException);
      });

      it('sem mudança de nome/versão, nem consulta duplicidade', async () => {
        await service.update(ID, { vendor: 'x' }, USER_ID);
        expect(prisma.software.findFirst).not.toHaveBeenCalled();
      });

      it('409 também na corrida (P2002)', async () => {
        prisma.software.update.mockRejectedValue(uniqueViolation());
        await expect(service.update(ID, { name: 'Outro' }, USER_ID)).rejects.toThrow(ConflictException);
      });
    });
  });
});
