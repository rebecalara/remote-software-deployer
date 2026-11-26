import { Logger } from '@nestjs/common';
import { DeploymentStatus } from '@prisma/client';
import { DeploymentRunner } from './deployment-runner';

// Evento de segurança "deployment.finished": só quem de fato fecha a implantação registra.

describe('DeploymentRunner.finalizeDeployment — evento deployment.finished', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const runnerWith = (statuses: DeploymentStatus[], closedCount: number) => {
    const prisma = {
      deploymentTarget: { findMany: jest.fn().mockResolvedValue(statuses.map((status) => ({ status }))) },
      deployment: { updateMany: jest.fn().mockResolvedValue({ count: closedCount }) },
    };
    return new DeploymentRunner(prisma as never, { isAvailable: false } as never, {} as never);
  };
  const events = () =>
    log.mock.calls
      .map(([m]) => m as { attributes?: Record<string, unknown> })
      .filter((m) => m?.attributes?.['security.event'] === 'deployment.finished')
      .map((m) => m.attributes);

  it('fechou agora: evento com o status calculado (Parcial) e as contagens, sem usuário nem IP', async () => {
    await runnerWith([DeploymentStatus.SUCCEEDED, DeploymentStatus.FAILED, DeploymentStatus.CANCELLED], 1).finalizeDeployment('d-1');
    expect(events()).toEqual([
      {
        'security.event': 'deployment.finished',
        'security.result': 'success',
        'security.pii': true,
        'deployment.id': 'd-1',
        'deployment.status': 'PARTIAL',
        'deployment.machines': 3,
        'deployment.succeeded': 1,
        'deployment.failed': 1,
        'deployment.cancelled_machines': 1,
      },
    ]);
  });

  it('outra chamada já tinha fechado (count 0): nenhum evento repetido', async () => {
    await runnerWith([DeploymentStatus.SUCCEEDED], 0).finalizeDeployment('d-2');
    expect(events()).toEqual([]);
  });

  it('ainda há máquina pendente: não fecha e não registra', async () => {
    await runnerWith([DeploymentStatus.SUCCEEDED, DeploymentStatus.PENDING], 1).finalizeDeployment('d-3');
    expect(events()).toEqual([]);
  });
});
