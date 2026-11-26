import { INestApplication, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { LoginRateLimiter } from '../auth/login-rate-limiter';
import { DeploymentsController } from '../deployments/deployments.controller';
import { DeploymentsService } from '../deployments/deployments.service';
import { SoftwareController } from '../software/software.controller';
import { SoftwareService } from '../software/software.service';
import { AppLogger } from './app-logger';
import { NewRelicApi } from './newrelic-loader';
import { Redactor } from './redact';
import { pseudonymizeUser } from './security-events';

/**
 * Eventos de segurança de ponta a ponta: app Nest de verdade, JWT de verdade, requisições HTTP,
 * e o logger do app é o AppLogger com uma API do New Relic falsa — o que ela recebe é exatamente
 * o que iria para o New Relic.
 */

const SECRET = 'segredo-jwt-de-teste-com-mais-de-32-caracteres';
const PASSWORD = 'SenhaDigitadaNoLogin#2026';
const CLIENT = '203.0.113.57';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT_ID = '22222222-2222-4222-8222-222222222222';
const SOFTWARE_ID = '33333333-3333-4333-8333-333333333333';

describe('eventos de segurança pelo HTTP (o que chega ao New Relic)', () => {
  let app: INestApplication;
  let base: string;
  let sent: Record<string, unknown>[];
  const jwt = new JwtService({ secret: SECRET });
  const authLogin = jest.fn();
  const createDeployment = jest.fn();
  const cancelDeployment = jest.fn();
  const createSoftware = jest.fn();
  const envBackup = { ...process.env };

  const security = () => sent.filter((e) => 'security.event' in e);
  const tokenFor = (role: UserRole, options: object = {}) =>
    jwt.signAsync({ sub: USER_ID, username: role === UserRole.VIEWER ? 'leitor' : 'rebeca', role }, options);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': CLIENT, ...headers },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    process.env.LDAP_BIND_DN_TEMPLATE = '{{username}}@rsd-demo.local';
    const api: NewRelicApi = { recordLogEvent: (e) => sent.push(e) };
    const logger = new AppLogger({ newRelic: () => api, redactor: Redactor.fromEnv(process.env) });
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET })],
      controllers: [AuthController, DeploymentsController, SoftwareController],
      providers: [
        LoginRateLimiter,
        { provide: AuthService, useValue: { login: authLogin } },
        { provide: DeploymentsService, useValue: { create: createDeployment, cancel: cancelDeployment } },
        { provide: SoftwareService, useValue: { create: createSoftware, maxInstallerSizeBytes: 1 } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger });
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
    process.env = envBackup;
    jest.restoreAllMocks();
    Logger.overrideLogger(true);
  });
  beforeEach(() => {
    sent = [];
    for (const m of [authLogin, createDeployment, cancelDeployment, createSoftware]) m.mockReset();
    delete process.env.SECURITY_EVENTS_INCLUDE_PII;
  });

  it('login recusado: evento "failure" com usuário e IP real (via Caddy), e a senha em lugar nenhum', async () => {
    authLogin.mockRejectedValue(new UnauthorizedException('Usuário ou senha inválidos.'));
    const res = await post('/auth/login', { username: 'Rebeca', password: PASSWORD }, { 'X-Forwarded-For': '198.51.100.20' });
    expect(res.status).toBe(401);
    expect(security()).toEqual([
      expect.objectContaining({
        'security.event': 'auth.login',
        'security.result': 'failure',
        'user.name': 'rebeca',
        'client.ip': '198.51.100.20',
        'http.status': 401,
        reason: 'rejected',
        level: 'WARN',
        'log.context': 'Security',
      }),
    ]);
    expect(JSON.stringify(sent)).not.toContain(PASSWORD);
  });

  it('senha digitada no campo de usuário: o evento registra "<inválido>", não o texto', async () => {
    authLogin.mockRejectedValue(new UnauthorizedException('Usuário ou senha inválidos.'));
    await post('/auth/login', { username: PASSWORD, password: 'x' }, { 'X-Forwarded-For': '198.51.100.21' });
    expect(security()[0]).toMatchObject({ 'user.name': '<inválido>' });
    expect(JSON.stringify(sent)).not.toContain(PASSWORD);
  });

  it('AD fora do ar: "unavailable" (503); login certo: "success" com o papel', async () => {
    authLogin.mockRejectedValueOnce(new ServiceUnavailableException('Serviço de autenticação indisponível.'));
    authLogin.mockResolvedValueOnce({ accessToken: 'eyJx.eyJy.z', user: { id: USER_ID, username: 'rebeca', displayName: 'R', role: 'ADMIN' } });
    const ip = { 'X-Forwarded-For': '198.51.100.22' };
    expect((await post('/auth/login', { username: 'rebeca', password: PASSWORD }, ip)).status).toBe(503);
    expect((await post('/auth/login', { username: 'rebeca', password: PASSWORD }, ip)).status).toBe(200);
    expect(security().map((e) => [e['security.result'], e['http.status'] ?? null, e['user.role'] ?? null])).toEqual([
      ['unavailable', 503, null],
      ['success', null, 'ADMIN'],
    ]);
    expect(JSON.stringify(sent)).not.toMatch(new RegExp(`${PASSWORD}|eyJx\\.eyJy`));
  });

  it('sexta tentativa do mesmo IP: "rate_limited" (429) com o tempo de espera', async () => {
    authLogin.mockRejectedValue(new UnauthorizedException('Usuário ou senha inválidos.'));
    const ip = { 'X-Forwarded-For': '198.51.100.23' };
    for (let i = 0; i < 5; i++) await post('/auth/login', { username: 'rebeca', password: PASSWORD }, ip);
    const res = await post('/auth/login', { username: 'rebeca', password: PASSWORD }, ip);
    expect(res.status).toBe(429);
    const all = security();
    const last = all[all.length - 1];
    expect(last).toMatchObject({ 'security.result': 'rate_limited', 'http.status': 429, 'client.ip': '198.51.100.23' });
    expect(last.retry_after_s).toEqual(expect.any(Number));
    expect(authLogin).toHaveBeenCalledTimes(5);
  });

  it('token expirado: "expired" com o usuário; adulterado: "invalid" sem usuário; o token nunca aparece', async () => {
    const expired = await tokenFor(UserRole.ADMIN, { expiresIn: -10 });
    const forged = `${(await tokenFor(UserRole.ADMIN)).slice(0, -4)}AAAA`;
    for (const token of [expired, forged]) {
      const res = await post('/deployments', {}, { Authorization: `Bearer ${token}` });
      expect(res.status).toBe(401);
    }
    expect(security()).toEqual([
      expect.objectContaining({ 'security.event': 'auth.token', 'security.result': 'expired', 'user.name': 'rebeca', handler: 'DeploymentsController.create', 'client.ip': CLIENT }),
      expect.objectContaining({ 'security.event': 'auth.token', 'security.result': 'invalid', handler: 'DeploymentsController.create' }),
    ]);
    expect(security()[1]).not.toHaveProperty('user.name');
    const payload = JSON.stringify(sent);
    for (const token of [expired, forged]) for (const part of token.split('.')) expect(payload).not.toContain(part);
  });

  it('VIEWER escrevendo no catálogo: "authz.forbidden" (403) com papel, rota e papéis exigidos', async () => {
    const res = await post('/software', { name: 'X' }, { Authorization: `Bearer ${await tokenFor(UserRole.VIEWER)}` });
    expect(res.status).toBe(403);
    expect(createSoftware).not.toHaveBeenCalled();
    expect(security()).toEqual([
      expect.objectContaining({
        'security.event': 'authz.forbidden',
        'security.result': 'denied',
        'user.name': 'leitor',
        'user.role': 'VIEWER',
        handler: 'SoftwareController.create',
        'http.method': 'POST',
        required_roles: 'ADMIN,OPERATOR',
      }),
    ]);
  });

  it('implantação criada e cancelada: quem, de onde e o que (sem nomes de máquina)', async () => {
    const view = {
      id: DEPLOYMENT_ID,
      action: 'INSTALL',
      software: { id: SOFTWARE_ID, name: '7-Zip', version: '26.06', installType: 'MSI' },
      product: null,
      targets: [{ hostname: 'ESTACAO-01' }, { hostname: 'ESTACAO-02' }],
      counts: { total: 2, pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 2 },
    };
    createDeployment.mockResolvedValue(view);
    cancelDeployment.mockResolvedValue(view);
    const auth = { Authorization: `Bearer ${await tokenFor(UserRole.ADMIN)}` };
    const created = await post('/deployments', { softwareId: SOFTWARE_ID, machineIds: [USER_ID] }, auth);
    expect(created.status).toBe(201);
    expect((await post(`/deployments/${DEPLOYMENT_ID}/cancel`, {}, auth)).status).toBe(200);
    expect(security()).toEqual([
      expect.objectContaining({ 'security.event': 'deployment.created', 'user.name': 'rebeca', 'deployment.id': DEPLOYMENT_ID, 'deployment.machines': 2, 'software.name': '7-Zip 26.06', 'client.ip': CLIENT }),
      expect.objectContaining({ 'security.event': 'deployment.cancelled', 'deployment.cancelled_machines': 2 }),
    ]);
    expect(JSON.stringify(security())).not.toContain('ESTACAO');
  });

  it('SECURITY_EVENTS_INCLUDE_PII=false: usuário vira hash (sal = JWT_SECRET) e IP vira /24', async () => {
    process.env.SECURITY_EVENTS_INCLUDE_PII = 'false';
    authLogin.mockRejectedValue(new UnauthorizedException('Usuário ou senha inválidos.'));
    await post('/auth/login', { username: 'rebeca', password: PASSWORD }, { 'X-Forwarded-For': '198.51.100.24' });
    expect(security()[0]).toMatchObject({ 'user.name': pseudonymizeUser('rebeca', SECRET), 'client.ip': '198.51.100.0/24', 'security.pii': false });
    expect(JSON.stringify(security())).not.toMatch(/"rebeca"|198\.51\.100\.24/);
  });
});
