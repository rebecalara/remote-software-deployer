import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { RolesGuard } from './roles.guard';
import { AuthenticatedRequest } from './jwt-auth.guard';

function contextFor(request: AuthenticatedRequest): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function requestAs(role: UserRole): AuthenticatedRequest {
  return { headers: {}, user: { sub: 'user-1', username: 'lrebeca', role } };
}

describe('RolesGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('libera qualquer usuário quando a rota não declara @Roles', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(contextFor(requestAs(UserRole.VIEWER)))).toBe(true);
  });

  it('libera quando o role do usuário está entre os exigidos', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.ADMIN, UserRole.OPERATOR]);
    expect(guard.canActivate(contextFor(requestAs(UserRole.OPERATOR)))).toBe(true);
  });

  it('bloqueia com 403 quando o role não está entre os exigidos', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.ADMIN, UserRole.OPERATOR]);
    expect(() => guard.canActivate(contextFor(requestAs(UserRole.VIEWER)))).toThrow(
      ForbiddenException,
    );
  });

  it('bloqueia quando não há usuário na request (JwtAuthGuard não rodou antes)', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.ADMIN]);
    expect(() => guard.canActivate(contextFor({ headers: {} }))).toThrow(ForbiddenException);
  });
});
