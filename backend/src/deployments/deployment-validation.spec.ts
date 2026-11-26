import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_MAX_MACHINES,
  MAX_MACHINES_CEILING,
  parseMaxMachines,
  validateDeploymentCreate,
} from './deployment-validation';

const SW = '11111111-1111-4111-8111-111111111111';
const M1 = '22222222-2222-4222-8222-222222222222';
const M2 = '33333333-3333-4333-8333-333333333333';

function errorOf(body: unknown): { message: string; field: string } {
  try {
    validateDeploymentCreate(body);
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as { message: string; field: string };
  }
  throw new Error('deveria ter recusado');
}

describe('validateDeploymentCreate', () => {
  it('aceita o corpo válido, sem repetir máquinas e sem nome', () => {
    expect(validateDeploymentCreate({ softwareId: SW, machineIds: [M1, M2, M1.toUpperCase()] })).toEqual({
      action: 'INSTALL',
      softwareId: SW,
      productCode: null,
      programId: null,
      machineIds: [M1, M2],
      name: null,
    });
  });

  it('apara o nome e trata nome vazio como ausente', () => {
    expect(validateDeploymentCreate({ softwareId: SW, machineIds: [M1], name: '  Lab 2  ' }).name).toBe('Lab 2');
    expect(validateDeploymentCreate({ softwareId: SW, machineIds: [M1], name: '   ' }).name).toBeNull();
  });

  it.each([
    [null, 'body'],
    [[], 'body'],
    [{ softwareId: SW, machineIds: [M1], status: 'SUCCEEDED' }, 'status'],
    [{ machineIds: [M1] }, 'softwareId'],
    [{ softwareId: 'abc', machineIds: [M1] }, 'softwareId'],
    [{ softwareId: SW }, 'machineIds'],
    [{ softwareId: SW, machineIds: [] }, 'machineIds'],
    [{ softwareId: SW, machineIds: M1 }, 'machineIds'],
    [{ softwareId: SW, machineIds: [M1, 42] }, 'machineIds'],
    [{ softwareId: SW, machineIds: ['WS-001'] }, 'machineIds'],
    [{ softwareId: SW, machineIds: [M1], name: 5 }, 'name'],
    [{ softwareId: SW, machineIds: [M1], name: 'a\nb' }, 'name'],
    [{ softwareId: SW, machineIds: [M1], name: 'x'.repeat(121) }, 'name'],
  ])('recusa %p no campo %p', (body, field) => {
    expect(errorOf(body).field).toBe(field);
  });

  it(`recusa mais de ${DEFAULT_MAX_MACHINES} máquinas (contando sem repetição)`, () => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(validateDeploymentCreate({ softwareId: SW, machineIds: ids(DEFAULT_MAX_MACHINES) }).machineIds)
      .toHaveLength(DEFAULT_MAX_MACHINES);
    expect(errorOf({ softwareId: SW, machineIds: ids(DEFAULT_MAX_MACHINES + 1) }).message).toBe(
      `Selecione no máximo ${DEFAULT_MAX_MACHINES} máquinas por implantação.`,
    );
    const repeated = [...ids(DEFAULT_MAX_MACHINES), ...ids(10)];
    expect(validateDeploymentCreate({ softwareId: SW, machineIds: repeated }).machineIds).toHaveLength(
      DEFAULT_MAX_MACHINES,
    );
  });

  it('o limite vem de fora (DEPLOYMENT_MAX_MACHINES): com 5, recusa a sexta máquina', () => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(validateDeploymentCreate({ softwareId: SW, machineIds: ids(5) }, 5).machineIds).toHaveLength(5);
    let error: BadRequestException | undefined;
    try {
      validateDeploymentCreate({ softwareId: SW, machineIds: ids(6) }, 5);
    } catch (err) {
      error = err as BadRequestException;
    }
    expect(error?.getResponse()).toMatchObject({
      message: 'Selecione no máximo 5 máquinas por implantação.',
      field: 'machineIds',
    });
  });
});

describe('parseMaxMachines (DEPLOYMENT_MAX_MACHINES)', () => {
  it('padrão 50; ausente ou vazio usa o padrão sem aviso', () => {
    const warn = jest.fn();
    expect(DEFAULT_MAX_MACHINES).toBe(50);
    expect(parseMaxMachines(undefined, warn)).toBe(50);
    expect(parseMaxMachines('  ', warn)).toBe(50);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['1', 1],
    ['120', 120],
    [' 200 ', 200],
    [String(MAX_MACHINES_CEILING), MAX_MACHINES_CEILING],
  ])('aceita %p → %p', (raw, expected) => {
    const warn = jest.fn();
    expect(parseMaxMachines(raw, warn)).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['0', '-5', 'abc', '1.5', '1e2', '0x10', '+50', '50abc'])('valor inválido %p → padrão, com aviso', (raw) => {
    const warn = jest.fn();
    expect(parseMaxMachines(raw, warn)).toBe(50);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DEPLOYMENT_MAX_MACHINES'));
  });

  it('acima do teto (500) → teto, com aviso', () => {
    const warn = jest.fn();
    expect(MAX_MACHINES_CEILING).toBe(500);
    expect(parseMaxMachines('501', warn)).toBe(500);
    expect(parseMaxMachines('100000', warn)).toBe(500);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
