import { LogLevel } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_INSTALL_TIMEOUT_MINUTES,
  DEPLOY_SCRIPT_PATH,
  DeployEvent,
  DeployTargetInput,
  MAX_INSTALL_TIMEOUT_MINUTES,
  MAX_MESSAGE_LENGTH,
  PowerShellExecutor,
  PowerShellExecutorConfig,
  loadPowerShellExecutorConfig,
  parseInstallTimeoutMinutes,
  parseLine,
  redact,
  toAsciiJson,
} from './powershell-executor';

const FAKE = join(__dirname, 'testing', 'fake-powershell.js');
const PASSWORD = 'S3nha-Ç0m-Acênto!';

function fakeConfig(overrides: Partial<PowerShellExecutorConfig> = {}): PowerShellExecutorConfig {
  return {
    command: process.execPath,
    args: [FAKE],
    credential: { username: 'rsd-deploy', password: PASSWORD },
    connectTimeoutSeconds: 30,
    installTimeoutSeconds: 1800,
    copyMinBytesPerSecond: 1024 * 1024,
    copyBaseSeconds: 60,
    watchdogMarginSeconds: 120,
    unavailableReason: null,
    ...overrides,
  };
}

function input(computerName: string, overrides: Partial<DeployTargetInput> = {}): DeployTargetInput {
  return {
    targetId: '11111111-2222-4333-8444-555555555555',
    computerName,
    installerPath: 'C:\\rsd-data\\installers\\0f0e0d0c-0b0a-4908-8706-050403020100.msi',
    installerSizeBytes: 1234,
    sha256: 'A'.repeat(64),
    installType: 'MSI',
    installArgs: [],
    ...overrides,
  };
}

async function runWith(executor: PowerShellExecutor, target: DeployTargetInput) {
  const events: DeployEvent[] = [];
  const result = await executor.run(target, (e) => events.push(e));
  return { result, events };
}

describe('PowerShellExecutor (com processo falso)', () => {
  const executor = new PowerShellExecutor(fakeConfig());

  it.each([0, 3010, 1603])('devolve o código de saída %i sem interpretá-lo', async (code) => {
    const { result, events } = await runWith(executor, input(`FAKE-EXIT-${code}`));
    expect(result).toEqual({ ok: true, exitCode: code });
    expect(events).toEqual([
      { level: LogLevel.INFO, phase: 'connect', message: 'Sessão WinRM aberta.' },
      { level: LogLevel.INFO, phase: 'install', message: 'O instalador terminou.' },
    ]);
  });

  it('repassa a falha relatada pelo script, com fase e motivo', async () => {
    const { result } = await runWith(executor, input('FAKE-FAIL-CONNECT'));
    expect(result).toEqual({ ok: false, phase: 'connect', reason: 'unreachable', message: 'não respondeu' });
  });

  it('envia a entrada completa pelo stdin, só em ASCII, com os limites e a credencial', async () => {
    const target = input('FAKE-ECHO', { installArgs: ['INSTALLDIR="C:\\Programas\\Ação"', '/qb'] });
    const { events } = await runWith(executor, target);

    expect(events[0].message).toBe('stdin-ascii=true');
    const echoed = JSON.parse(events[1].message.replace(/^input=/, ''));
    expect(echoed).toEqual({
      ...target,
      connectTimeoutSeconds: 30,
      installTimeoutSeconds: 1800,
      // A senha chegou ao processo (o eco a mostra), mas o evento sai sem ela.
      credential: { username: 'rsd-deploy', password: '***' },
    });
  });

  it('nunca deixa a senha sair num evento nem no resultado', async () => {
    const { result, events } = await runWith(executor, input('FAKE-LEAK'));
    const everything = JSON.stringify({ result, events });
    expect(everything).not.toContain(PASSWORD);
    expect(events[0]).toEqual({ level: LogLevel.WARN, phase: 'connect', message: 'erro com a senha *** no meio' });
    expect(result).toEqual({ ok: false, phase: 'connect', reason: 'session', message: 'falhou: ***' });
  });

  it('trata saída fora do protocolo como DEBUG e considera só o primeiro resultado', async () => {
    const { result, events } = await runWith(executor, input('FAKE-GARBAGE'));
    expect(events).toEqual([
      { level: LogLevel.DEBUG, phase: 'executor', message: 'AVISO: isto não é JSON' },
      {
        level: LogLevel.DEBUG,
        phase: 'executor',
        message: '{"type":"log","level":"BANANA","phase":"connect","message":"nível inválido"}',
      },
    ]);
    expect(result).toEqual({ ok: true, exitCode: 0 });
  });

  it('trunca mensagens longas', async () => {
    const { events } = await runWith(executor, input('FAKE-LONG'));
    expect(events[0].message.startsWith('x'.repeat(MAX_MESSAGE_LENGTH))).toBe(true);
    expect(events[0].message).toMatch(/… \(truncado\)$/);
  });

  it('relata processo que termina sem resultado, com o stderr', async () => {
    const { result } = await runWith(executor, input('FAKE-NO-RESULT'));
    expect(result).toEqual({
      ok: false,
      phase: 'executor',
      reason: 'no-result',
      message: 'O script terminou sem relatar resultado (código 1): Exceção não tratada no script',
    });
  });

  it('encerra o processo que passa do limite geral', async () => {
    const quick = new PowerShellExecutor(
      fakeConfig({ connectTimeoutSeconds: 0, installTimeoutSeconds: 0, copyBaseSeconds: 0, watchdogMarginSeconds: 1 }),
    );
    const started = Date.now();
    const { result, events } = await runWith(quick, input('FAKE-HANG', { installerSizeBytes: 0 }));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(events).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, phase: 'executor', reason: 'watchdog-timeout' });
    expect((result as { message: string }).message).toContain('confira a máquina');
  });

  it('relata falha ao iniciar o processo', async () => {
    const broken = new PowerShellExecutor(fakeConfig({ command: join(tmpdir(), 'nao-existe-rsd.exe'), args: [] }));
    const { result } = await runWith(broken, input('FAKE-EXIT-0'));
    expect(result).toMatchObject({ ok: false, phase: 'executor', reason: 'spawn-failed' });
  });

  it('não inicia processo quando está indisponível', async () => {
    const off = new PowerShellExecutor(fakeConfig({ command: 'nao-deve-ser-chamado', unavailableReason: 'sem Windows' }));
    expect(off.isAvailable).toBe(false);
    const { result, events } = await runWith(off, input('FAKE-EXIT-0'));
    expect(result).toEqual({ ok: false, phase: 'executor', reason: 'unavailable', message: 'sem Windows' });
    expect(events).toEqual([]);
  });

  it('um erro em quem recebe os eventos não derruba a execução', async () => {
    const result = await executor.run(input('FAKE-EXIT-0'), () => {
      throw new Error('falha ao gravar o log');
    });
    expect(result).toEqual({ ok: true, exitCode: 0 });
  });

  it('calcula o limite geral a partir dos limites e do tamanho do instalador', () => {
    // 2×30 (conexão) + 60 + 300 (300 MB a 1 MB/s) + 1800 (instalação) + 120 (margem)
    expect(executor.watchdogMs(300 * 1024 * 1024)).toBe((60 + 60 + 300 + 1800 + 120) * 1000);
  });
});

