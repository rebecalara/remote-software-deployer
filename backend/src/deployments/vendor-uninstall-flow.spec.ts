import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { DeploymentStatus as S, InstallType, LogLevel } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INVENTORY_STALE_DAYS, InventoryService, NO_QUIET_UNINSTALL, OUTDATED_INVENTORY, uninstallInfo } from '../inventory/inventory.service';
import { interpretResult } from './deployment-outcome';
import { DeploymentRunner } from './deployment-runner';
import { validateDeploymentCreate } from './deployment-validation';
import { DeploymentsService } from './deployments.service';
import {
  DEPLOY_SCRIPT_PATH,
  DeployEvent,
  DeployResult,
  PROGRAM_UNINSTALL_SCRIPT_PATH,
  PowerShellExecutor,
  ProgramUninstallInput,
  loadPowerShellExecutorConfig,
  parseProgramUninstallLine,
} from './powershell-executor';
import { createInMemoryPrisma } from './testing/in-memory-prisma';
import { VENDOR_UNINSTALL_DISABLED, programId } from './vendor-uninstall';

// Desinstalação de programa que NÃO é MSI pelo comando do fabricante (exceção controlada).

const CMD = '"C:\\Program Files\\7-Zip\\Uninstall.exe" /S';
const M1 = '22222222-2222-4222-8222-222222222222';
const M2 = '33333333-3333-4333-8333-333333333333';
const SYNC = new Date('2026-11-20T10:00:00Z');
const PID = programId('64', '7-Zip', CMD);
const SEVEN = { name: '7-Zip 26.06 (x64)', version: '26.06', publisher: 'Igor Pavlov', installDate: null, productCode: null, arch: '64' as const, uninstallKey: '7-Zip', quietUninstallString: CMD, installLocation: 'C:\\Program Files\\7-Zip\\' };

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.DEPLOYMENT_ALLOW_VENDOR_UNINSTALL;
  if (value === undefined) delete process.env.DEPLOYMENT_ALLOW_VENDOR_UNINSTALL;
  else process.env.DEPLOYMENT_ALLOW_VENDOR_UNINSTALL = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DEPLOYMENT_ALLOW_VENDOR_UNINSTALL;
    else process.env.DEPLOYMENT_ALLOW_VENDOR_UNINSTALL = previous;
  }
}
async function withFlagAsync<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.DEPLOYMENT_ALLOW_VENDOR_UNINSTALL;
  if (value === undefined) delete process.env.DEPLOYMENT_ALLOW_VENDOR_UNINSTALL;
  else process.env.DEPLOYMENT_ALLOW_VENDOR_UNINSTALL = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DEPLOYMENT_ALLOW_VENDOR_UNINSTALL;
    else process.env.DEPLOYMENT_ALLOW_VENDOR_UNINSTALL = previous;
  }
}

describe('uninstallInfo (cada item do inventário)', () => {
  it('MSI: sempre, pelo ProductCode', () => {
    expect(uninstallInfo({ ...SEVEN, productCode: '{11111111-2222-3333-4444-555555555555}' }, false)).toMatchObject({ available: true, method: 'MSI' });
  });
  it('outro: consulta antiga, sem QuietUninstallString, comando recusado, exceção desligada', () => {
    expect(uninstallInfo({ ...SEVEN, uninstallKey: undefined }, true).reason).toBe(OUTDATED_INVENTORY);
    expect(uninstallInfo({ ...SEVEN, quietUninstallString: null }, true).reason).toBe(NO_QUIET_UNINSTALL);
    expect(uninstallInfo({ ...SEVEN, quietUninstallString: '"C:\\Windows\\System32\\cmd.exe" /c x' }, true).reason).toContain('Program Files');
    expect(uninstallInfo(SEVEN, false)).toEqual({ available: false, method: null, reason: VENDOR_UNINSTALL_DISABLED, programId: null, command: null });
  });
  it('outro com comando válido e a exceção ligada: disponível, com o id e o comando', () => {
    expect(uninstallInfo(SEVEN, true)).toEqual({ available: true, method: 'VENDOR', reason: null, programId: PID, command: CMD });
  });
});

