import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { LoginRateLimiter } from '../auth/login-rate-limiter';
import { InventoryService } from '../inventory/inventory.service';
import { LdapAuthenticationError, LdapConnectionError } from '../ldap/ldap.service';
import { AppLogger } from './app-logger';
import { Redactor } from './redact';
import { ipForLogs, pseudonymizeUser, userForLogs } from './security-events';

/**
 * Com SECURITY_EVENTS_INCLUDE_PII no padrão (false), NENHUM log enviado ao New Relic — evento de
 * segurança ou log comum do AuthService, do login e do inventário — tem o usuário em texto nem o IP
 * completo. O logger é o AppLogger de verdade, com a API do New Relic falsa: o que ela recebe é o
 * que iria para lá.
 */

const SALT = 'segredo-jwt-de-teste-com-mais-de-32-caracteres';
const USER = 'rebeca';
const CLIENT_IP = '203.0.113.57';
const HASH = pseudonymizeUser(USER, SALT);

describe('userForLogs / ipForLogs (mesma regra e mesmo hash dos eventos de segurança)', () => {
  it('padrão (sem a variável): pseudônimo igual ao user.name do evento, IP em /24', () => {
    expect(userForLogs(USER, { JWT_SECRET: SALT })).toBe(`usuário#${HASH}`);
    expect(ipForLogs(CLIENT_IP, {})).toBe('203.0.113.0/24');
  });

  it('com SECURITY_EVENTS_INCLUDE_PII=true: usuário entre aspas (sem forjar linhas) e IP inteiro', () => {
    const env = { SECURITY_EVENTS_INCLUDE_PII: 'true', JWT_SECRET: SALT };
    expect(userForLogs('rebeca\nFALSO', env)).toBe('"rebeca\\nFALSO"');
    expect(ipForLogs(CLIENT_IP, env)).toBe(CLIENT_IP);
  });
});

describe('logs enviados ao New Relic com PII=false (padrão)', () => {
  let sent: Record<string, unknown>[];
  const envBackup = { ...process.env };

  beforeEach(() => {
    sent = [];
    process.env.JWT_SECRET = SALT;
    delete process.env.SECURITY_EVENTS_INCLUDE_PII;
    process.env.LDAP_BIND_DN_TEMPLATE = '{{username}}@rsd-demo.local';
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    Logger.overrideLogger(new AppLogger({ newRelic: () => ({ recordLogEvent: (e) => sent.push(e) }), redactor: Redactor.fromEnv(process.env) }));
  });
  afterEach(() => {
    process.env = { ...envBackup };
    jest.restoreAllMocks();
    Logger.overrideLogger(true);
  });

  const noPlainUser = () => {
    const payload = JSON.stringify(sent);
    expect(sent.length).toBeGreaterThan(0);
    expect(payload).not.toMatch(new RegExp(`"${USER}"|\\b${USER}\\b`, 'i'));
    expect(payload).not.toContain(CLIENT_IP);
  };

  const authService = (bind: () => Promise<void>, user: unknown = null) =>
    new AuthService(
      { bind: jest.fn(bind) } as never,
      { user: { findUnique: jest.fn().mockResolvedValue(user) } } as never,
      new JwtService({ secret: SALT }),
    );

  it.each([
    ['senha recusada pelo AD', () => Promise.reject(new LdapAuthenticationError('Invalid Credentials'))],
    ['AD fora do ar', () => Promise.reject(new LdapConnectionError('connect ECONNREFUSED 127.0.0.1:636'))],
    ['erro inesperado', () => Promise.reject(new Error('falha estranha'))],
    ['bind ok, mas sem User cadastrado', () => Promise.resolve()],
  ])('AuthService — %s: o log traz o pseudônimo, nunca o usuário', async (_case, bind) => {
    await expect(authService(bind).login('Rebeca', 'SenhaQualquer#1')).rejects.toThrow();
    noPlainUser();
    expect(JSON.stringify(sent)).toContain(`usuário#${HASH}`);
  });

  it('AuthController — login bloqueado (429): o log comum traz o IP em /24, e o evento também', async () => {
    const controller = new AuthController(authService(() => Promise.reject(new LdapAuthenticationError('Invalid Credentials'))), new LoginRateLimiter());
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': CLIENT_IP } };
    const res = { setHeader: jest.fn() };
    for (let i = 0; i < 6; i++) await controller.login({ username: USER, password: 'x' } as never, req, res).catch(() => undefined);
    noPlainUser();
    const payload = JSON.stringify(sent);
    expect(payload).toContain('Login bloqueado para 203.0.113.0/24');
    expect(sent.filter((e) => e['security.event'] === 'auth.login').every((e) => e['user.name'] === HASH && e['client.ip'] === '203.0.113.0/24')).toBe(true);
  });

  it('InventoryService — consulta que falha: o log traz quem pediu pelo pseudônimo', async () => {
    const lastSync = new Date();
    const prisma = {
      machine: {
        findUnique: jest.fn().mockResolvedValue({ id: 'm-1', hostname: 'ESTACAO-01', lastSync }),
        aggregate: jest.fn().mockResolvedValue({ _max: { lastSync } }),
      },
    };
    const executor = { isInventoryAvailable: true, inventory: jest.fn().mockResolvedValue({ reason: 'unreachable', message: 'sem resposta' }) };
    await expect(new InventoryService(prisma as never, executor as never).collect('m-1', 'u-1', USER)).rejects.toThrow();
    noPlainUser();
    expect(JSON.stringify(sent)).toContain(`por usuário#${HASH}`);
  });
});
