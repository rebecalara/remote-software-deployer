import { resolveClientIp } from './client-ip';

describe('resolveClientIp', () => {
  describe('requisição vinda do Caddy (127.0.0.1): confia no X-Forwarded-For', () => {
    it.each([
      ['203.0.113.7', '203.0.113.7'],
      [' 203.0.113.7 ', '203.0.113.7'],
      ['2001:db8::1', '2001:db8::1'],
      ['::ffff:203.0.113.7', '203.0.113.7'],
    ])('XFF %p → %p', (xff, expected) => {
      expect(resolveClientIp('127.0.0.1', xff)).toBe(expected);
    });

    it('mesmo com o endereço do socket em formato IPv6 mapeado (::ffff:127.0.0.1)', () => {
      expect(resolveClientIp('::ffff:127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    });

    it('lista: vale o último (o que o Caddy acrescentou), não o que o cliente mandou', () => {
      // Cliente mandou "1.1.1.1" por conta própria; quem o Caddy viu foi 203.0.113.7.
      expect(resolveClientIp('127.0.0.1', '1.1.1.1, 203.0.113.7')).toBe('203.0.113.7');
    });

    it('cabeçalho repetido (array): junta e vale o último', () => {
      expect(resolveClientIp('127.0.0.1', ['1.1.1.1', '203.0.113.7'])).toBe('203.0.113.7');
    });

    it.each([undefined, '', 'lixo', '203.0.113.7:4444', 'unknown'])(
      'XFF ausente ou inválido (%p): usa o endereço do socket',
      (xff) => {
        expect(resolveClientIp('127.0.0.1', xff)).toBe('127.0.0.1');
      },
    );
  });

  describe('requisição de qualquer outro endereço: ignora o X-Forwarded-For (seria falsificável)', () => {
    it.each([
      ['198.51.100.9', '1.2.3.4', '198.51.100.9'],
      ['::ffff:198.51.100.9', '1.2.3.4', '198.51.100.9'],
      ['10.0.0.5', '127.0.0.1', '10.0.0.5'],
      ['::1', '1.2.3.4', '::1'], // só 127.0.0.1 é o Caddy
      ['127.0.0.2', '1.2.3.4', '127.0.0.2'],
    ])('socket %p com XFF %p → %p', (remote, xff, expected) => {
      expect(resolveClientIp(remote, xff)).toBe(expected);
    });
  });

  it('sem endereço do socket: "desconhecido" (agrupa num balde só, nunca libera)', () => {
    expect(resolveClientIp(undefined, undefined)).toBe('desconhecido');
  });
});
