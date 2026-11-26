import { UserRole } from '@prisma/client';

export interface LoginRequestBody {
  username: string;
  password: string;
}

export interface AuthenticatedUserPayload {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

export interface JwtPayload {
  sub: string;
  username: string;
  role: UserRole;
}

export interface LoginResponse {
  accessToken: string;
  user: AuthenticatedUserPayload;
}
