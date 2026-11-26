import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from './auth.types';
import { recordSecurityEvent, requestIp } from '../observability/security-events';

// Só o que os guards usam da request do Express (sem depender de @types/express).
export interface AuthenticatedRequest {
  headers: { authorization?: string; 'x-forwarded-for'?: string | string[] };
  socket?: { remoteAddress?: string };
  method?: string;
  user?: JwtPayload;
}

/** "DeploymentsController.create": identifica a rota sem a URL (que pode ter filtros). */
export function handlerName(context: ExecutionContext): string {
  // Defensivo: o evento de segurança nunca pode trocar o 401/403 por um erro 500.
  try {
    return `${context.getClass?.()?.name ?? '?'}.${context.getHandler?.()?.name ?? '?'}`;
  } catch {
    return '?';
  }
}

// Guard próprio, sem Passport — ver DECISIONS.md ("JWT guard: primeira proteção de rota").
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Token de acesso ausente.');
    }

    try {
      request.user = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch (err) {
      this.recordRejectedToken(context, request, token, err);
      throw new UnauthorizedException('Token de acesso inválido ou expirado.');
    }
    return true;
  }

  /**
   * Evento de segurança do 401: "expired" ou "invalid", nunca com o token nem parte dele.
   * Expirado: a assinatura já foi conferida antes do prazo (jsonwebtoken), então o usuário dentro
   * do token é confiável. Inválido: nenhum dado do token entra no evento.
   */
  private recordRejectedToken(context: ExecutionContext, request: AuthenticatedRequest, token: string, err: unknown): void {
    recordSecurityEvent(() => {
      const expired = (err as { name?: string } | null)?.name === 'TokenExpiredError';
      const payload = expired ? this.jwtService.decode<Partial<JwtPayload> | null>(token) : null;
      return {
        event: 'auth.token',
        result: expired ? 'expired' : 'invalid',
        user: typeof payload?.username === 'string' ? payload.username : null,
        ip: requestIp(request),
        details: { 'http.status': 401, 'http.method': request.method, handler: handlerName(context) },
      };
    });
  }

  private extractBearerToken(request: AuthenticatedRequest): string | undefined {
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    return scheme === 'Bearer' && token ? token : undefined;
  }
}
