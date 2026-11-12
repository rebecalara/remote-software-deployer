import { Logger } from '@nestjs/common';
import { DeploymentStatus as S, LogLevel } from '@prisma/client';
import { DeploymentRunner, RESTART_MESSAGE_PENDING, RESTART_MESSAGE_RUNNING } from './deployment-runner';
import { DeployEvent, DeployResult, DeployTargetInput } from './powershell-executor';
import { createInMemoryPrisma } from './testing/in-memory-prisma';

const FILE = '0f0e0d0c-0b0a-4908-8706-050403020100.msi';
const SHA = 'A'.repeat(64);

type RunImpl = (input: DeployTargetInput, onEvent: (e: DeployEvent) => void) => Promise<DeployResult>;

function setup(options: { maxParallel?: string } = {}) {
  const db = createInMemoryPrisma();
  db.software.set('sw', {
    id: 'sw',
    name: '7-Zip',
    version: '26.06',
    installType: 'MSI',
    installArgs: ['ALLUSERS=1'],
    installerFileName: FILE,
    installerSizeBytes: 1_500_000,
    installerSha256: SHA,
  });
  db.deployments.set('d1', { id: 'd1', softwareId: 'sw', status: S.PENDING, startedAt: null, finishedAt: null });
  for (const n of [1, 2]) {
    db.machines.set(`m${n}`, { id: `m${n}`, hostname: `WS-00${n}` });
    db.targets.set(`t${n}`, {
      id: `t${n}`, deploymentId: 'd1', machineId: `m${n}`,
      status: S.PENDING, startedAt: null, finishedAt: null, exitCode: null,
    });
  }

  const run = jest.fn<Promise<DeployResult>, Parameters<RunImpl>>();
  const executor = { isAvailable: true, run };
  const storage = {
    exists: jest.fn().mockResolvedValue(true),
    localPath: jest.fn((name: string) => `C:\\rsd-data\\installers\\${name}`),
  };

  const previous = process.env.DEPLOYMENT_MAX_PARALLEL;
  process.env.DEPLOYMENT_MAX_PARALLEL = options.maxParallel ?? '';
  const runner = new DeploymentRunner(db.prisma as never, executor as never, storage as never);
  process.env.DEPLOYMENT_MAX_PARALLEL = previous;

  const logsOf = (targetId: string) => db.logs.filter((l) => l.deploymentTargetId === targetId);
  const lastLog = (targetId: string) => logsOf(targetId)[logsOf(targetId).length - 1];
  return { db, run, storage, runner, logsOf, lastLog };
}

