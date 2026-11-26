import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginRequestBody, LoginResponse } from './auth.types';
import { resolveClientIp } from './client-ip';
import { LoginRateLimiter } from './login-rate-limiter';

/** O mínimo da requisição do Express que o login usa. */
interface LoginRequest {
  socket: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}

/** O mínimo da resposta do Express que o login usa. */
interface LoginResponseWriter {
  setHeader(name: string, value: string): void;
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly limiter: LoginRateLimiter,
  ) {}

  /**
   * Limite por IP: no máximo 5 tentativas em 15 minutos. Não contam o login com sucesso
   * nem o AD indisponível (503). A sexta responde 429 sem consultar o LDAP — nem a senha
   * certa entra até liberar.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginRequestBody,
    @Req() req: LoginRequest,
    @Res({ passthrough: true }) res: LoginResponseWriter,
  ): Promise<LoginResponse> {
    const ip = resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for']);
    const attempt = this.limiter.tryAcquire(ip);
    if ('retryAfterSeconds' in attempt) {
      this.logger.warn(`Login bloqueado para ${ip}: limite de tentativas atingido.`);
      res.setHeader('Retry-After', String(attempt.retryAfterSeconds));
      const minutes = Math.ceil(attempt.retryAfterSeconds / 60);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: `Muitas tentativas de login a partir deste endereço. Tente novamente em ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      const result = await this.authService.login(body?.username, body?.password);
      attempt.release();
      return result;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) attempt.release();
      throw err;
    }
  }
}
