import { decideNewRelic, getNewRelic, NewRelicApi, startNewRelic } from './newrelic-loader';

describe('decideNewRelic', () => {
  it('sem chave: desligado, com o motivo', () => {
    expect(decideNewRelic({})).toEqual({ load: false, reason: 'New Relic desligado: NEW_RELIC_LICENSE_KEY ausente.' });
    expect(decideNewRelic({ NEW_RELIC_LICENSE_KEY: '   ' }).load).toBe(false);
  });

  it('NEW_RELIC_ENABLED=false desliga mesmo com a chave', () => {
    expect(decideNewRelic({ NEW_RELIC_LICENSE_KEY: 'x'.repeat(40), NEW_RELIC_ENABLED: ' FALSE ' })).toEqual({
      load: false,
      reason: 'New Relic desligado: NEW_RELIC_ENABLED=false.',
    });
  });

  it('com chave: ligado, e o motivo não traz a chave', () => {
    const d = decideNewRelic({ NEW_RELIC_LICENSE_KEY: 'chave-secreta-de-teste' });
    expect(d.load).toBe(true);
    expect(d.reason).toBe('New Relic ligado (app "RSD (demo)").');
  });
});

describe('startNewRelic', () => {
  const fakeApi: NewRelicApi = { recordLogEvent: jest.fn() };

  it('sem chave: nem carrega o agente, avisa uma vez e a API fica null', () => {
    const load = jest.fn();
    const log = jest.fn();
    expect(startNewRelic({ env: {}, load, log })).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('warn', 'New Relic desligado: NEW_RELIC_LICENSE_KEY ausente.');
    expect(getNewRelic()).toBeNull();
  });

  it('NEW_RELIC_ENABLED=false: não carrega', () => {
    const load = jest.fn();
    startNewRelic({ env: { NEW_RELIC_LICENSE_KEY: 'k', NEW_RELIC_ENABLED: 'false' }, load, log: jest.fn() });
    expect(load).not.toHaveBeenCalled();
  });

  it('com chave: carrega "newrelic" e guarda a API', () => {
    const load = jest.fn().mockReturnValue(fakeApi);
    const log = jest.fn();
    expect(startNewRelic({ env: { NEW_RELIC_LICENSE_KEY: 'k' }, load, log })).toBe(fakeApi);
    expect(load).toHaveBeenCalledWith('newrelic');
    expect(getNewRelic()).toBe(fakeApi);
    expect(log).toHaveBeenCalledWith('log', 'New Relic ligado (app "RSD (demo)").');
  });

  it('o agente falha ao carregar: o backend segue sem ele, com aviso (nunca lança)', () => {
    const log = jest.fn();
    const load = jest.fn(() => {
      throw new Error('módulo quebrado');
    });
    expect(startNewRelic({ env: { NEW_RELIC_LICENSE_KEY: 'k' }, load, log })).toBeNull();
    expect(getNewRelic()).toBeNull();
    expect(log).toHaveBeenCalledWith('warn', 'New Relic desligado: o agente não carregou (módulo quebrado).');
  });

  it('o agente carrega sem recordLogEvent: fica desligado', () => {
    const log = jest.fn();
    expect(startNewRelic({ env: { NEW_RELIC_LICENSE_KEY: 'k' }, load: () => ({}), log })).toBeNull();
    expect(log).toHaveBeenCalledWith('warn', 'New Relic desligado: o agente carregou sem a API esperada.');
  });

  it('sem log injetado, usa o Logger do Nest (contexto NewRelic)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Logger } = require('@nestjs/common') as typeof import('@nestjs/common');
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      startNewRelic({ env: {}, load: jest.fn() });
      expect(warn).toHaveBeenCalledWith('New Relic desligado: NEW_RELIC_LICENSE_KEY ausente.');
    } finally {
      warn.mockRestore();
    }
  });
});
