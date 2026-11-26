import { Logger } from '@nestjs/common';
import {
  buildSecurityAttributes,
  includePii,
  INVALID_USERNAME,
  pseudonymizeUser,
  recordSecurityEvent,
  requestIp,
  truncateIp,
  typedUsername,
} from './security-events';

const UPN_TEMPLATE = { LDAP_BIND_DN_TEMPLATE: '{{username}}@rsd-demo.local' };

describe('privacidade (SECURITY_EVENTS_INCLUDE_PII)', () => {
  it('padrão FALSE (LGPD); só "true" mostra usuário e IP em texto', () => {
    expect(includePii({})).toBe(false);
    expect(includePii({ SECURITY_EVENTS_INCLUDE_PII: ' TRUE ' })).toBe(true);
    expect(includePii({ SECURITY_EVENTS_INCLUDE_PII: 'false' })).toBe(false);
    expect(includePii({ SECURITY_EVENTS_INCLUDE_PII: 'sim' })).toBe(false);
  });

  it('hash curto do usuário: 12 caracteres, estável, e muda com o sal', () => {
    const a = pseudonymizeUser('rebeca', 'sal-1');
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(pseudonymizeUser('rebeca', 'sal-1')).toBe(a);
    expect(pseudonymizeUser('rebeca', 'sal-2')).not.toBe(a);
    expect(pseudonymizeUser('operador', 'sal-1')).not.toBe(a);
  });

  it.each([
    ['203.0.113.57', '203.0.113.0/24'],
    ['10.0.0.1', '10.0.0.0/24'],
    ['2001:db8:abcd:12::1', '2001:db8:abcd::/48'],
    ['::1', '0:0:0::/48'],
    ['2001:0db8:0001::', '2001:db8:1::/48'],
    ['desconhecido', 'desconhecido'],
  ])('prefixo de rede de %s = %s', (ip, expected) => {
    expect(truncateIp(ip)).toBe(expected);
  });
});

describe('typedUsername (usuário digitado no login)', () => {
  it.each([
    ['Rebeca', 'rebeca'],
    ['  operador ', 'operador'],
    ['joao.silva-2', 'joao.silva-2'],
  ])('%j vira %j', (raw, expected) => {
    expect(typedUsername(raw, UPN_TEMPLATE)).toBe(expected);
  });

  it.each([
    ['minha senha'],
    ['S3nh@Forte!'],
    ['a=b'],
    [''],
    ['x'.repeat(65)],
  ])('%j vira <inválido> (pode ser a senha digitada no campo errado)', (raw) => {
    expect(typedUsername(raw, UPN_TEMPLATE)).toBe(INVALID_USERNAME);
  });

  it('não texto vira <inválido>; UPN só quando o modelo é exatamente {{username}}', () => {
    expect(typedUsername(undefined)).toBe(INVALID_USERNAME);
    expect(typedUsername(42)).toBe(INVALID_USERNAME);
    expect(typedUsername('rebeca@rsd-demo.local', UPN_TEMPLATE)).toBe(INVALID_USERNAME);
    expect(typedUsername('rebeca@rsd-demo.local', { LDAP_BIND_DN_TEMPLATE: '{{username}}' })).toBe('rebeca@rsd-demo.local');
  });
});

describe('buildSecurityAttributes', () => {
  const event = {
    event: 'auth.login' as const,
    result: 'failure' as const,
    user: 'rebeca',
    role: 'ADMIN',
    ip: '203.0.113.57',
    details: { 'http.status': 401, reason: 'rejected', vazio: null, ausente: undefined, longo: 'x'.repeat(500) },
  };

  it('com PII: usuário e IP como estão; detalhes nulos saem; texto longo é cortado em 200', () => {
    const a = buildSecurityAttributes(event, { SECURITY_EVENTS_INCLUDE_PII: 'true', JWT_SECRET: 'sal' });
    expect(a).toEqual({
      'security.event': 'auth.login',
      'security.result': 'failure',
      'security.pii': true,
      'user.name': 'rebeca',
      'user.role': 'ADMIN',
      'client.ip': '203.0.113.57',
      'http.status': 401,
      reason: 'rejected',
      longo: 'x'.repeat(200),
    });
  });

  it('sem PII: usuário vira hash com o JWT_SECRET como sal e IP vira /24; "<inválido>" não é hash', () => {
    const env = { SECURITY_EVENTS_INCLUDE_PII: 'false', JWT_SECRET: 'sal-do-jwt' };
    const a = buildSecurityAttributes(event, env);
    expect(a['user.name']).toBe(pseudonymizeUser('rebeca', 'sal-do-jwt'));
    expect(a['client.ip']).toBe('203.0.113.0/24');
    expect(a['security.pii']).toBe(false);
    expect(JSON.stringify(a)).not.toMatch(/rebeca|203\.0\.113\.57/);
    expect(buildSecurityAttributes({ ...event, user: INVALID_USERNAME }, env)['user.name']).toBe(INVALID_USERNAME);
  });

  it('sem usuário, papel e IP (evento de fundo): esses atributos não aparecem', () => {
    expect(buildSecurityAttributes({ event: 'deployment.finished', result: 'success' }, {})).toEqual({
      'security.event': 'deployment.finished',
      'security.result': 'success',
      'security.pii': false,
    });
  });
});

describe('recordSecurityEvent', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    log.mockRestore();
    warn.mockRestore();
  });

  it('sucesso vai como INFO; falha, bloqueio e negação como WARN — mensagem estruturada', () => {
    recordSecurityEvent({ event: 'auth.login', result: 'success', user: 'rebeca' }, { SECURITY_EVENTS_INCLUDE_PII: 'true' });
    expect(log).toHaveBeenCalledWith({ message: 'auth.login success', attributes: expect.objectContaining({ 'user.name': 'rebeca' }) });
    for (const result of ['failure', 'unavailable', 'rate_limited', 'denied', 'expired', 'invalid'] as const) {
      recordSecurityEvent({ event: 'auth.login', result }, {});
    }
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it('nunca lança: nem se a montagem do evento falhar', () => {
    expect(() =>
      recordSecurityEvent(() => {
        throw new Error('view indefinida');
      }),
    ).not.toThrow();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('requestIp', () => {
  it('mesma regra do limite de login: X-Forwarded-For só vindo do Caddy (127.0.0.1)', () => {
    expect(requestIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe('203.0.113.7');
    expect(requestIp({ socket: { remoteAddress: '198.51.100.9' }, headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe('198.51.100.9');
    expect(requestIp(undefined)).toBe('desconhecido');
  });
});
