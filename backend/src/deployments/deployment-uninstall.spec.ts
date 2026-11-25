import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { DeploymentAction, DeploymentStatus as S, InstallType, LogLevel } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { interpretExitCode, interpretResult } from './deployment-outcome';
import { DeploymentRunner } from './deployment-runner';
import { validateDeploymentCreate } from './deployment-validation';
import { DeploymentsService, EXE_UNINSTALL_UNAVAILABLE, MISSING_PRODUCT_CODE } from './deployments.service';
import {
  DEPLOY_SCRIPT_PATH,
  DeployEvent,
  DeployResult,
  DeployTargetInput,
  PowerShellExecutor,
  UninstallTargetInput,
  loadPowerShellExecutorConfig,
  parseLine,
} from './powershell-executor';
import { createInMemoryPrisma } from './testing/in-memory-prisma';
import { REAL_POWERSHELL_TEST_TIMEOUT_MS } from './testing/real-powershell';

// Desinstalação remota (só MSI): acréscimo fora do RFC, aprovado pela autora.

const CODE = '{23170F69-40C1-2702-2606-000001000000}';
const SW = '11111111-1111-4111-8111-111111111111';
const M1 = '22222222-2222-4222-8222-222222222222';
const U = DeploymentAction.UNINSTALL;

describe('validateDeploymentCreate — ação', () => {
  it('ausente = INSTALL; aceita UNINSTALL', () => {
    expect(validateDeploymentCreate({ softwareId: SW, machineIds: [M1] }).action).toBe('INSTALL');
    expect(validateDeploymentCreate({ action: 'UNINSTALL', softwareId: SW, machineIds: [M1] }).action).toBe('UNINSTALL');
  });

  it.each(['uninstall', 'REMOVE', 1, null])('recusa ação %p com 400 no campo action', (action) => {
    try {
      validateDeploymentCreate({ action, softwareId: SW, machineIds: [M1] });
      throw new Error('deveria ter recusado');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect(((err as BadRequestException).getResponse() as { field: string }).field).toBe('action');
    }
  });
});

describe('interpretResult / interpretExitCode — desinstalação', () => {
  it('"não estava instalado" (conferido antes): sucesso com aviso, sem código, nada executado', () => {
    expect(interpretResult({ ok: true, notInstalled: true, productCode: CODE }, InstallType.MSI, U)).toEqual({
      status: S.SUCCEEDED,
      level: LogLevel.WARN,
      message: `Não estava instalado: o produto (ProductCode ${CODE}) não está instalado na máquina. A desinstalação não foi executada.`,
      exitCode: null,
    });
  });

  it('0 → "Desinstalação concluída"; 3010 e 1641 → sucesso com aviso, como na instalação', () => {
    expect(interpretExitCode(0, InstallType.MSI, U)).toEqual({
      status: S.SUCCEEDED,
      level: LogLevel.INFO,
      message: 'Desinstalação concluída (código 0).',
    });
    expect(interpretExitCode(3010, InstallType.MSI, U)).toMatchObject({ status: S.SUCCEEDED, level: LogLevel.WARN });
    expect(interpretExitCode(3010, InstallType.MSI, U).message).toContain('o sistema não reinicia a máquina');
    expect(interpretExitCode(1641, InstallType.MSI, U)).toMatchObject({ status: S.SUCCEEDED, level: LogLevel.WARN });
  });

  it('1605 → sucesso com o aviso "não estava instalado" (decisão da autora), com o código gravado', () => {
    const outcome = interpretResult({ ok: true, exitCode: 1605 }, InstallType.MSI, U);
    expect(outcome).toMatchObject({ status: S.SUCCEEDED, level: LogLevel.WARN, exitCode: 1605 });
    expect(outcome.message).toMatch(/^Não estava instalado/);
  });

  it('1612, 1603 e desconhecido → falha com mensagem da desinstalação', () => {
    expect(interpretExitCode(1612, InstallType.MSI, U)).toMatchObject({ status: S.FAILED, level: LogLevel.ERROR });
    expect(interpretExitCode(1612, InstallType.MSI, U).message).toContain('código 1612');
    expect(interpretExitCode(1603, InstallType.MSI, U).message).toBe('Erro fatal durante a desinstalação (código 1603).');
    expect(interpretExitCode(42, InstallType.MSI, U).message).toBe('O desinstalador terminou com o código 42, que indica falha.');
  });

  it('a instalação continua igual (1605 numa instalação é falha)', () => {
    expect(interpretExitCode(0, InstallType.MSI).message).toBe('Instalação concluída (código 0).');
    expect(interpretExitCode(1605, InstallType.MSI)).toMatchObject({ status: S.FAILED });
  });
});