describe('validateDeploymentCreate — programId', () => {
  const field = (body: Record<string, unknown>) => {
    try {
      validateDeploymentCreate({ machineIds: [M1], ...body });
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      return ((err as BadRequestException).getResponse() as { field: string }).field;
    }
    throw new Error('deveria ter recusado');
  };
  it('aceita só na desinstalação, sozinho e no formato do servidor', () => {
    expect(validateDeploymentCreate({ action: 'UNINSTALL', programId: PID, machineIds: [M1] })).toMatchObject({ programId: PID, softwareId: null, productCode: null });
    expect(field({ programId: PID })).toBe('programId');
    expect(field({ action: 'UNINSTALL', programId: 'x' })).toBe('programId');
    expect(field({ action: 'UNINSTALL', programId: PID, productCode: '{11111111-2222-3333-4444-555555555555}' })).toBe('programId');
    // O comando nunca vem do navegador: campo desconhecido é recusado.
    expect(field({ action: 'UNINSTALL', programId: PID, command: CMD })).toBe('command');
  });
});

describe('InventoryService.summary — programas por comando do fabricante', () => {
  const NOW = new Date('2026-11-20T12:00:00Z');
  function setup(items2: unknown[]) {
    const prisma = {
      machine: {
        findMany: jest.fn().mockResolvedValue([
          { id: M1, hostname: 'A', lastSync: SYNC },
          { id: M2, hostname: 'B', lastSync: SYNC },
        ]),
        aggregate: jest.fn().mockResolvedValue({ _max: { lastSync: SYNC } }),
      },
      machineInventory: {
        findMany: jest.fn().mockResolvedValue([
          { machineId: M1, collectedAt: NOW, items: [SEVEN] },
          { machineId: M2, collectedAt: NOW, items: items2 },
        ]),
      },
      software: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return new InventoryService(prisma as never, {} as never);
  }
  it('mesmo programa e mesmo comando nas duas máquinas: um grupo, em 2 de 2', async () => {
    const s = await withFlagAsync('true', () => setup([SEVEN]).summary([M1, M2], NOW));
    expect(s.products).toHaveLength(1);
    expect(s.products[0]).toMatchObject({ kind: 'OTHER', machineIds: [M1, M2], uninstall: { available: true, programId: PID, command: CMD } });
    expect(INVENTORY_STALE_DAYS).toBe(7);
  });
  it('comando diferente: grupos separados (cada um com o seu id)', async () => {
    const other = { ...SEVEN, quietUninstallString: '"C:\\Program Files (x86)\\7-Zip\\Uninstall.exe" /S', arch: '32' as const };
    const s = await withFlagAsync('true', () => setup([other]).summary([M1, M2], NOW));
    expect(s.products.map((p) => p.machineIds.length)).toEqual([1, 1]);
    expect(new Set(s.products.map((p) => p.uninstall.programId)).size).toBe(2);
  });
  it('exceção desligada: o item aparece, indisponível, com o motivo', async () => {
    const s = await withFlagAsync(undefined, () => setup([SEVEN]).summary([M1, M2], NOW));
    expect(s.products[0].uninstall).toMatchObject({ available: false, reason: VENDOR_UNINSTALL_DISABLED });
  });
});

describe('DeploymentsService.create — programId', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));
  function setup(items: unknown[] = [SEVEN]) {
    const prisma = {
      machine: {
        findMany: jest.fn().mockResolvedValue([{ id: M1, hostname: 'RSD-ALVO-01', lastSync: SYNC }]),
        aggregate: jest.fn().mockResolvedValue({ _max: { lastSync: SYNC } }),
      },
      machineInventory: { findMany: jest.fn().mockResolvedValue([{ items }]) },
      software: { findFirst: jest.fn(), findUnique: jest.fn() },
      deployment: {
        create: jest.fn(async ({ data }) => ({
          id: 'dep-1', ...data, softwareId: null, software: null, status: 'PENDING', createdAt: SYNC, startedAt: null, finishedAt: null,
          user: { username: 'testuser', displayName: null }, targets: [],
        })),
      },
    };
    const service = new DeploymentsService(prisma as never, { isAvailable: true, unavailableReason: null } as never, {} as never, { enqueue: jest.fn() } as never);
    const input = { action: 'UNINSTALL' as const, softwareId: null, productCode: null, programId: PID, machineIds: [M1], name: null };
    return { prisma, service, input };
  }

  it('exceção desligada (padrão): 409, nada é criado', async () => {
    const { prisma, service, input } = setup();
    await withFlagAsync(undefined, async () => {
      await expect(service.create(input, 'u')).rejects.toThrow(new ConflictException(VENDOR_UNINSTALL_DISABLED));
    });
    expect(prisma.deployment.create).not.toHaveBeenCalled();
  });

  it('ligada: comando, subchave e nome tirados do inventário do servidor', async () => {
    const { prisma, service, input } = setup();
    const view = await withFlagAsync('true', () => service.create(input, 'u'));
    expect(prisma.deployment.create.mock.calls[0][0].data).toMatchObject({
      name: 'Desinstalar 7-Zip 26.06 (x64) 26.06 — 1 máquina',
      productName: '7-Zip 26.06 (x64)',
      productCode: null,
      uninstallKey: '7-Zip',
      uninstallArch: '64',
      uninstallCommand: CMD,
    });
    expect(view.vendorCommand).toBe(CMD);
    expect(view.software).toBeNull();
  });

  it('id que não está no inventário das máquinas selecionadas: 409', async () => {
    const { service, input } = setup();
    await withFlagAsync('true', async () => {
      await expect(service.create({ ...input, programId: 'f'.repeat(64) }, 'u')).rejects.toThrow(ConflictException);
    });
  });

  it('comando guardado que não passa nas regras: 409 com o motivo', async () => {
    const bad = { ...SEVEN, quietUninstallString: '"C:\\Program Files\\7-Zip\\Uninstall.exe" /S & calc' };
    const { service, input } = setup([bad]);
    const id = programId('64', '7-Zip', bad.quietUninstallString);
    await withFlagAsync('true', async () => {
      await expect(service.create({ ...input, programId: id }, 'u')).rejects.toThrow('caractere não permitido');
    });
  });
});

