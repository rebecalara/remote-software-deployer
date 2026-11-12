import { BadRequestException } from '@nestjs/common';
import { MAX_TARGETS_PER_DEPLOYMENT, validateDeploymentCreate } from './deployment-validation';

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
      softwareId: SW,
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

  it(`recusa mais de ${MAX_TARGETS_PER_DEPLOYMENT} máquinas (contando sem repetição)`, () => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(validateDeploymentCreate({ softwareId: SW, machineIds: ids(MAX_TARGETS_PER_DEPLOYMENT) }).machineIds)
      .toHaveLength(MAX_TARGETS_PER_DEPLOYMENT);
    expect(errorOf({ softwareId: SW, machineIds: ids(MAX_TARGETS_PER_DEPLOYMENT + 1) }).message).toBe(
      `Selecione no máximo ${MAX_TARGETS_PER_DEPLOYMENT} máquinas por implantação.`,
    );
    const repeated = [...ids(MAX_TARGETS_PER_DEPLOYMENT), ...ids(10)];
    expect(validateDeploymentCreate({ softwareId: SW, machineIds: repeated }).machineIds).toHaveLength(
      MAX_TARGETS_PER_DEPLOYMENT,
    );
  });
});
