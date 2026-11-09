import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SoftwareService } from './software.service';
import { SoftwareValidationError } from './software-validation';
import {
  InstallerStorageService,
  InstallerTooLargeError,
  InvalidInstallerHeaderError,
} from './installer-storage.service';
import { Readable } from 'node:stream';

const USER_ID = 'user-1';
const ID = '11111111-1111-4111-8111-111111111111';
const OLD_FILE = 'c0ffee00-0000-4000-8000-000000000000.exe';
const NEW_FILE = 'beef0000-0000-4000-8000-000000000000.exe';

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
      updateMany: jest.Mock;
    };
  };
  let storage: {
    isAvailable: boolean;
    maxSizeBytes: number;
    save: jest.Mock;
    delete: jest.Mock;
    listFiles: jest.Mock;
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
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    storage = {
      isAvailable: true,
      maxSizeBytes: 500 * 1024 * 1024,
      save: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      listFiles: jest.fn().mockResolvedValue([]),
    };
    service = new SoftwareService(
      prisma as unknown as PrismaService,
      storage as unknown as InstallerStorageService,
    );
  });

  describe('getInstallerLimits', () => {
    it('devolve o limite de tamanho e se o armazenamento está configurado', () => {
      expect(service.getInstallerLimits()).toEqual({ maxSizeBytes: 500 * 1024 * 1024, storageAvailable: true });
    });

    it('armazenamento não configurado: storageAvailable false (a tela avisa antes de enviar)', () => {
      storage.isAvailable = false;
      expect(service.getInstallerLimits().storageAvailable).toBe(false);
    });
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

  describe('setActive (desativar / reativar)', () => {
    it('desativa e grava quem alterou', async () => {
      await service.setActive(ID, false, 'user-2');
      expect(prisma.software.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ID },
          data: { active: false, updatedBy: { connect: { id: 'user-2' } } },
        }),
      );
    });

    it('reativa', async () => {
      prisma.software.findUnique.mockResolvedValue(row({ active: false }));
      await service.setActive(ID, true, USER_ID);
      expect(prisma.software.update.mock.calls[0][0].data.active).toBe(true);
    });

    it('é idempotente: já no estado pedido, não grava nada (nem muda updatedBy)', async () => {
      prisma.software.findUnique.mockResolvedValue(row({ active: false }));
      const view = await service.setActive(ID, false, 'user-2');
      expect(view.active).toBe(false);
      expect(prisma.software.update).not.toHaveBeenCalled();
    });

    it('funciona mesmo depois de implantado (é o caminho no lugar de apagar)', async () => {
      prisma.software.findUnique.mockResolvedValue(row({ _count: { deployments: 5 } }));
      await expect(service.setActive(ID, false, USER_ID)).resolves.toBeDefined();
    });

    it('404 quando não existe', async () => {
      prisma.software.findUnique.mockResolvedValue(null);
      await expect(service.setActive(ID, false, USER_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove (apagar)', () => {
    // Mensagem REAL do Prisma 5.22 + Postgres, capturada apagando um software com
    // implantação no banco local (onDelete: Restrict → 23001, sem código Prisma).
    const restrictError = () =>
      new Prisma.PrismaClientUnknownRequestError(
        'Invalid `prisma.software.delete()` invocation:\nError occurred during query execution:\n' +
          'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { ' +
          'code: "23001", message: "update or delete on table \\"Software\\" violates RESTRICT setting of ' +
          'foreign key constraint \\"Deployment_softwareId_fkey\\" on table \\"Deployment\\"", severity: "ERROR", ' +
          'detail: Some("Key (id)=(c27e8dce-3047-4fbd-9533-362e1fc8e984) is referenced from table ' +
          '\\"Deployment\\"."), column: None, hint: None }), transient: false })',
        { clientVersion: '5.22.0' },
      );

    beforeEach(() => {
      (prisma.software as Record<string, jest.Mock>).delete = jest.fn().mockResolvedValue(row());
    });
    const deleteMock = () => (prisma.software as Record<string, jest.Mock>).delete;

    it('apaga software nunca implantado', async () => {
      await service.remove(ID);
      expect(deleteMock()).toHaveBeenCalledWith({ where: { id: ID } });
    });

    it('409 com orientação para desativar quando já foi implantado — nem tenta apagar', async () => {
      prisma.software.findUnique.mockResolvedValue(row({ _count: { deployments: 1 } }));
      const error = await service.remove(ID).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toContain('Desative-o em vez de apagar');
      expect(deleteMock()).not.toHaveBeenCalled();
    });

    it('409 na corrida: o banco recusa com 23001 (erro sem código Prisma, formato real)', async () => {
      deleteMock().mockRejectedValue(restrictError());
      const error = await service.remove(ID).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toContain('Desative-o em vez de apagar');
    });

    it('409 também se vier como P2003 (relação com NO ACTION)', async () => {
      deleteMock().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
          code: 'P2003',
          clientVersion: '5.22.0',
        }),
      );
      await expect(service.remove(ID)).rejects.toThrow(ConflictException);
    });

    it('outros erros do banco não viram 409 (não mascarar falha real)', async () => {
      deleteMock().mockRejectedValue(
        new Prisma.PrismaClientUnknownRequestError('connection reset', { clientVersion: '5.22.0' }),
      );
      const error = await service.remove(ID).catch((e) => e);
      expect(error).not.toBeInstanceOf(ConflictException);
      expect(error.message).toBe('connection reset');
    });

    it('404 quando não existe', async () => {
      prisma.software.findUnique.mockResolvedValue(null);
      await expect(service.remove(ID)).rejects.toThrow(NotFoundException);
      expect(deleteMock()).not.toHaveBeenCalled();
    });

    it('apaga também o arquivo do instalador, DEPOIS do registro', async () => {
      prisma.software.findUnique.mockResolvedValue(row({ installerFileName: OLD_FILE }));
      await service.remove(ID);
      expect(storage.delete).toHaveBeenCalledWith(OLD_FILE);
      expect(deleteMock().mock.invocationCallOrder[0]).toBeLessThan(storage.delete.mock.invocationCallOrder[0]);
    });

    it('se o banco recusar, o arquivo NÃO é apagado', async () => {
      prisma.software.findUnique.mockResolvedValue(row({ installerFileName: OLD_FILE }));
      deleteMock().mockRejectedValue(restrictError());
      await expect(service.remove(ID)).rejects.toThrow(ConflictException);
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('falha ao apagar o arquivo não desfaz a exclusão (vira órfão avisado na subida)', async () => {
      prisma.software.findUnique.mockResolvedValue(row({ installerFileName: OLD_FILE }));
      storage.delete.mockRejectedValue(new Error('EBUSY'));
      await expect(service.remove(ID)).resolves.toBeUndefined();
    });
  });

  describe('uploadInstaller', () => {
    const body = () => Readable.from([Buffer.from('MZ...')]);
    const saved = { fileName: NEW_FILE, sizeBytes: 1_659_704, sha256: 'CD'.repeat(32) };

    beforeEach(() => storage.save.mockResolvedValue(saved));

    it('primeiro envio: grava o arquivo, associa ao software e registra quem enviou', async () => {
      await service.uploadInstaller(ID, body(), '7z2606-x64.exe', 'user-2');

      expect(storage.save).toHaveBeenCalledWith(expect.any(Readable), 'EXE');
      const call = prisma.software.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: ID, installerFileName: null });
      expect(call.data).toMatchObject({
        installerFileName: NEW_FILE,
        installerOriginalName: '7z2606-x64.exe',
        installerSizeBytes: 1_659_704,
        installerSha256: 'CD'.repeat(32),
        updatedById: 'user-2',
      });
      expect(call.data.installerUploadedAt).toBeInstanceOf(Date);
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('confere o cabeçalho contra o tipo cadastrado (MSI)', async () => {
      prisma.software.findUnique.mockResolvedValue(row({ installType: 'MSI', installArgs: [] }));
      await service.uploadInstaller(ID, body(), '7z.msi', USER_ID);
      expect(storage.save).toHaveBeenCalledWith(expect.any(Readable), 'MSI');
    });

    it('troca: só atualiza se o registro ainda aponta para o arquivo antigo, e então apaga o antigo', async () => {
      prisma.software.findUnique.mockResolvedValue(row({ installerFileName: OLD_FILE }));

      await service.uploadInstaller(ID, body(), 'novo.exe', USER_ID);

      expect(prisma.software.updateMany.mock.calls[0][0].where).toEqual({ id: ID, installerFileName: OLD_FILE });
      expect(storage.delete).toHaveBeenCalledWith(OLD_FILE);
      expect(storage.delete).not.toHaveBeenCalledWith(NEW_FILE);
    });

    it('envio simultâneo trocou o arquivo antes: 409 e o arquivo novo é apagado (nada órfão)', async () => {
      prisma.software.findUnique.mockResolvedValue(row({ installerFileName: OLD_FILE }));
      prisma.software.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.uploadInstaller(ID, body(), 'novo.exe', USER_ID)).rejects.toThrow(ConflictException);
      expect(storage.delete).toHaveBeenCalledWith(NEW_FILE);
      expect(storage.delete).not.toHaveBeenCalledWith(OLD_FILE);
    });

    it('falha ao gravar no banco: o arquivo novo é apagado e o erro segue', async () => {
      prisma.software.updateMany.mockRejectedValue(new Error('conexão com o banco caiu'));

      await expect(service.uploadInstaller(ID, body(), 'x.exe', USER_ID)).rejects.toThrow('conexão com o banco caiu');
      expect(storage.delete).toHaveBeenCalledWith(NEW_FILE);
    });

    it('409 depois da primeira implantação, sem ler nem gravar nada', async () => {
      prisma.software.findUnique.mockResolvedValue(row({ _count: { deployments: 1 } }));
      const error = await service.uploadInstaller(ID, body(), 'x.exe', USER_ID).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toContain('nova versão');
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('503 quando o armazenamento não está configurado (antes de consultar o banco)', async () => {
      storage.isAvailable = false;
      await expect(service.uploadInstaller(ID, body(), 'x.exe', USER_ID)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(prisma.software.findUnique).not.toHaveBeenCalled();
    });

    it('404 para software inexistente', async () => {
      prisma.software.findUnique.mockResolvedValue(null);
      await expect(service.uploadInstaller(ID, body(), 'x.exe', USER_ID)).rejects.toThrow(NotFoundException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it.each([
      ['limite estourado', new InstallerTooLargeError(1024), PayloadTooLargeException],
      ['cabeçalho errado', new InvalidInstallerHeaderError('EXE'), BadRequestException],
    ])('%s no armazenamento vira erro HTTP certo, sem tocar no banco', async (_caso, err, httpError) => {
      storage.save.mockRejectedValue(err);
      await expect(service.uploadInstaller(ID, body(), 'x.exe', USER_ID)).rejects.toThrow(httpError);
      expect(prisma.software.updateMany).not.toHaveBeenCalled();
    });

    it('conexão que cai no meio do envio: o erro segue como está (não vira 4xx)', async () => {
      storage.save.mockRejectedValue(new Error('aborted'));
      await expect(service.uploadInstaller(ID, body(), 'x.exe', USER_ID)).rejects.toThrow('aborted');
    });

    it('a resposta traz os dados do instalador, sem o nome interno do arquivo', async () => {
      prisma.software.findUnique
        .mockResolvedValueOnce(row())
        .mockResolvedValueOnce(
          row({
            installerFileName: NEW_FILE,
            installerOriginalName: '7z2606-x64.exe',
            installerSizeBytes: 1_659_704,
            installerSha256: 'CD'.repeat(32),
            installerUploadedAt: new Date(),
          }),
        );
      const view = await service.uploadInstaller(ID, body(), '7z2606-x64.exe', USER_ID);
      expect(view.installer?.sha256).toBe('CD'.repeat(32));
      expect(JSON.stringify(view)).not.toContain(NEW_FILE);
    });
  });

  describe('onApplicationBootstrap (pasta × banco, só avisa)', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation();
    });

    it('avisa arquivo órfão e registro sem arquivo — e não apaga nada', async () => {
      storage.listFiles.mockResolvedValue([OLD_FILE, NEW_FILE]);
      prisma.software.findMany.mockResolvedValue([
        { name: '7-Zip', version: '26.06', installerFileName: NEW_FILE },
        { name: 'Reader', version: '1', installerFileName: 'aaaaaaaa-0000-4000-8000-000000000000.msi' },
      ]);

      await service.onApplicationBootstrap();

      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/sem registro no banco.*c0ffee00/);
      expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/"Reader 1" não encontrado na pasta/);
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('tudo coerente: nenhum aviso', async () => {
      storage.listFiles.mockResolvedValue([NEW_FILE]);
      prisma.software.findMany.mockResolvedValue([{ name: 'A', version: '1', installerFileName: NEW_FILE }]);
      await service.onApplicationBootstrap();
      expect(warn).not.toHaveBeenCalled();
    });

    it('armazenamento não configurado: não confere nada', async () => {
      storage.isAvailable = false;
      await service.onApplicationBootstrap();
      expect(storage.listFiles).not.toHaveBeenCalled();
    });
  });
});