describe('loadPowerShellExecutorConfig', () => {
  const winEnv = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' };

  it('fica indisponível fora do Windows', () => {
    const config = loadPowerShellExecutorConfig(winEnv, undefined, 'linux');
    expect(config.unavailableReason).toMatch(/Windows/);
  });

  const onWindows = process.platform === 'win32' ? it : it.skip;

  onWindows('usa o powershell.exe por caminho absoluto e o script fixo', () => {
    const config = loadPowerShellExecutorConfig(winEnv);
    expect(config.unavailableReason).toBeNull();
    expect(config.command.toLowerCase()).toMatch(/\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/);
    expect(config.args).toEqual([
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DEPLOY_SCRIPT_PATH,
    ]);
    expect(config.credential).toBeNull();
    expect(config.installTimeoutSeconds).toBe(DEFAULT_INSTALL_TIMEOUT_MINUTES * 60);
  });

  onWindows('usa a credencial do .env quando usuário e senha estão definidos', () => {
    const config = loadPowerShellExecutorConfig({ ...winEnv, WINRM_USERNAME: ' rsd-deploy ', WINRM_PASSWORD: 'x' });
    expect(config.credential).toEqual({ username: 'rsd-deploy', password: 'x' });
  });

  onWindows.each([
    [{ WINRM_USERNAME: 'rsd-deploy' }, /sem WINRM_PASSWORD/],
    [{ WINRM_PASSWORD: 'x' }, /sem WINRM_USERNAME/],
  ])('fica indisponível com credencial pela metade (%o)', (partial, reason) => {
    const config = loadPowerShellExecutorConfig({ ...winEnv, ...partial });
    expect(config.unavailableReason).toMatch(reason);
    expect(config.credential).toBeNull();
  });

  onWindows('nunca registra a senha no log', () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    loadPowerShellExecutorConfig({ ...winEnv, WINRM_USERNAME: 'rsd-deploy', WINRM_PASSWORD: PASSWORD }, logger as never);
    loadPowerShellExecutorConfig({ ...winEnv, WINRM_USERNAME: '', WINRM_PASSWORD: PASSWORD }, logger as never);
    const logged = JSON.stringify([logger.log.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain(PASSWORD);
  });
});

describe('parseInstallTimeoutMinutes', () => {
  it.each([
    [undefined, DEFAULT_INSTALL_TIMEOUT_MINUTES],
    ['', DEFAULT_INSTALL_TIMEOUT_MINUTES],
    ['45', 45],
    ['0', DEFAULT_INSTALL_TIMEOUT_MINUTES],
    ['abc', DEFAULT_INSTALL_TIMEOUT_MINUTES],
    ['2.5', DEFAULT_INSTALL_TIMEOUT_MINUTES],
    ['999', MAX_INSTALL_TIMEOUT_MINUTES],
  ])('%p → %p', (raw, expected) => {
    expect(parseInstallTimeoutMinutes(raw)).toBe(expected);
  });
});

describe('funções auxiliares', () => {
  it('redact troca todas as ocorrências e ignora segredo vazio', () => {
    expect(redact('a senha x e x de novo', ['x'])).toBe('a senha *** e *** de novo');
    expect(redact('nada muda', [''])).toBe('nada muda');
  });

  it('toAsciiJson gera só ASCII e preserva o conteúdo', () => {
    const value = { senha: PASSWORD, caminho: 'C:\\Ação\\São Paulo' };
    const json = toAsciiJson(value);
    expect(/^[\x00-\x7f]*$/.test(json)).toBe(true);
    expect(JSON.parse(json)).toEqual(value);
  });

  it('parseLine aceita só o protocolo esperado', () => {
    expect(parseLine('{"type":"log","level":"WARN","phase":"copy","message":"m"}')).toEqual({
      type: 'log', level: 'WARN', phase: 'copy', message: 'm',
    });
    expect(parseLine('{"type":"result","ok":true,"exitCode":3010}')).toEqual({
      type: 'result', result: { ok: true, exitCode: 3010 },
    });
    expect(parseLine('{"type":"result","ok":false,"phase":"inventada","reason":"dns","message":"m"}')).toEqual({
      type: 'result', result: { ok: false, phase: 'executor', reason: 'dns', message: 'm' },
    });
    expect(parseLine('{"type":"result","ok":true,"exitCode":"0"}')).toBeNull();
    expect(parseLine('null')).toBeNull();
    expect(parseLine('texto')).toBeNull();
  });
});

describe('deploy-target.ps1', () => {
  const source = readFileSync(DEPLOY_SCRIPT_PATH);

  it('está salvo em UTF-8 com BOM (sem ele, o PowerShell 5.1 corrompe os acentos)', () => {
    expect([...source.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('não usa Invoke-Expression, cmd /c nem comando montado como texto', () => {
    const code = source
      .toString('utf8')
      .replace(/<#[\s\S]*?#>/g, '')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/Invoke-Expression|\biex\b|cmd(\.exe)?\s+\/c|\[scriptblock\]::Create|AddScript/i);
  });

  const onWindows = process.platform === 'win32' ? describe : describe.skip;

  onWindows('com o powershell.exe real (sem tocar em nenhuma máquina)', () => {
    const real = new PowerShellExecutor(loadPowerShellExecutorConfig({ SystemRoot: process.env.SystemRoot }));
    let dir: string;
    let installerPath: string;

    beforeAll(async () => {
      dir = await fsp.mkdtemp(join(tmpdir(), 'rsd-ps-'));
      installerPath = join(dir, '0f0e0d0c-0b0a-4908-8706-050403020100.msi');
      await fsp.writeFile(installerPath, 'x');
    });
    afterAll(() => fsp.rm(dir, { recursive: true, force: true }));

    it('não tem erro de sintaxe', () => {
      const ps = loadPowerShellExecutorConfig({ SystemRoot: process.env.SystemRoot }).command;
      const r = spawnSync(
        ps,
        [
          '-NoProfile', '-NonInteractive', '-Command',
          `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${DEPLOY_SCRIPT_PATH}', [ref]$null, [ref]$e); $e.Count`,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(r.stdout.trim()).toBe('0');
    });

    it('recusa nome de máquina inválido antes de qualquer conexão', async () => {
      const { result, events } = await runWith(real, input('PC 01; Remove-Item', { installerPath }));
      expect(result).toEqual({ ok: false, phase: 'validate', reason: 'invalid-input', message: 'Nome de máquina inválido.' });
      expect(events).toEqual([]);
    });

    it('relata nome que não existe no DNS (domínio reservado .invalid), com acentos intactos', async () => {
      const { result } = await runWith(real, input('rsd-inexistente.invalid', { installerPath }));
      expect(result).toEqual({
        ok: false,
        phase: 'resolve',
        reason: 'dns',
        message: 'O nome rsd-inexistente.invalid não foi encontrado no DNS.',
      });
    });
  });
});
