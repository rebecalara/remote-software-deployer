import { BadRequestException, Logger } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { InventoryController, parseSummaryBody } from '../inventory/inventory.controller';
import { DeploymentsController } from './deployments.controller';

// DEPLOYMENT_MAX_MACHINES: o limite de máquinas por implantação vem do .env, e a tela o lê
// por GET /deployments/limits (em vez de fixar 50 no frontend).

const SW = '11111111-1111-4111-8111-111111111111';
const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

describe('GET /deployments/limits', () => {
  const ORIGINAL = process.env.DEPLOYMENT_MAX_MACHINES;
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DEPLOYMENT_MAX_MACHINES;
    else process.env.DEPLOYMENT_MAX_MACHINES = ORIGINAL;
  });

  const controller = () => new DeploymentsController({ create: jest.fn() } as never);

  it('sem a variável: 50', () => {
    delete process.env.DEPLOYMENT_MAX_MACHINES;
    expect(controller().limits()).toEqual({ maxMachines: 50 });
  });

  it('com a variável: o valor dela, e o POST /deployments usa o mesmo limite', () => {
    process.env.DEPLOYMENT_MAX_MACHINES = '3';
    const c = controller();
    expect(c.limits()).toEqual({ maxMachines: 3 });
    expect(() => c.create({ softwareId: SW, machineIds: ids(4) }, { user: { sub: 'u' } } as never)).toThrow(BadRequestException);
    expect(() => c.create({ softwareId: SW, machineIds: ids(3) }, { user: { sub: 'u' } } as never)).not.toThrow();
  });

  it('valor inválido: volta ao padrão (50)', () => {
    process.env.DEPLOYMENT_MAX_MACHINES = 'muitas';
    expect(controller().limits()).toEqual({ maxMachines: 50 });
  });

  it('é leitura para qualquer usuário logado', () => {
    expect(new Reflector().get<UserRole[] | undefined>(ROLES_KEY, DeploymentsController.prototype.limits)).toBeUndefined();
  });

  it('é declarada ANTES de :id (senão ":id" capturaria "limits")', () => {
    const methods = Object.getOwnPropertyNames(DeploymentsController.prototype);
    expect(methods.indexOf('limits')).toBeGreaterThan(-1);
    expect(methods.indexOf('limits')).toBeLessThan(methods.indexOf('get'));
    expect(Reflect.getMetadata(PATH_METADATA, DeploymentsController.prototype.limits)).toBe('limits');
  });

  it('o resumo do inventário (passo Desinstalar) aceita o mesmo número de máquinas', () => {
    expect(parseSummaryBody({ machineIds: ids(3) }, 3)).toHaveLength(3);
    expect(() => parseSummaryBody({ machineIds: ids(4) }, 3)).toThrow(BadRequestException);

    process.env.DEPLOYMENT_MAX_MACHINES = '3';
    const summary = jest.fn().mockResolvedValue({});
    const inventory = new InventoryController({ summary } as never);
    expect(() => inventory.summary({ machineIds: ids(4) })).toThrow(BadRequestException);
  });
});
