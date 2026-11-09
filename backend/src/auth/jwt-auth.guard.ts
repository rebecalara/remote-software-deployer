import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from './auth.types';

// Só o que os guards usam da request do Express (sem depender de @types/express).
export interface AuthenticatedRequest {
  headers: { authorization?: string };
  user?: JwtPayload;
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
    } catch {
      throw new UnauthorizedException('Token de acesso inválido ou expirado.');
    }
    return true;
  }

  private extractBearerToken(request: AuthenticatedRequest): string | undefined {
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    return scheme === 'Bearer' && token ? token : undefined;
  }
}