describe('DeploymentRunner — comando do fabricante', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));
  function setup() {
    const db = createInMemoryPrisma();
    db.deployments.set('d1', {
      id: 'd1', softwareId: null, status: S.PENDING, startedAt: null, finishedAt: null, action: 'UNINSTALL',
      productCode: null, productName: '7-Zip 26.06 (x64)', productVersion: '26.06', uninstallKey: '7-Zip', uninstallArch: '64', uninstallCommand: CMD,
    } as never);
    db.machines.set('m1', { id: 'm1', hostname: 'RSD-ALVO-01' });
    db.targets.set('t1', { id: 't1', deploymentId: 'd1', machineId: 'm1', status: S.PENDING, startedAt: null, finishedAt: null, exitCode: null });
    const uninstallProgram = jest.fn<Promise<DeployResult>, [ProgramUninstallInput, (e: DeployEvent) => void]>();
    const run = jest.fn();
    const runner = new DeploymentRunner(db.prisma as never, { isAvailable: true, run, uninstallProgram } as never, {} as never);
    return { db, run, uninstallProgram, runner };
  }

  it('ligada: chama o script do fabricante com subchave, visão e comando; sucesso = saiu do registro', async () => {
    const { db, run, uninstallProgram, runner } = setup();
    uninstallProgram.mockResolvedValue({ ok: true, removed: true, exitCode: 0 });
    await withFlagAsync('true', () => runner.runTarget({ targetId: 't1', machineId: 'm1' }));
    expect(uninstallProgram).toHaveBeenCalledWith(
      { targetId: 't1', computerName: 'RSD-ALVO-01', arch: '64', uninstallKey: '7-Zip', command: CMD },
      expect.any(Function),
    );
    expect(run).not.toHaveBeenCalled();
    expect(db.targets.get('t1')).toMatchObject({ status: S.SUCCEEDED, exitCode: 0 });
    expect(db.logs[db.logs.length - 1].message).toMatch(/^Desinstalação concluída: o programa saiu do registro/);
  });

  it('desligada na hora de executar: falha sem chamar nada', async () => {
    const { db, uninstallProgram, runner } = setup();
    await withFlagAsync(undefined, () => runner.runTarget({ targetId: 't1', machineId: 'm1' }));
    expect(uninstallProgram).not.toHaveBeenCalled();
    expect(db.targets.get('t1')).toMatchObject({ status: S.FAILED });
    expect(db.logs[db.logs.length - 1].message).toBe(VENDOR_UNINSTALL_DISABLED);
  });

  it('continua registrado: falha, com o código de saída gravado', async () => {
    const { db, uninstallProgram, runner } = setup();
    uninstallProgram.mockResolvedValue({ ok: false, phase: 'confirm', reason: 'still-installed', message: 'continua', exitCode: 2 });
    await withFlagAsync('true', () => runner.runTarget({ targetId: 't1', machineId: 'm1' }));
    expect(db.targets.get('t1')).toMatchObject({ status: S.FAILED, exitCode: 2 });
  });
});

