import { Logger } from '@nestjs/common';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  formatListenAddress,
  loadListenAddress,
  parseHost,
  parsePort,
} from './listen-address.config';

const fakeLogger = () => ({ warn: jest.fn() }) as unknown as Logger & { warn: jest.Mock };

describe('parsePort', () => {
  it.each([
    ['3000', 3000],
    ['1', 1],
    ['65535', 65535],
    ['8080', 8080],
    [' 4000 ', 4000],
  ])('%p → %p', (raw, expected) => {
    const logger = fakeLogger();
    expect(parsePort(raw, logger)).toBe(expected);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])('%p (ausente) → padrão 3000, sem aviso', (raw) => {
    const logger = fakeLogger();
    expect(parsePort(raw, logger)).toBe(DEFAULT_PORT);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(['0', '65536', '99999', '-1', '30.5', '3000abc', 'abc', '1e3', '0x10', '+3000', '30 00'])(
    '%p (inválido) → padrão 3000, com aviso no Logger',
    (raw) => {
      const logger = fakeLogger();
      expect(parsePort(raw, logger)).toBe(DEFAULT_PORT);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain('PORT');
      expect(logger.warn.mock.calls[0][0]).toContain(String(DEFAULT_PORT));
    },
  );
});

describe('parseHost', () => {
  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['0.0.0.0', '0.0.0.0'],
    ['::1', '::1'],
    ['::', '::'],
    ['localhost', 'localhost'],
    ['rsd-backend', 'rsd-backend'],
    [' 127.0.0.1 ', '127.0.0.1'],
  ])('%p → %p', (raw, expected) => {
    const logger = fakeLogger();
    expect(parseHost(raw, logger)).toBe(expected);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '  '])('%p (ausente) → padrão 127.0.0.1, sem aviso', (raw) => {
    const logger = fakeLogger();
    expect(parseHost(raw, logger)).toBe(DEFAULT_HOST);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(['http://0.0.0.0', '127.0.0.1:3000', '127.0.0.1 ::1', 'host_com_sublinhado', '-inicio', 'a/b'])(
    '%p (inválido) → padrão 127.0.0.1, com aviso no Logger',
    (raw) => {
      const logger = fakeLogger();
      expect(parseHost(raw, logger)).toBe(DEFAULT_HOST);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain('HOST');
      expect(logger.warn.mock.calls[0][0]).toContain(DEFAULT_HOST);
    },
  );
});

describe('loadListenAddress', () => {
  it('sem HOST nem PORT: 127.0.0.1:3000 (só a máquina local; o Caddy fica na frente)', () => {
    expect(loadListenAddress({})).toEqual({ host: '127.0.0.1', port: 3000 });
  });

  it('lê HOST e PORT do ambiente', () => {
    expect(loadListenAddress({ HOST: '0.0.0.0', PORT: '8080' })).toEqual({ host: '0.0.0.0', port: 8080 });
  });

  it('valor inválido em um não afeta o outro', () => {
    const logger = fakeLogger();
    expect(loadListenAddress({ HOST: '0.0.0.0', PORT: '70000' }, logger)).toEqual({ host: '0.0.0.0', port: 3000 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('formatListenAddress', () => {
  it('IPv4', () => {
    expect(formatListenAddress({ address: '127.0.0.1', family: 'IPv4', port: 3000 })).toBe('http://127.0.0.1:3000');
  });

  it('IPv6 entre colchetes', () => {
    expect(formatListenAddress({ address: '::1', family: 'IPv6', port: 3000 })).toBe('http://[::1]:3000');
  });

  it('pipe ou endereço desconhecido: devolve como veio', () => {
    expect(formatListenAddress('\\\\.\\pipe\\rsd')).toBe('\\\\.\\pipe\\rsd');
    expect(formatListenAddress(null)).toBe('(endereço desconhecido)');
  });
});
