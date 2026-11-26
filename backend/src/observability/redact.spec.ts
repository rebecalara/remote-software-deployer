import { REDACTED, Redactor, secretValuesFromEnv } from './redact';

// Chave FALSA montada em tempo de execução: nenhuma literal no repositório tem o formato de uma
// license key do New Relic (o secret scanning do GitHub a confundiria com uma chave real).
const FAKE_LICENSE_KEY = 'abcdef0123456789'.repeat(2) + 'abcd' + 'NRAL';

const ENV = {
  JWT_SECRET: 'jwt-segredo-de-teste-com-mais-de-32-caracteres-xyz',
  LDAP_SEARCH_BIND_PASSWORD: 'Ldap#Senha!2026',
  WINRM_PASSWORD: 'WinRM pass com espaço',
  NEW_RELIC_LICENSE_KEY: FAKE_LICENSE_KEY,
  DATABASE_URL: 'postgresql://rsd_app:Db%40Senha_1@127.0.0.1:5432/rsd?schema=public',
  HOST: '127.0.0.1',
};

describe('secretValuesFromEnv', () => {
  it('pega os 4 segredos e a senha do DATABASE_URL (crua e decodificada); ignora o resto', () => {
    const values = secretValuesFromEnv(ENV);
    expect(values).toEqual(
      expect.arrayContaining([ENV.JWT_SECRET, ENV.LDAP_SEARCH_BIND_PASSWORD, ENV.WINRM_PASSWORD, ENV.NEW_RELIC_LICENSE_KEY, 'Db%40Senha_1', 'Db@Senha_1']),
    );
    expect(values).not.toContain('127.0.0.1');
    expect(values).toHaveLength(6);
  });

  it('vazio ou curto demais não vira segredo (não mascara letras comuns)', () => {
    expect(secretValuesFromEnv({ JWT_SECRET: '', WINRM_PASSWORD: 'abc', DATABASE_URL: 'postgresql://u@h/db' })).toEqual([]);
  });
});

describe('Redactor', () => {
  const r = Redactor.fromEnv(ENV);

  it.each([
    ['valor exato de cada segredo', `jwt=${ENV.JWT_SECRET} ldap ${ENV.LDAP_SEARCH_BIND_PASSWORD} winrm "${ENV.WINRM_PASSWORD}"`],
    ['URL do banco com senha', 'falha em postgresql://outro:OutraSenha@db:5432/x'],
    ['Bearer', 'Authorization: Bearer abc.DEF-ghi_123'],
    ['JWT solto', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJh recusado'],
    ['license_key em URL', 'POST https://collector.newrelic.com/agent_listener/invoke_raw_method?license_key=OUTRAchave123&method=connect'],
    ['campos password/senha/token/secret', 'password=abc123 senha: "xyz789" token=t0k3n secret:s3cr3t'],
  ])('mascara: %s', (_name, input) => {
    const out = r.text(input);
    expect(out).toContain(REDACTED);
    for (const leaked of [ENV.JWT_SECRET, ENV.LDAP_SEARCH_BIND_PASSWORD, ENV.WINRM_PASSWORD, 'OutraSenha', 'abc.DEF-ghi_123', 'c2lnbmF0dXJh', 'OUTRAchave123', 'abc123', 'xyz789', 't0k3n', 's3cr3t']) {
      expect(out).not.toContain(leaked);
    }
  });

  it('mantém o que não é segredo', () => {
    expect(r.text('Login de "rebeca" a partir de 203.0.113.7: 401')).toBe('Login de "rebeca" a partir de 203.0.113.7: 401');
    expect(r.text('postgresql://rsd_app@127.0.0.1/rsd')).toBe('postgresql://rsd_app@127.0.0.1/rsd');
  });

  it('objetos em qualquer profundidade; campos com nome de segredo viram [REDACTED]; Error vira texto mascarado', () => {
    const out = r.value({
      user: 'rebeca',
      password: 'qualquer',
      nested: { list: [`x ${ENV.NEW_RELIC_LICENSE_KEY}`, { Authorization: 'Bearer zzz', ok: 1 }] },
      err: new Error(`conexão ${ENV.DATABASE_URL}`),
    });
    expect(out).toEqual({
      user: 'rebeca',
      password: REDACTED,
      nested: { list: [`x ${REDACTED}`, { Authorization: REDACTED, ok: 1 }] },
      err: `Error: conexão postgresql://rsd_app:${REDACTED}@127.0.0.1:5432/rsd?schema=public`,
    });
    expect(JSON.stringify(out)).not.toMatch(/Db%40Senha_1|Db@Senha_1|qualquer|zzz|NRAL/);
  });

  it('o segredo mais longo é trocado primeiro (um segredo que contém outro não vaza pela metade)', () => {
    const r2 = new Redactor(['abcd', 'abcdefgh']);
    expect(r2.text('abcdefgh')).toBe(REDACTED);
  });
});