describe('interpretResult — comando do fabricante', () => {
  it('removido: sucesso com o código só informativo (mesmo diferente de 0)', () => {
    expect(interpretResult({ ok: true, removed: true, exitCode: 1 }, InstallType.MSI, 'UNINSTALL')).toMatchObject({ status: S.SUCCEEDED, level: LogLevel.INFO, exitCode: 1 });
  });
  it('não estava registrado: sucesso com aviso, sem ProductCode na mensagem', () => {
    expect(interpretResult({ ok: true, notInstalled: true, productCode: null }, InstallType.MSI, 'UNINSTALL')).toMatchObject({
      status: S.SUCCEEDED,
      message: 'Não estava instalado: o programa não está mais registrado na máquina. A desinstalação não foi executada.',
    });
  });
});

describe('PowerShellExecutor.uninstallProgram (com processo falso)', () => {
  const FAKE = join(__dirname, 'testing', 'fake-program-uninstall.js');
  const PASSWORD = 'S3nha-Ç0m-Acênto!';
  const executor = new PowerShellExecutor({
    command: process.execPath,
    args: ['nao-usado'],
    programUninstallArgs: [FAKE],
    credential: { username: 'rsd-deploy', password: PASSWORD },
    connectTimeoutSeconds: 30,
    installTimeoutSeconds: 1800,
    copyMinBytesPerSecond: 1024 * 1024,
    copyBaseSeconds: 60,
    watchdogMarginSeconds: 120,
    unavailableReason: null,
  });
  const input = (computerName: string): ProgramUninstallInput => ({ targetId: '11111111-2222-4333-8444-555555555555', computerName, arch: '64', uninstallKey: '7-Zip', command: CMD });

  it('removido, com os passos como eventos', async () => {
    const events: DeployEvent[] = [];
    expect(await executor.uninstallProgram(input('FAKE-REMOVED'), (e) => events.push(e))).toEqual({ ok: true, removed: true, exitCode: 0 });
    expect(events.map((e) => e.phase)).toEqual(['check', 'uninstall', 'confirm']);
  });
  it('continua registrado: falha com o código; não estava: sucesso sem ProductCode', async () => {
    expect(await executor.uninstallProgram(input('FAKE-STILL'), () => undefined)).toMatchObject({ ok: false, reason: 'still-installed', exitCode: 2 });
    expect(await executor.uninstallProgram(input('FAKE-NOT-INSTALLED'), () => undefined)).toEqual({ ok: true, notInstalled: true, productCode: null });
  });
  it('stdin só ASCII, com o comando, a espera de 120 s e a credencial; a senha não sai no evento', async () => {
    const events: DeployEvent[] = [];
    await executor.uninstallProgram(input('FAKE-ECHO'), (e) => events.push(e));
    expect(events[0].message).toBe('stdin-ascii=true');
    expect(JSON.parse(events[1].message.replace(/^input=/, ''))).toEqual({
      ...input('FAKE-ECHO'),
      connectTimeoutSeconds: 30,
      installTimeoutSeconds: 1800,
      removalWaitSeconds: 120,
      credential: { username: 'rsd-deploy', password: '***' },
    });
  });
  it('parseProgramUninstallLine ignora o que está fora do protocolo', () => {
    expect(parseProgramUninstallLine('lixo')).toBeNull();
    expect(parseProgramUninstallLine(JSON.stringify({ type: 'result', ok: true, removed: true, exitCode: 'x' }))).toBeNull();
  });
});