describe('DeploymentRunner — desinstalação', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

  function setup(softwareOverrides: Record<string, unknown> = {}) {
    const db = createInMemoryPrisma();
    db.software.set('sw', {
      id: 'sw',
      name: '7-Zip',
      version: '26.06',
      installType: 'MSI',
      installArgs: ['ALLUSERS=1'],
      installerFileName: null,
      installerSizeBytes: null,
      installerSha256: null,
      msiProductCode: CODE,
      ...softwareOverrides,
    } as never);
    db.deployments.set('d1', { id: 'd1', softwareId: 'sw', status: S.PENDING, startedAt: null, finishedAt: null, action: U } as never);
    db.machines.set('m1', { id: 'm1', hostname: 'WS-001' });
    db.targets.set('t1', { id: 't1', deploymentId: 'd1', machineId: 'm1', status: S.PENDING, startedAt: null, finishedAt: null, exitCode: null });
    const run = jest.fn<Promise<DeployResult>, [DeployTargetInput, (e: DeployEvent) => void]>();
    const storage = { exists: jest.fn().mockResolvedValue(false), localPath: jest.fn() };
    const runner = new DeploymentRunner(db.prisma as never, { isAvailable: true, run } as never, storage as never);
    const logs = () => db.logs.filter((l) => l.deploymentTargetId === 't1').map((l) => [l.level, l.message]);
    return { db, run, storage, runner, logs };
  }

  it('só o ProductCode vai ao executor: nenhum arquivo, nenhum argumento do catálogo', async () => {
    const { db, run, storage, runner, logs } = setup();
    run.mockResolvedValue({ ok: true, exitCode: 0 });
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });

    expect(run).toHaveBeenCalledWith(
      { action: 'UNINSTALL', targetId: 't1', computerName: 'WS-001', installType: 'MSI', productCode: CODE },
      expect.any(Function),
    );
    // O instalador nem precisa existir na pasta.
    expect(storage.exists).not.toHaveBeenCalled();
    expect(logs()).toEqual([
      [LogLevel.INFO, 'Iniciando a desinstalação de 7-Zip 26.06 em WS-001.'],
      [LogLevel.INFO, 'Desinstalação concluída (código 0).'],
    ]);
    expect(db.targets.get('t1')).toMatchObject({ status: S.SUCCEEDED, exitCode: 0 });
    expect(db.deployments.get('d1')).toMatchObject({ status: S.SUCCEEDED });
  });

  it('"não estava instalado": sucesso, sem código, com o aviso', async () => {
    const { db, run, runner, logs } = setup();
    run.mockResolvedValue({ ok: true, notInstalled: true, productCode: CODE });
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });
    expect(db.targets.get('t1')).toMatchObject({ status: S.SUCCEEDED, exitCode: null });
    expect(logs()[1][0]).toBe(LogLevel.WARN);
    expect(logs()[1][1]).toMatch(/^Não estava instalado/);
  });

  it('sem ProductCode no software: falha sem chamar o executor', async () => {
    const { db, run, runner } = setup({ msiProductCode: null });
    await runner.runTarget({ targetId: 't1', machineId: 'm1' });
    expect(run).not.toHaveBeenCalled();
    expect(db.targets.get('t1')).toMatchObject({ status: S.FAILED });
  });
});

