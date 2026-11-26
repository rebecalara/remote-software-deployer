import { ArgumentsHost } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PassThrough, Readable } from 'node:stream';
import {
  CATALOG_WRITE_ROLES,
  DISCARD_CEILING_FACTOR,
  discardLimit,
  discardRemainingBody,
  SoftwareController,
} from './software.controller';
import { SoftwareService } from './software.service';
import { SoftwareValidationError } from './software-validation';
import { SoftwareValidationFilter } from './software-validation.filter';

describe('SoftwareController', () => {
  const reflector = new Reflector();
  const rolesOf = (method: keyof SoftwareController) =>
    reflector.get<UserRole[] | undefined>(ROLES_KEY, SoftwareController.prototype[method]);

  describe('permissões', () => {
    it('o controller inteiro exige JWT e passa pelo RolesGuard', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, SoftwareController)).toEqual([JwtAuthGuard, RolesGuard]);
    });

    it('escrita no catálogo: ADMIN e OPERATOR (restrição por perfil descartada de propósito)', () => {
      expect(CATALOG_WRITE_ROLES).toEqual([UserRole.ADMIN, UserRole.OPERATOR]);
    });

    it.each(['create', 'update', 'deactivate', 'activate', 'remove', 'uploadInstaller'] as const)('%s usa @CanWriteCatalog (VIEWER fica de fora)', (method) => {
      expect(rolesOf(method)).toEqual(CATALOG_WRITE_ROLES);
      expect(rolesOf(method)).not.toContain(UserRole.VIEWER);
    });

    it.each(['list', 'get', 'installerLimits'] as const)('%s é leitura: qualquer usuário logado', (method) => {
      expect(rolesOf(method)).toBeUndefined();
    });
  });

  describe('ordem das rotas', () => {
    it('GET installer-limits é declarada ANTES de GET :id (senão :id a capturaria → 400 do ParseUUIDPipe)', () => {
      // O Nest registra as rotas na ordem dos métodos da classe (MetadataScanner).
      const methods = Object.getOwnPropertyNames(SoftwareController.prototype);
      expect(methods.indexOf('installerLimits')).toBeGreaterThan(-1);
      expect(methods.indexOf('installerLimits')).toBeLessThan(methods.indexOf('get'));
      expect(Reflect.getMetadata(PATH_METADATA, SoftwareController.prototype.installerLimits)).toBe('installer-limits');
    });
  });

  describe('rotas', () => {
    let service: Record<string, jest.Mock>;
    let controller: SoftwareController;
    const req = { headers: {}, user: { sub: 'user-42', username: 'testuser', role: UserRole.OPERATOR } };

    beforeEach(() => {
      service = { list: jest.fn(), get: jest.fn(), create: jest.fn(), update: jest.fn(), setActive: jest.fn(), remove: jest.fn(), uploadInstaller: jest.fn(), getInstallerLimits: jest.fn() };
      Object.defineProperty(service, 'maxInstallerSizeBytes', { value: 1024 * 1024 });
      controller = new SoftwareController(service as unknown as SoftwareService);
    });

    it.each([
      [undefined, false],
      ['true', true],
      ['false', false],
      ['1', false],
    ])('includeInactive=%p → %p', (query, expected) => {
      controller.list(query);
      expect(service.list).toHaveBeenCalledWith({ includeInactive: expected });
    });

    it('POST valida o corpo e passa o id do usuário do token', () => {
      controller.create({ name: ' App ', version: '1.0', installType: 'msi' }, req);
      expect(service.create).toHaveBeenCalledWith(
        { name: 'App', version: '1.0', vendor: null, installType: 'MSI', installArgs: [] },
        'user-42',
      );
    });

    it('POST com corpo inválido não chega ao service', () => {
      expect(() => controller.create({ name: 'App', version: '1.0', installType: 'SCRIPT' }, req)).toThrow(
        SoftwareValidationError,
      );
      expect(service.create).not.toHaveBeenCalled();
    });

    it('deactivate e activate passam o estado e o id do usuário do token', () => {
      controller.deactivate('id-1', req);
      controller.activate('id-1', req);
      expect(service.setActive.mock.calls).toEqual([
        ['id-1', false, 'user-42'],
        ['id-1', true, 'user-42'],
      ]);
    });

    it('GET installer-limits devolve os limites do service', () => {
      service.getInstallerLimits.mockReturnValue({ maxSizeBytes: 500, storageAvailable: true });
      expect(controller.installerLimits()).toEqual({ maxSizeBytes: 500, storageAvailable: true });
    });

    it('DELETE delega ao service', () => {
      controller.remove('id-1');
      expect(service.remove).toHaveBeenCalledWith('id-1');
    });

    describe('PUT /:id/installer', () => {
      /**
       * Requisição falsa que é um stream de verdade, como a IncomingMessage do Node —
       * inclusive no complete, que o Node marca true quando o corpo chegou inteiro.
       */
      const uploadReq = (headers: Record<string, string> = {}) => {
        const r = Object.assign(new PassThrough(), {
          complete: false,
          user: req.user,
          headers: { 'content-type': 'application/octet-stream', 'x-file-name': '7z.exe', ...headers },
        });
        r.on('end', () => (r.complete = true));
        return r;
      };
      const tick = () => new Promise((r) => setImmediate(r));

      it('o corpo chega ao service por um intermediário — nunca a própria requisição', async () => {
        let received = '';
        service.uploadInstaller.mockImplementation(async (_id, body: Readable) => {
          for await (const chunk of body) received += chunk;
          return 'ok';
        });
        const r = uploadReq({ 'content-length': '7' });
        const pending = controller.uploadInstaller('id-1', r as never);
        r.end('MZ dados');
        await expect(pending).resolves.toBe('ok');
        const [id, body, name, user] = service.uploadInstaller.mock.calls[0];
        expect([id, name, user]).toEqual(['id-1', '7z.exe', 'user-42']);
        expect(body).not.toBe(r);
        expect(received).toBe('MZ dados');
      });

      it('413 pelo Content-Length: não chama o service e DESCARTA o corpo (não fecha a conexão)', async () => {
        const r = uploadReq({ 'content-length': String(2 * 1024 * 1024) });
        await expect(controller.uploadInstaller('id-1', r as never)).rejects.toMatchObject({ status: 413 });
        expect(service.uploadInstaller).not.toHaveBeenCalled();
        expect(r.readableFlowing).toBe(true); // corpo sendo lido e jogado fora
        expect(r.destroyed).toBe(false); // conexão preservada para a resposta chegar
      });

      it('415 também descarta o corpo em vez de fechar', async () => {
        const r = uploadReq({ 'content-type': 'application/json' });
        await expect(controller.uploadInstaller('id-1', r as never)).rejects.toMatchObject({ status: 415 });
        expect(r.readableFlowing).toBe(true);
        expect(r.destroyed).toBe(false);
      });

      it('erro do service no meio (ex.: cabeçalho errado): intermediário destruído, requisição descartada', async () => {
        let body!: Readable;
        service.uploadInstaller.mockImplementation(async (_id, b: Readable) => {
          body = b;
          throw Object.assign(new Error('não é MSI'), { status: 400 });
        });
        const r = uploadReq();
        await expect(controller.uploadInstaller('id-1', r as never)).rejects.toThrow('não é MSI');
        expect(body.destroyed).toBe(true);
        expect(r.destroyed).toBe(false);
        expect(r.readableFlowing).toBe(true);
      });

      it('cliente cancela no meio: o cancelamento chega à gravação (que apaga o .part)', async () => {
        let bodyError: Error | undefined;
        service.uploadInstaller.mockImplementation(
          (_id, b: Readable) =>
            new Promise((_resolve, reject) => {
              b.on('error', (e) => { bodyError = e; reject(e); });
              b.resume();
            }),
        );
        const r = uploadReq();
        const pending = controller.uploadInstaller('id-1', r as never);
        r.write('MZ parcial');
        await tick();
        r.emit('close'); // complete continua false: conexão caiu antes do fim
        await expect(pending).rejects.toThrow('Envio interrompido pelo cliente.');
        expect(bodyError?.message).toBe('Envio interrompido pelo cliente.');
      });
    });

    describe('discardLimit', () => {
      const MB = 1024 * 1024;
      const LIMIT = 500 * MB;

      it.each([
        ['600 MB declarados (um pouco acima do limite)', String(600 * MB), 600 * MB],
        ['exatamente 2× o limite', String(1000 * MB), 1000 * MB],
        ['1 byte acima de 2× o limite', String(1000 * MB + 1), 1000 * MB],
        ['100 GB declarados', String(100 * 1024 * MB), 1000 * MB],
        ['sem Content-Length (em partes)', undefined, LIMIT],
        ['Content-Length inválido', 'abc', LIMIT],
        ['Content-Length 0', '0', LIMIT],
      ])('%s → teto %p bytes', (_caso, header, expected) => {
        expect(discardLimit(header, LIMIT)).toBe(expected);
      });

      it('o teto fixo é 2× o limite e acompanha o limite configurado', () => {
        expect(DISCARD_CEILING_FACTOR).toBe(2);
        expect(discardLimit(String(100 * 1024 * MB), 5 * MB)).toBe(10 * MB);
      });
    });

    describe('discardRemainingBody', () => {
      it('lê e descarta até o teto, e fecha a conexão se passar dele', async () => {
        const r = new PassThrough();
        discardRemainingBody(r, 10);
        r.write(Buffer.alloc(8));
        await new Promise((res) => setImmediate(res));
        expect(r.destroyed).toBe(false);
        r.write(Buffer.alloc(8));
        await new Promise((res) => setImmediate(res));
        expect(r.destroyed).toBe(true);
      });
    });


    it('PATCH valida só os campos enviados e passa o id do usuário do token', () => {
      controller.update('id-1', { vendor: ' Novo ' }, req);
      expect(service.update).toHaveBeenCalledWith('id-1', { vendor: 'Novo' }, 'user-42');
    });
  });
});

describe('SoftwareValidationFilter', () => {
  it('responde 400 com a mensagem e o campo problemático', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;

    new SoftwareValidationFilter().catch(new SoftwareValidationError('installArgs[1]', 'caractere ";"'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'Bad Request',
      message: 'caractere ";"',
      field: 'installArgs[1]',
    });
  });
});
