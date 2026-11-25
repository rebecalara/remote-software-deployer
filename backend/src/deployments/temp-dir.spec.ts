import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOY_SCRIPT_PATH } from './powershell-executor';
import { REAL_POWERSHELL_TEST_TIMEOUT_MS } from './testing/real-powershell';

// Pasta temporária na máquina de destino: só SYSTEM e Administradores, sem herança, conferida
// antes de usar (usuário comum não pode pré-criá-la nem plantar arquivos/DLLs nela).

const RULES = join(__dirname, '..', '..', 'scripts', 'temp-dir-rules.ps1');
const SYSTEM = 'S-1-5-18';
const ADMINS = 'S-1-5-32-544';

describe('deploy-target.ps1 — pasta temporária', () => {
  const text = readFileSync(DEPLOY_SCRIPT_PATH, 'utf8');
  const code = text
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  it('usa C:\\ProgramData\\RSD, não mais C:\\Windows\\Temp', () => {
    expect(code).toContain("$RemoteBaseDir = 'C:\\ProgramData\\RSD'");
    expect(code).not.toMatch(/Windows\\Temp/i);
  });

  it('carrega as regras e prepara a pasta PELA SESSÃO WinRM, antes de copiar', () => {
    expect(code).toContain(". (Join-Path $PSScriptRoot 'temp-dir-rules.ps1')");
    const prepare = code.indexOf('${function:Initialize-RsdTempDir}');
    const copy = code.indexOf('Copy-Item -LiteralPath $in.installerPath');
    expect(prepare).toBeGreaterThan(0);
    expect(copy).toBeGreaterThan(prepare);
    expect(code.slice(prepare - 200, prepare)).toContain('Invoke-Command -Session $session');
  });

  it('não cria mais a pasta pelo compartilhamento C$ (que herdaria a ACL do pai)', () => {
    expect(code).not.toMatch(/New-Item -ItemType Directory -Path \$remoteDir/);
  });

  it('pasta insegura vira falha com motivo próprio, sem copiar nem executar', () => {
    expect(code).toContain("'unsafe-temp-dir'");
    expect(code).toContain("'temp-dir-failed'");
  });
});

const onWindows = process.platform === 'win32' ? describe : describe.skip;
onWindows('temp-dir-rules.ps1 (PowerShell de verdade, pasta temporária desta máquina)', () => {
  type Case = { name: string; ok: boolean; message: string | null; extra: Record<string, unknown> | null };
  let me = '';
  let cases: Case[] = [];
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rsd-tempdir-'));
    const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const runner = join(__dirname, 'testing', 'run-temp-dir-cases.ps1');
    const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner, '-Rules', RULES, '-Root', root], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.stderr) throw new Error(r.stderr);
    const parsed = JSON.parse(r.stdout) as { me: string; cases: Case[] };
    me = parsed.me;
    cases = parsed.cases;
  }, REAL_POWERSHELL_TEST_TIMEOUT_MS);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const get = (name: string) => {
    const c = cases.find((x) => x.name === name);
    if (!c) throw new Error(`caso ${name} não rodou`);
    return c;
  };

  it('UTF-8 com BOM (mensagens com acento no PowerShell 5.1)', () => {
    expect([...readFileSync(RULES).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('pasta-base nova: criada sem herança, só SYSTEM, Administradores (e o dono do teste)', () => {
    const c = get('cria-base-e-alvo');
    expect(c).toMatchObject({ ok: true });
    const extra = c.extra as { exists: boolean; base: { owner: string; protected: boolean; sids: string[] }; alvo: { protected: boolean; sids: string[] } };
    expect(extra.exists).toBe(true);
    expect(extra.base.protected).toBe(true);
    expect(extra.base.owner).toBe(me);
    expect([...extra.base.sids].sort()).toEqual([ADMINS, SYSTEM, me].sort());
    expect(extra.alvo.protected).toBe(true);
    expect([...extra.alvo.sids].sort()).toEqual([ADMINS, SYSTEM, me].sort());
  });

  it('segunda vez: aceita a base certa e refaz a pasta do alvo vazia (sobra apagada)', () => {
    expect(get('idempotente-refaz-alvo')).toMatchObject({ ok: true, extra: { files: 0 } });
  });

  it.each([
    ['base-com-users', /Users|S-1-5-32-545|permiss/i],
    ['base-com-heranca', /herança/i],
    ['dono-errado', /dono/i],
    ['base-juncao', /junção|link/i],
    ['alvo-juncao', /junção|link/i],
  ])('recusa %s, com o motivo', (name, reason) => {
    const c = get(name);
    expect(c.ok).toBe(false);
    expect(c.message).toMatch(/^Pasta temporária insegura/);
    expect(c.message).toMatch(reason);
  });

  it('nada é criado dentro de uma base recusada, e a junção do alvo não é seguida', () => {
    expect(get('base-com-users-nada-dentro').ok).toBe(true);
    expect(get('alvo-juncao-destino-intacto').ok).toBe(true);
  });
});
