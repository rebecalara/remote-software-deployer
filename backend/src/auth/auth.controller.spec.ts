import { BadRequestException, HttpException, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { LoginRateLimiter } from './login-rate-limiter';

const OK = { accessToken: 't', user: { id: 'u', username: 'testuser', displayName: null, role: 'ADMIN' } };

function setup() {
  const authService = { login: jest.fn() };
  const limiter = new LoginRateLimiter();
  const controller = new AuthController(authService as never, limiter);
  const req = (remote: string, xff?: string) =>
    ({ socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as never;
  const res = () => ({ setHeader: jest.fn() });
  return { authService, controller, req, res };
}

const body = { username: 'testuser', password: 'errada' };

describe('AuthController — limite de tentativas de login', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

  it('a sexta tentativa errada do mesmo IP em 15 min recebe 429, sem chegar ao LDAP', async () => {
    const { authService, controller, req, res } = setup();
    authService.login.mockRejectedValue(new UnauthorizedException('Usuário ou senha inválidos.'));
    for (let i = 0; i < 5; i++) {
      await expect(controller.login(body, req('198.51.100.9'), res() as never)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    const r = res();
    const err = await controller.login(body, req('198.51.100.9'), r as never).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse()).toMatchObject({
      statusCode: 429,
      message: 'Muitas tentativas de login a partir deste endereço. Tente novamente em 15 minutos.',
    });
    expect(r.setHeader).toHaveBeenCalledWith('Retry-After', '900');
    expect(authService.login).toHaveBeenCalledTimes(5);
  });

  it('bloqueado, nem a senha certa entra até liberar', async () => {
    const { authService, controller, req, res } = setup();
    authService.login.mockRejectedValue(new UnauthorizedException());
    for (let i = 0; i < 5; i++) await controller.login(body, req('198.51.100.9'), res() as never).catch(() => null);
    authService.login.mockResolvedValue(OK);
    await expect(controller.login(body, req('198.51.100.9'), res() as never)).rejects.toMatchObject({ status: 429 });
  });

  it('login com sucesso não conta', async () => {
    const { authService, controller, req, res } = setup();
    authService.login.mockResolvedValue(OK);
    for (let i = 0; i < 10; i++) {
      await expect(controller.login(body, req('198.51.100.9'), res() as never)).resolves.toBe(OK);
    }
  });

  it('AD indisponível (503) não conta como tentativa', async () => {
    const { authService, controller, req, res } = setup();
    authService.login.mockRejectedValue(new ServiceUnavailableException('Serviço de autenticação indisponível.'));
    for (let i = 0; i < 10; i++) {
      await expect(controller.login(body, req('198.51.100.9'), res() as never)).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    // Com o AD de volta, as 5 tentativas continuam disponíveis.
    authService.login.mockRejectedValue(new UnauthorizedException());
    for (let i = 0; i < 5; i++) {
      await expect(controller.login(body, req('198.51.100.9'), res() as never)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(controller.login(body, req('198.51.100.9'), res() as never)).rejects.toMatchObject({ status: 429 });
  });

  it('503 no meio de falhas não apaga as falhas que já contaram', async () => {
    const { authService, controller, req, res } = setup();
    authService.login.mockRejectedValue(new UnauthorizedException());
    for (let i = 0; i < 4; i++) await controller.login(body, req('198.51.100.9'), res() as never).catch(() => null);
    authService.login.mockRejectedValueOnce(new ServiceUnavailableException());
    await controller.login(body, req('198.51.100.9'), res() as never).catch(() => null);
    await expect(controller.login(body, req('198.51.100.9'), res() as never)).rejects.toBeInstanceOf(UnauthorizedException); // 5ª
    await expect(controller.login(body, req('198.51.100.9'), res() as never)).rejects.toMatchObject({ status: 429 });
  });

  it('erro de entrada (400) também conta: toda tentativa que não entra conta', async () => {
    const { authService, controller, req, res } = setup();
    authService.login.mockRejectedValue(new BadRequestException());
    for (let i = 0; i < 5; i++) await controller.login(body, req('198.51.100.9'), res() as never).catch(() => null);
    await expect(controller.login(body, req('198.51.100.9'), res() as never)).rejects.toMatchObject({ status: 429 });
  });

  it('atrás do Caddy (127.0.0.1): conta pelo IP do X-Forwarded-For, cada cliente separado', async () => {
    const { authService, controller, req, res } = setup();
    authService.login.mockRejectedValue(new UnauthorizedException());
    for (let i = 0; i < 5; i++) await controller.login(body, req('127.0.0.1', '203.0.113.7'), res() as never).catch(() => null);
    await expect(controller.login(body, req('127.0.0.1', '203.0.113.7'), res() as never)).rejects.toMatchObject({ status: 429 });
    // Outro cliente atrás do mesmo Caddy continua livre.
    await expect(controller.login(body, req('127.0.0.1', '203.0.113.8'), res() as never)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fora do Caddy, trocar o X-Forwarded-For não escapa do limite', async () => {
    const { authService, controller, req, res } = setup();
    authService.login.mockRejectedValue(new UnauthorizedException());
    for (let i = 0; i < 5; i++) await controller.login(body, req('198.51.100.9', `10.0.0.${i}`), res() as never).catch(() => null);
    await expect(controller.login(body, req('198.51.100.9', '10.0.0.99'), res() as never)).rejects.toMatchObject({ status: 429 });
  });

  it('mensagem no singular perto de liberar', async () => {
    const { authService, controller, req, res } = setup();
    authService.login.mockRejectedValue(new UnauthorizedException());
    const realNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;
      for (let i = 0; i < 5; i++) await controller.login(body, req('198.51.100.9'), res() as never).catch(() => null);
      now += 14 * 60_000 + 30_000;
      const err = await controller.login(body, req('198.51.100.9'), res() as never).catch((e) => e);
      expect(err.getResponse().message).toBe('Muitas tentativas de login a partir deste endereço. Tente novamente em 1 minuto.');
    } finally {
      Date.now = realNow;
    }
  });
});