describe('DeploymentRunner', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

  it('executa a máquina, grava os passos em ordem e fecha a implantação', async () => {
    const { db, run, runner, logsOf, lastLog } = setup();
    db.targets.delete('t2');
    run.mockImplementation(async (_input, onEvent) => {
      onEvent({ level: LogLevel.INFO, phase: 'connect', message: 'Sessão WinRM aberta.' });
      onEvent({ level: LogLevel.INFO, phase: 'install', message: 'O instalador terminou com o código 0.' });
      return { ok: true, exitCode: 0 };
    });

    await runner.runTarget({ targetId: 't1', machineId: 'm1' });

    expect(run).toHaveBeenCalledWith(
      {
        targetId: 't1',
        computerName: 'WS-001',
        installerPath: `C:\\rsd-data\\installers\\${FILE}`,
        installerSizeBytes: 1_500_000,
        sha256: SHA,
        installType: 'MSI',
        installArgs: ['ALLUSERS=1'],
      },
      expect.any(Function),
    );
    expect(logsOf('t1').map((l) => [l.level, l.message])).toEqual([
      [LogLevel.INFO, 'Iniciando a instalação de 7-Zip 26.06 em WS-001.'],
      [LogLevel.INFO, 'Sessão WinRM aberta.'],
      [LogLevel.INFO, 'O instalador terminou com o código 0.'],
      [LogLevel.INFO, 'Instalação concluída (código 0).'],
    ]);
    const times = logsOf('t1').map((l) => l.timestamp.getTime());
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true);

    expect(db.targets.get('t1')).toMatchObject({ status: S.SUCCEEDED, exitCode: 0 });
    expect(db.targets.get('t1')!.startedAt).toBeInstanceOf(Date);
    expect(db.targets.get('t1')!.finishedAt).toBeInstanceOf(Date);
    expect(db.deployments.get('d1')).toMatchObject({ status: S.SUCCEEDED });
    expect(db.deployments.get('d1')!.startedAt).toBeInstanceOf(Date);
    expect(db.deployments.get('d1')!.finishedAt).toBeInstanceOf(Date);
  });

  it('3010 conta como sucesso, com aviso de reinício e o código gravado', async () => {
    const { db, run, runner, logsOf, lastLog } = setup();
    run.mockResolvedValue({ ok: true, exitCode: 3010 });
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });

    expect(db.targets.get('t1')).toMatchObject({ status: S.SUCCEEDED, exitCode: 3010 });
    expect(lastLog('t1')).toMatchObject({ level: LogLevel.WARN });
    expect(lastLog('t1')!.message).toContain('o sistema não reinicia a máquina');
  });

  it('falha antes de executar: FAILED, sem código de saída, com o motivo no log', async () => {
    const { db, run, runner, logsOf, lastLog } = setup();
    run.mockResolvedValue({ ok: false, phase: 'connect', reason: 'unreachable', message: 'WS-001 não respondeu.' });
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });

    expect(db.targets.get('t1')).toMatchObject({ status: S.FAILED, exitCode: null });
    expect(lastLog('t1')).toMatchObject({ level: LogLevel.ERROR, message: 'WS-001 não respondeu.' });
  });

  it('código de falha do instalador: FAILED com o código gravado', async () => {
    const { db, run, runner } = setup();
    run.mockResolvedValue({ ok: true, exitCode: 1603 });
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });
    expect(db.targets.get('t1')).toMatchObject({ status: S.FAILED, exitCode: 1603 });
  });

  it('a implantação só fecha quando todas as máquinas terminam; uma falha deixa FAILED', async () => {
    const { db, run, runner } = setup();
    run.mockResolvedValueOnce({ ok: true, exitCode: 0 });
    run.mockResolvedValueOnce({ ok: true, exitCode: 1603 });

    await runner.runTarget({ targetId: 't1', machineId: 'm1' });
    expect(db.deployments.get('d1')).toMatchObject({ status: S.RUNNING, finishedAt: null });

    await runner.runTarget({ targetId: 't2', machineId: 'm2' });
    expect(db.deployments.get('d1')).toMatchObject({ status: S.FAILED });
    expect(db.deployments.get('d1')!.finishedAt).toBeInstanceOf(Date);
  });

  it('não executa máquina que deixou de estar PENDING (ex.: cancelada na fila)', async () => {
    const { db, run, runner, logsOf, lastLog } = setup();
    db.targets.get('t1')!.status = S.CANCELLED;
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });

    expect(run).not.toHaveBeenCalled();
    expect(logsOf('t1')).toEqual([]);
    expect(db.targets.get('t1')!.status).toBe(S.CANCELLED);
  });

  it('não chama o executor se o arquivo do instalador sumiu do servidor', async () => {
    const { db, run, storage, runner, lastLog } = setup();
    storage.exists.mockResolvedValue(false);
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });

    expect(run).not.toHaveBeenCalled();
    expect(db.targets.get('t1')).toMatchObject({ status: S.FAILED, exitCode: null });
    expect(lastLog('t1')!.message).toBe(
      'O arquivo do instalador não foi encontrado na pasta de instaladores do servidor.',
    );
  });

  it('erro inesperado no meio: a máquina vira FAILED e a implantação ainda fecha', async () => {
    const { db, run, runner, logsOf, lastLog } = setup();
    db.targets.delete('t2');
    run.mockRejectedValue(new Error('bug'));
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });

    expect(db.targets.get('t1')!.status).toBe(S.FAILED);
    expect(lastLog('t1')!.message).toBe('Erro interno do servidor durante a implantação. Confira a máquina.');
    expect(db.deployments.get('d1')!.status).toBe(S.FAILED);
  });

  it('falha ao gravar um log não interrompe a instalação', async () => {
    const { db, run, runner } = setup();
    db.prisma.deploymentLog.create.mockRejectedValueOnce(new Error('banco ocupado'));
    run.mockResolvedValue({ ok: true, exitCode: 0 });
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });
    expect(db.targets.get('t1')!.status).toBe(S.SUCCEEDED);
  });

  it('pela fila: executa todas as máquinas e fecha a implantação', async () => {
    const { db, run, runner } = setup({ maxParallel: '2' });
    run.mockResolvedValue({ ok: true, exitCode: 0 });
    runner.enqueue([
      { targetId: 't1', machineId: 'm1' },
      { targetId: 't2', machineId: 'm2' },
    ]);
    await runner.whenIdle();

    expect(run).toHaveBeenCalledTimes(2);
    expect(db.deployments.get('d1')!.status).toBe(S.SUCCEEDED);
  });

  describe('recuperação na subida', () => {
    it('marca como falha o que estava pendente ou em execução, com o motivo, e fecha a implantação', async () => {
      const { db, runner, logsOf } = setup();
      db.targets.get('t1')!.status = S.RUNNING;
      db.deployments.get('d1')!.status = S.RUNNING;

      await runner.onApplicationBootstrap();

      expect(db.targets.get('t1')!.status).toBe(S.FAILED);
      expect(db.targets.get('t2')!.status).toBe(S.FAILED);
      expect(logsOf('t1').map((l) => l.message)).toEqual([RESTART_MESSAGE_RUNNING]);
      expect(logsOf('t2').map((l) => l.message)).toEqual([RESTART_MESSAGE_PENDING]);
      expect(db.deployments.get('d1')!.status).toBe(S.FAILED);
      expect(db.deployments.get('d1')!.finishedAt).toBeInstanceOf(Date);
    });

    it('não mexe em nada quando não há execução interrompida', async () => {
      const { db, runner } = setup();
      db.targets.forEach((t) => (t.status = S.SUCCEEDED));
      await runner.onApplicationBootstrap();
      expect(db.prisma.$transaction).not.toHaveBeenCalled();
      expect(db.logs).toEqual([]);
    });
  });
});
