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
  const allTracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !/(^|\/)(package-lock\.json|node_modules\/)/.test(f) && !/\.(png|jpe?g|ico|woff2?|ttf|pdf|msi|exe)$/i.test(f));
  // Os testes atribuem valores FALSOS à variável (para provar o mascaramento); a regra da
  // atribuição vale para o resto: código, scripts, modelos de .env, workflows, documentação.
  const tracked = allTracked.filter((f) => !/\.spec\.ts$/.test(f));
  const read = (f: string): string => {
    try {
      return readFileSync(join(REPO, f), 'utf8');
    } catch {
      return '';
    }
  };

  it('a varredura cobre o código, os modelos de .env e os testes', () => {
    expect(tracked).toEqual(expect.arrayContaining(['backend/newrelic.js', 'backend/.env.example', 'deploy/backend.env.example', 'backend/src/main.ts']));
    expect(allTracked).toEqual(expect.arrayContaining(['backend/src/observability/redact.spec.ts', 'README.md']));
  });

  it('nenhum arquivo versionado (fora os testes) preenche NEW_RELIC_LICENSE_KEY', () => {
    // Atribuição com valor (vazio "" ou '' é o modelo).
    expect(tracked.filter((f) => /NEW_RELIC_LICENSE_KEY\s*[=:]\s*["']?[A-Za-z0-9]/.test(read(f)))).toEqual([]);
  });

  it('NENHUM arquivo versionado, nem os testes, tem uma literal no formato de license key (36 caracteres + NRAL)', () => {
    // O secret scanning do GitHub abriu alerta por uma chave FALSA de teste nesse formato. Valor
    // falso de teste é montado em tempo de execução (ex.: 'abcdef0123456789'.repeat(2) + 'abcd' + 'NRAL').
    expect(allTracked.filter((f) => /[0-9A-Za-z]{36}NRAL/.test(read(f)))).toEqual([]);
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
