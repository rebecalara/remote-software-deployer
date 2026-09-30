import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { AuthenticatedRequest, JwtAuthGuard } from './jwt-auth.guard';
import { JwtPayload } from './auth.types';

function contextFor(request: AuthenticatedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  const payload: JwtPayload = { sub: 'user-1', username: 'lrebeca', role: UserRole.OPERATOR };
  let jwtService: { verifyAsync: jest.Mock };
  let guard: JwtAuthGuard;

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
    guard = new JwtAuthGuard(jwtService as unknown as JwtService);
  });

  it('libera e preenche request.user com token válido', async () => {
    jwtService.verifyAsync.mockResolvedValue(payload);
    const request: AuthenticatedRequest = { headers: { authorization: 'Bearer token-valido' } };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(jwtService.verifyAsync).toHaveBeenCalledWith('token-valido');
    expect(request.user).toEqual(payload);
  });

  it('rejeita quando não há header Authorization', async () => {
    await expect(guard.canActivate(contextFor({ headers: {} }))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
  });

  it('rejeita esquema diferente de Bearer', async () => {
    const request = { headers: { authorization: 'Basic dXNlcjpzZW5oYQ==' } };
    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
    expect(jwtService.verifyAsync).not.toHaveBeenCalled();
  });

  it('rejeita "Bearer" sem token', async () => {
    const request = { headers: { authorization: 'Bearer' } };
    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
  });

  it('rejeita token com assinatura inválida ou expirado', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));
    const request: AuthenticatedRequest = { headers: { authorization: 'Bearer token-vencido' } };

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });
});
