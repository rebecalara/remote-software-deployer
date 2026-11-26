import { Logger } from '@nestjs/common';
import { AppLogger } from './app-logger';
import { NewRelicApi } from './newrelic-loader';
import { Redactor } from './redact';

// Chave FALSA montada em tempo de execução: nenhuma literal no repositório tem o formato de uma
// license key do New Relic (o secret scanning do GitHub a confundiria com uma chave real).
const FAKE_LICENSE_KEY = 'abcdef0123456789'.repeat(2) + 'abcd' + 'NRAL';

const ENV = {
  JWT_SECRET: 'jwt-segredo-de-teste-com-mais-de-32-caracteres-xyz',
  LDAP_SEARCH_BIND_PASSWORD: 'Ldap#Senha!2026',
  WINRM_PASSWORD: 'WinRMsenhaDeTeste',
  NEW_RELIC_LICENSE_KEY: FAKE_LICENSE_KEY,
  DATABASE_URL: 'postgresql://rsd_app:DbSenhaDeTeste@127.0.0.1:5432/rsd?schema=public',
};
const SECRETS = [ENV.JWT_SECRET, ENV.LDAP_SEARCH_BIND_PASSWORD, ENV.WINRM_PASSWORD, ENV.NEW_RELIC_LICENSE_KEY, 'DbSenhaDeTeste'];

describe('AppLogger', () => {
  let sent: Record<string, unknown>[];
  let api: NewRelicApi;
  let out: jest.SpyInstance;
  let err: jest.SpyInstance;

  beforeEach(() => {
    sent = [];
    api = { recordLogEvent: (e) => sent.push(e) };
    // O console é o do Nest (process.stdout/stderr): silenciado e conferido.
    out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    out.mockRestore();
    err.mockRestore();
    Logger.overrideLogger(true);
  });

  const make = (withAgent = true) => new AppLogger({ newRelic: () => (withAgent ? api : null), redactor: Redactor.fromEnv(ENV) });

  it('sem o agente: só o console, nada enviado', () => {
    make(false).log('olá', 'Teste');
    expect(sent).toEqual([]);
    expect(out.mock.calls.join('')).toContain('olá');
  });

  it('com o agente: console igual e o New Relic recebe mensagem, nível e contexto', () => {
    const logger = make();
    logger.log('Backend escutando', 'Bootstrap');
    logger.warn('cuidado', 'Sync');
    logger.debug('detalhe', 'X');
    expect(out.mock.calls.join('')).toContain('Backend escutando');
    expect(sent).toEqual([
      { message: 'Backend escutando', level: 'INFO', 'log.context': 'Bootstrap' },
      { message: 'cuidado', level: 'WARN', 'log.context': 'Sync' },
      { message: 'detalhe', level: 'DEBUG', 'log.context': 'X' },
    ]);
  });

  it('nenhum segredo chega ao New Relic: mensagem, stack, objeto e mensagem estruturada', () => {
    const logger = make();
    logger.log(`jwt ${ENV.JWT_SECRET} e ldap ${ENV.LDAP_SEARCH_BIND_PASSWORD}`, 'A');
    logger.warn(`winrm ${ENV.WINRM_PASSWORD}; licença ${ENV.NEW_RELIC_LICENSE_KEY}`, 'B');
    logger.error(`banco ${ENV.DATABASE_URL}`, `Error: x\n    at f (postgresql://rsd_app:DbSenhaDeTeste@h/rsd)`, 'C');
    logger.log({ password: 'senha-digitada-no-login', detalhe: `Bearer ${'eyJa.eyJb.c'}` }, 'D');
    logger.log({ message: 'evento', attributes: { 'user.name': 'rebeca', token: 'tok-123', nota: `license_key=${ENV.NEW_RELIC_LICENSE_KEY}` } }, 'E');
    const payload = JSON.stringify(sent);
    for (const secret of [...SECRETS, 'senha-digitada-no-login', 'tok-123', 'eyJa.eyJb.c']) expect(payload).not.toContain(secret);
    expect(sent).toHaveLength(5);
    expect(sent[2]).toMatchObject({ level: 'ERROR', 'log.context': 'C', 'error.stack': expect.stringContaining('[REDACTED]') });
    expect(sent[4]).toEqual({ message: 'evento', 'user.name': 'rebeca', token: '[REDACTED]', nota: 'license_key=[REDACTED]', level: 'INFO', 'log.context': 'E' });
  });

  it('mensagem estruturada aparece no console como "texto {atributos}"', () => {
    make(false).log({ message: 'Login', attributes: { 'security.result': 'success' } }, 'Security');
    expect(out.mock.calls.join('')).toContain('Login {"security.result":"success"}');
  });

  it('pelo Logger do Nest (como o resto do backend usa): o contexto da instância vai junto', () => {
    Logger.overrideLogger(make());
    new Logger('MachineSync').error('Falha ao buscar computadores no LDAP: conexão recusada');
    expect(sent).toEqual([{ message: 'Falha ao buscar computadores no LDAP: conexão recusada', level: 'ERROR', 'log.context': 'MachineSync' }]);
  });

  it('o agente falha ao receber: o log não quebra e o console continua', () => {
    const logger = new AppLogger({
      newRelic: () => ({
        recordLogEvent: () => {
          throw new Error('fila cheia');
        },
      }),
      redactor: Redactor.fromEnv(ENV),
    });
    expect(() => logger.log('segue', 'X')).not.toThrow();
    expect(out.mock.calls.join('')).toContain('segue');
  });

  it('sem dependências injetadas, usa a API do loader (null sem agente) e o ambiente do processo', () => {
    const logger = new AppLogger();
    expect(() => logger.log('sem agente', 'X')).not.toThrow();
    expect(sent).toEqual([]);
  });
});