describe('uninstall-program-target.ps1', () => {
  const source = readFileSync(PROGRAM_UNINSTALL_SCRIPT_PATH);
  const text = source.toString('utf8');
  const code = text.replace(/<#[\s\S]*?#>/g, '').split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n');

  it('UTF-8 com BOM; usa as regras compartilhadas', () => {
    expect([...source.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(code).toContain(". (Join-Path $PSScriptRoot 'uninstall-command-rules.ps1')");
    expect(code).toContain('Test-UninstallCommand $in.command');
  });
  it('relê o QuietUninstallString e exige igualdade exata; nunca o UninstallString', () => {
    expect(code).toContain("$p.PSObject.Properties['QuietUninstallString']");
    expect(code).toContain('$state.quiet -cne $in.command');
    expect(code).not.toMatch(/(?<!quiet)uninstallstring/i);
  });
  it('executa só por Start-Process -FilePath, sem cmd /c nem comando montado', () => {
    expect(code).toContain('$params = @{ FilePath = $Exe; PassThru = $true }');
    expect(code).not.toMatch(/Invoke-Expression|\biex\b|cmd(\.exe)?\s+\/c|\[scriptblock\]::Create|AddScript|Copy-Item|New-PSDrive/i);
  });
  it('recusa junção/link e registra a assinatura', () => {
    expect(code).toContain('[System.IO.FileAttributes]::ReparsePoint');
    expect(code).toContain('Get-AuthenticodeSignature');
  });
  it('mesmas mensagens de conexão do deploy-target.ps1', () => {
    const errors = (src: string) =>
      [...src.matchAll(/throw \[DeployFailure\]::new\('(?:resolve|connect)', '([^']+)',\s*"([^"]*)"/g)].map((m) => `${m[1]}: ${m[2]}`).sort();
    expect(errors(text)).toHaveLength(7);
    expect(errors(text)).toEqual(errors(readFileSync(DEPLOY_SCRIPT_PATH, 'utf8')));
  });

  const onWindows = process.platform === 'win32' ? describe : describe.skip;
  onWindows('com o powershell.exe real (sem tocar em nenhuma máquina)', () => {
    const base = loadPowerShellExecutorConfig({ SystemRoot: process.env.SystemRoot });
    const real = new PowerShellExecutor({ ...base, connectTimeoutSeconds: 2 });
    const ok: ProgramUninstallInput = { targetId: '11111111-2222-4333-8444-555555555555', computerName: 'rsd-inexistente.invalid', arch: '64', uninstallKey: '7-Zip', command: CMD };
    const invalid = (message: string) => ({ ok: false, phase: 'validate', reason: 'invalid-input', message, exitCode: null });

    it('sem erro de sintaxe', () => {
      const r = spawnSync(base.command, ['-NoProfile', '-NonInteractive', '-Command', `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${PROGRAM_UNINSTALL_SCRIPT_PATH}', [ref]$null, [ref]$e); $e.Count`], { encoding: 'utf8', windowsHide: true });
      expect(r.stdout.trim()).toBe('0');
    });
    it('entrada inválida recusada antes de qualquer conexão', async () => {
      expect(await real.uninstallProgram({ ...ok, computerName: 'PC 01; x' }, () => undefined)).toEqual(invalid('Nome de máquina inválido.'));
      expect(await real.uninstallProgram({ ...ok, arch: '16' as never }, () => undefined)).toEqual(invalid('Visão do registro inválida.'));
      expect(await real.uninstallProgram({ ...ok, uninstallKey: '..\\Run' }, () => undefined)).toEqual(invalid('Subchave do registro inválida.'));
      expect(await real.uninstallProgram({ ...ok, uninstallKey: '7-Zip*' }, () => undefined)).toEqual(invalid('Subchave do registro inválida.'));
      expect(await real.uninstallProgram({ ...ok, command: 'x'.repeat(1025) }, () => undefined)).toEqual(invalid('Comando inválido.'));
    });
    it('entrada válida segue para a resolução de nome (DNS .invalid)', async () => {
      expect(await real.uninstallProgram(ok, () => undefined)).toMatchObject({ ok: false, reason: 'dns' });
    });
  });
});
