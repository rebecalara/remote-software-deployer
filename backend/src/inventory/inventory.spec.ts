import {
  BadGatewayException,
  ConflictException,
  GatewayTimeoutException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES_KEY } from '../auth/roles.decorator';
import {
  DEPLOY_SCRIPT_PATH,
  INVENTORY_SCRIPT_PATH,
  MAX_INVENTORY_ITEMS,
  PowerShellExecutor,
  PowerShellExecutorConfig,
  loadPowerShellExecutorConfig,
  normalizeInventoryItems,
  parseInventoryLine,
} from '../deployments/powershell-executor';
import { InventoryController } from './inventory.controller';
import { InventoryService, MAX_CONCURRENT_INVENTORIES } from './inventory.service';
import { REAL_POWERSHELL_TEST_TIMEOUT_MS } from '../deployments/testing/real-powershell';

// RF08: inventário de software por máquina (consulta ao vivo, só leitura).

const CODE = '{23170F69-40C1-2702-2606-000001000000}';
const M1 = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'S3nha-Ç0m-Acênto!';
const FAKE = join(__dirname, '..', 'deployments', 'testing', 'fake-inventory.js');

function fakeExecutor(overrides: Partial<PowerShellExecutorConfig> = {}) {
  return new PowerShellExecutor({
    command: process.execPath,
    args: ['nao-usado'],
    inventoryArgs: [FAKE],
    credential: { username: 'rsd-deploy', password: PASSWORD },
    connectTimeoutSeconds: 30,
    installTimeoutSeconds: 1800,
    copyMinBytesPerSecond: 1024 * 1024,
    copyBaseSeconds: 60,
    watchdogMarginSeconds: 120,
    unavailableReason: null,
    ...overrides,
  });
}

describe('parseInventoryLine / normalizeInventoryItems', () => {
  it('normaliza: ProductCode em maiúsculas, data só aaaa-mm-dd, vazio vira null, sem repetir 64/32, em ordem', () => {
    const line = JSON.stringify({
      type: 'result',
      ok: true,
      items: [
        { name: 'Zeta', version: '1', publisher: '', installDate: '20261119', productCode: '', arch: '64' },
        { name: '7-Zip', version: '26.06', publisher: 'Igor Pavlov', installDate: '2026-11-19', productCode: CODE.toLowerCase(), arch: '64' },
        { name: 'Zeta', version: '1', publisher: '', installDate: '', productCode: '', arch: '32' },
        { name: 'Código ruim', version: '', publisher: null, installDate: 'ontem', productCode: '{x}', arch: '32' },
        { name: '   ', version: '1' },
      ],
    });
    expect(parseInventoryLine(line)).toEqual({
      ok: true,
      items: [
        { name: '7-Zip', version: '26.06', publisher: 'Igor Pavlov', installDate: '2026-11-19', productCode: CODE, arch: '64', uninstallKey: null, quietUninstallString: null, installLocation: null },
        { name: 'Código ruim', version: null, publisher: null, installDate: null, productCode: null, arch: '32', uninstallKey: null, quietUninstallString: null, installLocation: null },
        { name: 'Zeta', version: '1', publisher: null, installDate: null, productCode: null, arch: '64', uninstallKey: null, quietUninstallString: null, installLocation: null },
      ],
    });
  });

  it('trunca textos longos e limita a quantidade', () => {
    const many = Array.from({ length: MAX_INVENTORY_ITEMS + 10 }, (_, i) => ({ name: `App ${String(i).padStart(5, '0')}`, arch: '64' }));
    expect(normalizeInventoryItems(many)).toHaveLength(MAX_INVENTORY_ITEMS);
    expect(normalizeInventoryItems([{ name: 'x'.repeat(1000) }])[0].name).toHaveLength(256);
  });

  it('falha com motivo; log e lixo são ignorados', () => {
    expect(parseInventoryLine(JSON.stringify({ type: 'result', ok: false, reason: 'unreachable', message: 'm' }))).toEqual({
      ok: false,
      reason: 'unreachable',
      message: 'm',
    });
    expect(parseInventoryLine(JSON.stringify({ type: 'log', level: 'INFO', message: 'x' }))).toBeNull();
    expect(parseInventoryLine('não é json')).toBeNull();
  });
});