describe('DeploymentsService.create — desinstalação', () => {
  const SYNC = new Date('2026-11-17T10:00:00Z');
  function setup(softwareOverrides: Record<string, unknown> = {}) {
    const prisma = {
      software: {
        findUnique: jest.fn().mockResolvedValue({
          id: SW,
          name: '7-Zip',
          version: '26.06',
          installType: 'MSI',
          active: true,
          installerFileName: null,
          msiProductCode: CODE,
          ...softwareOverrides,
        }),
      },
      machine: {
        findMany: jest.fn().mockResolvedValue([{ id: M1, hostname: 'WS-001', lastSync: SYNC }]),
        aggregate: jest.fn().mockResolvedValue({ _max: { lastSync: SYNC } }),
      },
      deployment: {
        create: jest.fn(async ({ data }) => ({
          id: 'dep-1',
          name: data.name,
          action: data.action,
          status: 'PENDING',
          createdAt: SYNC,
          startedAt: null,
          finishedAt: null,
          software: { id: SW, name: '7-Zip', version: '26.06', installType: 'MSI' },
          user: { username: 'testuser', displayName: null },
          targets: [{ id: 't-1', machineId: M1, status: 'PENDING', startedAt: null, finishedAt: null, exitCode: null, machine: { hostname: 'WS-001' }, logs: [] }],
        })),
      },
    };
    const storage = { isAvailable: true, exists: jest.fn().mockResolvedValue(false) };
    const softwareService = { ensureMsiProductCode: jest.fn().mockResolvedValue(null) };
    const service = new DeploymentsService(
      prisma as never,
      { isAvailable: true, unavailableReason: null } as never,
      storage as never,
      { enqueue: jest.fn() } as never,
      softwareService as never,
    );
    const input = { action: 'UNINSTALL' as const, softwareId: SW, productCode: null as string | null, programId: null as string | null, machineIds: [M1], name: null };
    return { prisma, storage, softwareService, service, input };
  }

  it('MSI com ProductCode: cria como UNINSTALL, com nome "Desinstalar …", sem exigir o arquivo na pasta', async () => {
    const { prisma, storage, service, input } = setup();
    const view = await service.create(input, 'user-1');
    expect(prisma.deployment.create.mock.calls[0][0].data).toMatchObject({
      action: 'UNINSTALL',
      name: 'Desinstalar 7-Zip 26.06 — 1 máquina',
    });
    expect(view.action).toBe('UNINSTALL');
    expect(storage.exists).not.toHaveBeenCalled();
  });

  it('software desativado PODE ser desinstalado (instalar continua exigindo ativo)', async () => {
    const { service, input } = setup({ active: false });
    await expect(service.create(input, 'user-1')).resolves.toMatchObject({ action: 'UNINSTALL' });
    await expect(service.create({ ...input, action: 'INSTALL' }, 'user-1')).rejects.toThrow(
      'Este software está desativado e não pode ser implantado.',
    );
  });

  it('EXE: 409 com a explicação', async () => {
    const { service, input } = setup({ installType: 'EXE', msiProductCode: null });
    await expect(service.create(input, 'user-1')).rejects.toThrow(new ConflictException(EXE_UNINSTALL_UNAVAILABLE));
  });

  it('MSI sem ProductCode gravado: tenta ler agora; se não conseguir, 409', async () => {
    const { service, softwareService, input } = setup({ msiProductCode: null });
    await expect(service.create(input, 'user-1')).rejects.toThrow(new ConflictException(MISSING_PRODUCT_CODE));
    expect(softwareService.ensureMsiProductCode).toHaveBeenCalledWith(SW);

    softwareService.ensureMsiProductCode.mockResolvedValue(CODE);
    await expect(service.create(input, 'user-1')).resolves.toMatchObject({ action: 'UNINSTALL' });
  });
});

