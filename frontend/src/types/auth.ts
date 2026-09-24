// Espelha backend/src/auth/auth.types.ts — manter os dois em sincronia.

export type UserRole = 'ADMIN' | 'OPERATOR' | 'VIEWER';

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

export interface LoginResponse {
  accessToken: string;
  user: AuthenticatedUser;
}