describe('PowerShellExecutor.inventory (com processo falso)', () => {
  it('devolve os itens normalizados', async () => {
    const result = await fakeExecutor().inventory('FAKE-OK');
    expect(result).toMatchObject({ ok: true });
    const items = 'items' in result ? result.items : [];
    expect(items.map((i) => [i.name, i.productCode])).toEqual([
      ['7-Zip 26.06 (x64 edition)', CODE],
      ['Microsoft Edge', null],
    ]);
  });

  it('envia nome, tempos e credencial pelo stdin, só em ASCII, sem nada de implantação; a senha não sai na mensagem', async () => {
    const result = await fakeExecutor().inventory('FAKE-ECHO');
    const message = 'message' in result ? result.message : '';
    expect(message.startsWith('ascii=true input=')).toBe(true);
    const echoed = JSON.parse(message.replace(/^ascii=true input=/, ''));
    expect(echoed).toEqual({
      computerName: 'FAKE-ECHO',
      connectTimeoutSeconds: 30,
      readTimeoutSeconds: 60,
      credential: { username: 'rsd-deploy', password: '***' },
    });
    expect(message).not.toContain(PASSWORD);
  });

  it('repassa a falha relatada, com a senha filtrada', async () => {
    const result = await fakeExecutor().inventory('FAKE-DENIED');
    expect(result).toEqual({ ok: false, reason: 'access-denied', message: 'Acesso negado em FAKE-DENIED (senha ***).' });
  });

  it('encerra o processo que passa do limite geral', async () => {
    const result = await fakeExecutor({ inventoryWatchdogMs: 500 }).inventory('FAKE-HANG');
    expect(result).toMatchObject({ ok: false, reason: 'watchdog-timeout' });
  });

  it('processo que termina sem resultado: relata com o stderr', async () => {
    const result = await fakeExecutor().inventory('FAKE-SILENT');
    expect(result).toMatchObject({ ok: false, reason: 'no-result' });
    expect('message' in result && result.message).toContain('falhou sem resultado');
  });

  it('indisponível (fora do Windows ou sem o script): não inicia processo', async () => {
    expect(await fakeExecutor({ unavailableReason: 'exige Windows.' }).inventory('FAKE-OK')).toEqual({
      ok: false,
      reason: 'unavailable',
      message: 'exige Windows.',
    });
    const noScript = fakeExecutor({ inventoryUnavailableReason: 'script de consulta não encontrado.' });
    expect(noScript.isInventoryAvailable).toBe(false);
    expect(await noScript.inventory('FAKE-OK')).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

describe('inventory-target.ps1', () => {
  const source = readFileSync(INVENTORY_SCRIPT_PATH);
  const text = source.toString('utf8');
  const code = text
    .replace(/<#[\s\S]*?#>/g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  it('está salvo em UTF-8 com BOM', () => {
    expect([...source.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('SÓ LEITURA: não copia, não executa, não usa Win32_Product nem Get-Package', () => {
    expect(code).not.toMatch(
      /Win32_Product|Get-Package|Get-WmiObject|Get-CimInstance|Copy-Item|New-PSDrive|New-Item|Remove-Item|Set-Item|Start-Process|msiexec|Invoke-Expression|\biex\b|cmd(\.exe)?\s+\/c|New-ItemProperty|Set-ItemProperty/i,
    );
  });

  it('lê só as chaves Uninstall de 64 e 32 bits', () => {
    expect(code).toContain("'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'");
    expect(code).toContain("'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'");
    expect(code.match(/HKLM:|HKCU:|HKU:|Registry::/g)).toHaveLength(2);
  });

  it('o bloco de conexão copiado tem as MESMAS mensagens de erro do deploy-target.ps1', () => {
    const deploy = readFileSync(DEPLOY_SCRIPT_PATH, 'utf8');
    const errors = (src: string) =>
      [...src.matchAll(/throw \[DeployFailure\]::new\('(?:resolve|connect)', '([^']+)',\s*"([^"]*)"/g)]
        .map((m) => `${m[1]}: ${m[2]}`)
        .sort();
    const inv = errors(text);
    expect(inv).toHaveLength(7);
    expect(inv).toEqual(errors(deploy));
  });

  const onWindows = process.platform === 'win32' ? describe : describe.skip;
  onWindows('com o powershell.exe real (sem tocar em nenhuma máquina)', () => {
    const base = loadPowerShellExecutorConfig({ SystemRoot: process.env.SystemRoot });
    const real = new PowerShellExecutor({ ...base, connectTimeoutSeconds: 2 });

    it('não tem erro de sintaxe', () => {
      const r = spawnSync(
        base.command,
        ['-NoProfile', '-NonInteractive', '-Command', `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${INVENTORY_SCRIPT_PATH}', [ref]$null, [ref]$e); $e.Count`],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(r.stdout.trim()).toBe('0');
    }, REAL_POWERSHELL_TEST_TIMEOUT_MS);

    it('recusa nome de máquina inválido antes de qualquer conexão', async () => {
      expect(await real.inventory('PC 01; Remove-Item')).toEqual({ ok: false, reason: 'invalid-input', message: 'Nome de máquina inválido.' });
    }, REAL_POWERSHELL_TEST_TIMEOUT_MS);

    it('nome que não existe no DNS (domínio reservado .invalid), com acentos intactos', async () => {
      expect(await real.inventory('rsd-inexistente.invalid')).toEqual({
        ok: false,
        reason: 'dns',
        message: 'O nome rsd-inexistente.invalid não foi encontrado no DNS.',
      });
    }, REAL_POWERSHELL_TEST_TIMEOUT_MS);

    it('endereço que não responde (192.0.2.1, reservado para documentação) → "não respondeu"', async () => {
      const result = await real.inventory('192.0.2.1');
      expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
      expect('message' in result && result.message).toContain('não respondeu na porta 5985');
    }, REAL_POWERSHELL_TEST_TIMEOUT_MS);
  });
});

describe('InventoryService', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));
  const SYNC = new Date('2026-11-19T10:00:00Z');
  const ITEMS = [
    { name: '7-Zip 26.06 (x64 edition)', version: '26.06.00.0', publisher: 'Igor Pavlov', installDate: '2026-11-19', productCode: CODE, arch: '64' },
    { name: '7-Zip 26.06 (x64)', version: '26.06', publisher: 'Igor Pavlov', installDate: null, productCode: null, arch: '64' },
  ];

  function setup(executorOverrides: Record<string, unknown> = {}) {
    const prisma = {
      machine: {
        findUnique: jest.fn().mockResolvedValue({ id: M1, hostname: 'RSD-ALVO-01', lastSync: SYNC }),
        aggregate: jest.fn().mockResolvedValue({ _max: { lastSync: SYNC } }),
      },
      machineInventory: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(async ({ create }) => ({ ...create, collectedBy: { username: 'testuser', displayName: null } })),
      },
      software: {
        findMany: jest.fn().mockResolvedValue([{ id: 'sw-1', name: '7-Zip', version: '26.06', active: false, msiProductCode: CODE }]),
      },
    };
    const executor = {
      isInventoryAvailable: true,
      inventoryUnavailableReason: null as string | null,
      inventory: jest.fn().mockResolvedValue({ ok: true, items: ITEMS }),
      ...executorOverrides,
    };
    const service = new InventoryService(prisma as never, executor as never);
    return { prisma, executor, service };
  }

  it('consulta: grava a foto (quem e quando) e marca só o MSI do catálogo, pelo ProductCode', async () => {
    const { prisma, executor, service } = setup();
    const view = await service.collect(M1, 'user-1', 'testuser');
    expect(executor.inventory).toHaveBeenCalledWith('RSD-ALVO-01');
    expect(prisma.machineInventory.upsert.mock.calls[0][0]).toMatchObject({
      where: { machineId: M1 },
      create: { machineId: M1, collectedById: 'user-1', items: ITEMS },
      update: { collectedById: 'user-1', items: ITEMS },
    });
    expect(view.items.map((i) => i.catalog)).toEqual([
      { softwareId: 'sw-1', name: '7-Zip', version: '26.06', active: false, uninstallAvailable: true },
      null, // EXE: sem marcação
    ]);
    expect(prisma.software.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { installType: 'MSI', msiProductCode: { in: [CODE] } } }),
    );
  });

  it('falha na máquina: 502 com o motivo; tempo esgotado: 504; nada é gravado (a última foto fica)', async () => {
    const denied = setup({ inventory: jest.fn().mockResolvedValue({ ok: false, reason: 'access-denied', message: 'Acesso negado.' }) });
    const err = await denied.service.collect(M1, 'u', 'testuser').catch((e) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err.getResponse()).toMatchObject({ message: 'Acesso negado.', reason: 'access-denied' });
    expect(denied.prisma.machineInventory.upsert).not.toHaveBeenCalled();

    const slow = setup({ inventory: jest.fn().mockResolvedValue({ ok: false, reason: 'timeout', message: 'Tempo esgotado.' }) });
    await expect(slow.service.collect(M1, 'u', 'testuser')).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('modo demonstração (sem WinRM): 503 com o motivo, sem chamar o executor', async () => {
    const { executor, service } = setup({ isInventoryAvailable: false, inventoryUnavailableReason: 'exige Windows.' });
    await expect(service.collect(M1, 'u', 'testuser')).rejects.toThrow(
      new ServiceUnavailableException('A consulta remota está indisponível neste servidor: exige Windows.'),
    );
    expect(executor.inventory).not.toHaveBeenCalled();
  });

  it('máquina inexistente: 404; fora da última sincronização: 409', async () => {
    const missing = setup();
    missing.prisma.machine.findUnique.mockResolvedValue(null);
    await expect(missing.service.collect(M1, 'u', 'testuser')).rejects.toBeInstanceOf(NotFoundException);
    const old = setup();
    old.prisma.machine.findUnique.mockResolvedValue({ id: M1, hostname: 'X', lastSync: new Date('2026-11-01T00:00:00Z') });
    await expect(old.service.collect(M1, 'u', 'testuser')).rejects.toBeInstanceOf(ConflictException);
  });

  it('uma consulta por máquina e no máximo 5 ao mesmo tempo', async () => {
    let release!: () => void;
    const pending = new Promise((r) => (release = () => r({ ok: true, items: [] })));
    const { prisma, service } = setup({ inventory: jest.fn(() => pending) });
    const first = service.collect(M1, 'u', 'testuser');
    await new Promise((r) => setImmediate(r));
    await expect(service.collect(M1, 'u', 'testuser')).rejects.toThrow('Já existe uma consulta em andamento para esta máquina');

    const others = Array.from({ length: MAX_CONCURRENT_INVENTORIES - 1 }, (_, i) => `3333333${i}-3333-4333-8333-333333333333`);
    prisma.machine.findUnique.mockImplementation(async ({ where }) => ({ id: where.id, hostname: 'H', lastSync: SYNC }));
    const started = others.map((id) => service.collect(id, 'u', 'testuser'));
    await new Promise((r) => setImmediate(r));
    const sixth = await service.collect('44444444-4444-4444-8444-444444444444', 'u', 'testuser').catch((e) => e);
    expect(sixth).toBeInstanceOf(HttpException);
    expect(sixth.getStatus()).toBe(429);

    release();
    await Promise.all([first, ...started]);
    // Liberou: a mesma máquina pode ser consultada de novo.
    await expect(service.collect(M1, 'u', 'testuser')).resolves.toBeDefined();
  });

  it('última consulta: null sem consulta; com consulta, a marcação do catálogo é recalculada na leitura', async () => {
    const { prisma, service } = setup();
    expect(await service.latest(M1)).toEqual({ inventory: null, collectAvailable: true, collectUnavailableReason: null });
    prisma.machineInventory.findUnique.mockResolvedValue({
      machineId: M1,
      collectedAt: SYNC,
      items: ITEMS,
      collectedBy: { username: 'testuser', displayName: 'Test User' },
    });
    const state = await service.latest(M1);
    expect(state.inventory).toMatchObject({ collectedAt: SYNC.toISOString(), collectedBy: { username: 'testuser' } });
    expect(state.inventory!.items[0].catalog).toMatchObject({ softwareId: 'sw-1' });
  });

  it('última consulta no modo demonstração: visível, com a consulta ao vivo indisponível e o motivo', async () => {
    const { service } = setup({ isInventoryAvailable: false, inventoryUnavailableReason: 'exige Windows.' });
    expect(await service.latest(M1)).toEqual({ inventory: null, collectAvailable: false, collectUnavailableReason: 'exige Windows.' });
  });
});

describe('InventoryController — permissões', () => {
  const rolesOf = (method: keyof InventoryController) =>
    new Reflector().get<UserRole[] | undefined>(ROLES_KEY, InventoryController.prototype[method]);
  it('consultar ao vivo: ADMIN e OPERATOR; ver a última consulta: todos', () => {
    expect(rolesOf('collect')).toEqual([UserRole.ADMIN, UserRole.OPERATOR]);
    expect(rolesOf('latest')).toBeUndefined();
  });
});
