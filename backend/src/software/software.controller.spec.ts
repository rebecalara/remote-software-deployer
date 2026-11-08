import { ArgumentsHost } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CATALOG_WRITE_ROLES, SoftwareController } from './software.controller';
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

    it.each(['create', 'update'] as const)('%s usa @CanWriteCatalog (VIEWER fica de fora)', (method) => {
      expect(rolesOf(method)).toEqual(CATALOG_WRITE_ROLES);
      expect(rolesOf(method)).not.toContain(UserRole.VIEWER);
    });

    it.each(['list', 'get'] as const)('%s é leitura: qualquer usuário logado', (method) => {
      expect(rolesOf(method)).toBeUndefined();
    });
  });

  describe('rotas', () => {
    let service: { list: jest.Mock; get: jest.Mock; create: jest.Mock; update: jest.Mock };
    let controller: SoftwareController;
    const req = { headers: {}, user: { sub: 'user-42', username: 'testuser', role: UserRole.OPERATOR } };

    beforeEach(() => {
      service = { list: jest.fn(), get: jest.fn(), create: jest.fn(), update: jest.fn() };
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