describe('PowerShellExecutor — protocolo da desinstalação', () => {
  const FAKE = join(__dirname, 'testing', 'fake-powershell.js');
  const executor = new PowerShellExecutor({
    command: process.execPath,
    args: [FAKE],
    credential: null,
    connectTimeoutSeconds: 30,
    installTimeoutSeconds: 1800,
    copyMinBytesPerSecond: 1024 * 1024,
    copyBaseSeconds: 60,
    watchdogMarginSeconds: 120,
    unavailableReason: null,
  });
  const uninstall = (computerName: string): UninstallTargetInput => ({
    action: 'UNINSTALL',
    targetId: '11111111-2222-4333-8444-555555555555',
    computerName,
    installType: 'MSI',
    productCode: CODE,
  });

  it('repassa "não estava instalado" com o ProductCode normalizado', async () => {
    const result = await executor.run(uninstall('FAKE-NOT-INSTALLED'), () => undefined);
    expect(result).toEqual({ ok: true, notInstalled: true, productCode: CODE });
  });

  it('envia ação e ProductCode pelo stdin, sem caminho de instalador nem argumentos', async () => {
    const events: DeployEvent[] = [];
    await executor.run(uninstall('FAKE-ECHO'), (e) => events.push(e));
    const echoed = JSON.parse(events[1].message.replace(/^input=/, ''));
    expect(echoed).toMatchObject({ action: 'UNINSTALL', productCode: CODE, installType: 'MSI' });
    expect(echoed).not.toHaveProperty('installerPath');
    expect(echoed).not.toHaveProperty('installArgs');
  });

  it('parseLine: "não instalado" só com ProductCode no formato GUID', () => {
    expect(parseLine(JSON.stringify({ type: 'result', ok: true, notInstalled: true, productCode: CODE.toLowerCase() }))).toEqual({
      type: 'result',
      result: { ok: true, notInstalled: true, productCode: CODE },
    });
    expect(parseLine(JSON.stringify({ type: 'result', ok: true, notInstalled: true, productCode: 'x' }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: 'log', level: 'INFO', phase: 'uninstall', message: 'm' }))).toEqual({
      type: 'log',
      level: LogLevel.INFO,
      phase: 'uninstall',
      message: 'm',
    });
  });
});

describe('deploy-target.ps1 — desinstalação', () => {
  const text = readFileSync(DEPLOY_SCRIPT_PATH, 'utf8');

  it('comando fixo: msiexec /x {ProductCode} /qn /norestart com REBOOT=ReallySuppress por ÚLTIMO', () => {
    expect(text).toContain("-ArgumentList @('/x', $Code, '/qn', '/norestart', 'REBOOT=ReallySuppress')");
  });

  it('confere se o produto está instalado ANTES de desinstalar, e nada é copiado', () => {
    const block = text.slice(text.indexOf("if ($action -eq 'UNINSTALL') {"), text.indexOf("if ($action -eq 'INSTALL') {\n    # --- Cópia"));
    const check = block.indexOf("'ProductState'");
    const exec = block.indexOf("'/x'");
    expect(check).toBeGreaterThan(0);
    expect(exec).toBeGreaterThan(check);
    expect(block).toContain('if ($state -ne 5)');
    // Sem cópia, sem compartilhamento administrativo e sem argumentos do catálogo.
    expect(block).not.toMatch(/New-PSDrive|Copy-Item|\$extra|installArgs/);
  });

  const onWindows = process.platform === 'win32' ? describe : describe.skip;
  onWindows('com o powershell.exe real (sem tocar em nenhuma máquina)', () => {
    const real = new PowerShellExecutor(loadPowerShellExecutorConfig({ SystemRoot: process.env.SystemRoot }));
    const base: UninstallTargetInput = {
      action: 'UNINSTALL',
      targetId: '11111111-2222-4333-8444-555555555555',
      computerName: 'rsd-inexistente.invalid',
      installType: 'MSI',
      productCode: CODE,
    };
    const invalid = (message: string) => ({ ok: false, phase: 'validate', reason: 'invalid-input', message });

    it('recusa ProductCode fora do formato, antes de qualquer conexão', async () => {
      const events: DeployEvent[] = [];
      const result = await real.run({ ...base, productCode: '{x}; Remove-Item C:\\' }, (e) => events.push(e));
      expect(result).toEqual(invalid('ProductCode inválido.'));
      expect(events).toEqual([]);
    }, REAL_POWERSHELL_TEST_TIMEOUT_MS);

    it('recusa desinstalação de EXE e campos da instalação misturados', async () => {
      expect(await real.run({ ...base, installType: 'EXE' as never }, () => undefined)).toEqual(
        invalid('Desinstalação disponível só para MSI.'),
      );
      expect(await real.run({ ...base, installArgs: ['/S'] } as never, () => undefined)).toEqual(
        invalid('Campo não aceito na desinstalação: installArgs.'),
      );
    }, REAL_POWERSHELL_TEST_TIMEOUT_MS);

    it('com entrada válida, segue para a resolução de nome (DNS .invalid)', async () => {
      const result = await real.run(base, () => undefined);
      expect(result).toMatchObject({ ok: false, phase: 'resolve', reason: 'dns' });
    }, REAL_POWERSHELL_TEST_TIMEOUT_MS);
  });
});
