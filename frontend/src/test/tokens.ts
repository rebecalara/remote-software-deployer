import type { AuthenticatedUser } from '../types/auth';

/** JWT de teste (assinatura falsa: o frontend só lê o `exp`; quem valida é o backend). */
export function fakeToken(expSecondsFromNow: number): string {
  const b64url = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.assinatura`;
}

export const TEST_USER: AuthenticatedUser = { id: 'u1', username: 'testuser', displayName: 'Test User', role: 'ADMIN' };

/** Grava uma sessão válida, como o login faria. */
export function storeSession(expSecondsFromNow = 3600, user: AuthenticatedUser = TEST_USER): string {
  const token = fakeToken(expSecondsFromNow);
  sessionStorage.setItem('rsd.auth', JSON.stringify({ token, user }));
  return token;
}
