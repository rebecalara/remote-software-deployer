import {
  configureRequestTimeout,
  DEFAULT_REQUEST_TIMEOUT_MINUTES,
  parseRequestTimeoutMinutes,
} from './http-server.config';

describe('parseRequestTimeoutMinutes', () => {
  it.each([
    [undefined, 30],
    ['', 30],
    ['  ', 30],
    ['30', 30],
    ['1', 1],
    ['120', 120],
    ['121', 120], // teto
    ['9999', 120],
    ['0', 30], // 0 desligaria o limite no Node: recusado
    ['-5', 30],
    ['2.5', 30],
    ['abc', 30],
  ])('%p → %p min', (raw, expected) => {
    expect(parseRequestTimeoutMinutes(raw)).toBe(expected);
  });

  it('o padrão (30 min) cobre um envio de 500 MB a ~2,4 Mbit/s', () => {
    const bytesPerSecond = (2.4 * 1_000_000) / 8;
    const secondsFor500MB = (500 * 1024 * 1024) / bytesPerSecond;
    expect(secondsFor500MB).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MINUTES * 60);
  });
});

describe('configureRequestTimeout', () => {
  const ORIGINAL_ENV = process.env;
  afterEach(() => (process.env = ORIGINAL_ENV));

  it('aplica o valor da variável ao servidor e devolve em ms', () => {
    process.env = { ...ORIGINAL_ENV, HTTP_REQUEST_TIMEOUT_MINUTES: '45' };
    const server = { requestTimeout: 300_000 };
    expect(configureRequestTimeout(server)).toBe(2_700_000);
    expect(server.requestTimeout).toBe(2_700_000);
  });

  it('sem a variável, aplica o padrão de 30 min (não fica nos 5 min do Node)', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.HTTP_REQUEST_TIMEOUT_MINUTES;
    const server = { requestTimeout: 300_000 };
    configureRequestTimeout(server);
    expect(server.requestTimeout).toBe(1_800_000);
  });
});
