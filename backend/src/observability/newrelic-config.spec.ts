import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Configuração do agente New Relic (backend/newrelic.js), conferida contra o schema do próprio
// newrelic 14.12.0 instalado.

const BACKEND = join(__dirname, '..', '..');
const REPO = join(BACKEND, '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { config } = require(join(BACKEND, 'newrelic.js')) as { config: Record<string, any> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const validateConfig = require('newrelic/lib/config/validate-config.js') as (c: unknown, t: boolean) => { status: number; errors: unknown };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require('newrelic/lib/config/schema.json') as SchemaNode;

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
}

/** Caminhos de todas as folhas de um objeto ("a.b.c"), sem descer em arrays. */
function leafPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? leafPaths(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe('backend/newrelic.js', () => {
  it('passa no validador do próprio agente e só usa opções que existem no schema (nada de chave com erro de digitação)', () => {
    expect(validateConfig(structuredClone(config), false)).toEqual({ status: 0, errors: null });
    const unknown = leafPaths(config).filter((path) => {
      let node: SchemaNode | undefined = schema;
      for (const part of path.split('.')) node = node?.properties?.[part];
      return !node;
    });
    expect(unknown).toEqual([]);
  });

  it('nome do app, log do agente na saída padrão e nenhuma chave de licença no arquivo', () => {
    expect(config.app_name).toEqual(['RSD (demo)']);
    expect(config.logging).toEqual({ level: 'info', filepath: 'stdout' });
    expect(config).not.toHaveProperty('license_key');
    expect(readFileSync(join(BACKEND, 'newrelic.js'), 'utf8')).not.toMatch(/license_key\s*:/);
  });

  it('sem segredo para o New Relic: cabeçalhos de credencial excluídos, mensagens de erro fora, SQL ofuscado', () => {
    expect(config.allow_all_headers).toBe(false);
    expect(config.attributes.exclude).toEqual(
      expect.arrayContaining([
        'request.headers.authorization',
        'request.headers.cookie',
        'request.headers.proxyAuthorization',
        'request.headers.setCookie*',
        'response.headers.setCookie*',
        'request.parameters.*',
      ]),
    );
    expect(config.strip_exception_messages).toEqual({ enabled: true });
    expect(config.transaction_tracer.record_sql).toBe('obfuscated');
    expect(config.slow_sql).toEqual({ enabled: false });
    expect(config.audit_log).toEqual({ enabled: false });
    expect(config.security).toEqual({ enabled: false, agent: { enabled: false } });
    expect(config.high_security).toBe(false);
  });

  it('logs no New Relic pelo AppLogger (forwarding ligado, sem mexer no log local)', () => {
    expect(config.application_logging).toEqual({
      enabled: true,
      forwarding: { enabled: true },
      local_decorating: { enabled: false },
      metrics: { enabled: true },
    });
  });
});

describe('chave do New Relic fora do repositório e do CI', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !/(^|\/)(package-lock\.json|node_modules\/)/.test(f) && !/\.(png|jpe?g|ico|woff2?|ttf|pdf|msi|exe)$/i.test(f))
    // Os testes precisam de valores FALSOS de segredo (para provar o mascaramento); o resto do
    // repositório — código, scripts, modelos de .env, workflows, documentação — é varrido.
    .filter((f) => !/\.spec\.ts$/.test(f));

  it('a varredura cobre o código e os modelos de .env', () => {
    expect(tracked).toEqual(expect.arrayContaining(['backend/newrelic.js', 'backend/.env.example', 'deploy/backend.env.example', 'backend/src/main.ts']));
  });

  it('nenhum arquivo versionado (fora os testes) preenche NEW_RELIC_LICENSE_KEY nem tem uma chave de licença', () => {
    const offenders: string[] = [];
    for (const f of tracked) {
      let text: string;
      try {
        text = readFileSync(join(REPO, f), 'utf8');
      } catch {
        continue;
      }
      // Atribuição com valor (vazio "" ou '' é o modelo); chave de licença tem 40 caracteres e
      // termina em "NRAL".
      if (/NEW_RELIC_LICENSE_KEY\s*[=:]\s*["']?[A-Za-z0-9]/.test(text) || /\b[A-Za-z0-9]{36}NRAL\b/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('o CI não usa New Relic (nem chave nem agente)', () => {
    expect(readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8')).not.toMatch(/NEW_RELIC|newrelic/i);
  });

  it('o main.ts carrega o instrument.ts antes de qualquer outro import', () => {
    const firstImport = readFileSync(join(BACKEND, 'src', 'main.ts'), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('import '));
    expect(firstImport).toBe("import './observability/instrument';");
  });
});
