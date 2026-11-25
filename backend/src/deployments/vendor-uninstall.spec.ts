import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UNINSTALL_CASES_PATH,
  UNINSTALL_RULES_SCRIPT_PATH,
  checkUninstallCommand,
  programId,
  vendorUninstallEnabled,
} from './vendor-uninstall';
import { REAL_POWERSHELL_TEST_TIMEOUT_MS } from './testing/real-powershell';

// Exceção controlada: comando de desinstalação do fabricante (programa que não é MSI).
// Os MESMOS casos rodam no validador do servidor (TypeScript) e no da máquina (PowerShell).

interface Case {
  name: string;
  command: string;
  ok: boolean;
  executable?: string;
  arguments?: string;
  reason?: string;
}
const data = JSON.parse(readFileSync(UNINSTALL_CASES_PATH, 'utf8')) as { roots: string[]; cases: Case[] };

describe('checkUninstallCommand (servidor)', () => {
  it.each(data.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const r = checkUninstallCommand(c.command, data.roots);
    if (c.ok) {
      expect(r).toEqual({ ok: true, executable: c.executable, arguments: c.arguments });
    } else {
      expect(r.ok).toBe(false);
      expect('reason' in r && r.reason).toContain(c.reason);
    }
  });
});

describe('vendorUninstallEnabled e programId', () => {
  it('padrão DESLIGADO; só "true" liga', () => {
    expect(vendorUninstallEnabled({})).toBe(false);
    expect(vendorUninstallEnabled({ DEPLOYMENT_ALLOW_VENDOR_UNINSTALL: 'false' })).toBe(false);
    expect(vendorUninstallEnabled({ DEPLOYMENT_ALLOW_VENDOR_UNINSTALL: '1' })).toBe(false);
    expect(vendorUninstallEnabled({ DEPLOYMENT_ALLOW_VENDOR_UNINSTALL: ' TRUE ' })).toBe(true);
  });

  it('programId muda com a visão, a subchave ou o comando', () => {
    const base = programId('64', '7-Zip', '"C:\\Program Files\\7-Zip\\Uninstall.exe" /S');
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(programId('32', '7-Zip', '"C:\\Program Files\\7-Zip\\Uninstall.exe" /S')).not.toBe(base);
    expect(programId('64', '7-Zip-x', '"C:\\Program Files\\7-Zip\\Uninstall.exe" /S')).not.toBe(base);
    expect(programId('64', '7-Zip', '"C:\\Program Files\\7-Zip\\Uninstall.exe" /S /x')).not.toBe(base);
  });
});

const onWindows = process.platform === 'win32' ? describe : describe.skip;
onWindows('uninstall-command-rules.ps1 (máquina) — mesmos casos, mesmo resultado', () => {
  it('UTF-8 com BOM', () => {
    expect([...readFileSync(UNINSTALL_RULES_SCRIPT_PATH).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('cada caso dá exatamente o mesmo resultado nos dois validadores', () => {
    const runner = join(__dirname, 'testing', 'run-uninstall-cases.ps1');
    const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const r = spawnSync(
      ps,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner, '-Rules', UNINSTALL_RULES_SCRIPT_PATH, '-Cases', UNINSTALL_CASES_PATH],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(r.stderr).toBe('');
    const fromPs = JSON.parse(r.stdout) as Array<{ ok: boolean; executable: string | null; arguments: string | null; reason: string | null }>;
    expect(fromPs).toHaveLength(data.cases.length);
    data.cases.forEach((c, i) => {
      const ts = checkUninstallCommand(c.command, data.roots);
      const p = fromPs[i];
      expect({ name: c.name, ok: p.ok, executable: p.executable ?? undefined, arguments: p.arguments ?? undefined, reason: p.reason ?? undefined }).toEqual({
        name: c.name,
        ok: ts.ok,
        executable: 'executable' in ts ? ts.executable : undefined,
        arguments: 'arguments' in ts ? ts.arguments : undefined,
        reason: 'reason' in ts ? ts.reason : undefined,
      });
    });
  }, REAL_POWERSHELL_TEST_TIMEOUT_MS);
});
