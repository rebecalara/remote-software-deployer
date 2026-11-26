import type { JwtModuleOptions } from '@nestjs/jwt';

// Segredo do JWT: obrigatório e forte (o backend não sobe sem ele), e algoritmo fixo em
// HS256 na assinatura E na verificação — um token com outro algoritmo (HS512, "none") é
// recusado mesmo que a assinatura bata.

export const MIN_JWT_SECRET_LENGTH = 32;
export const JWT_ALGORITHM = 'HS256' as const;
const GENERATE_HINT =
  `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`;

export function buildJwtModuleOptions(env: { JWT_SECRET?: string; JWT_EXPIRES_IN?: string }): JwtModuleOptions {
  const secret = env.JWT_SECRET ?? '';
  if (secret.trim().length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET ausente ou fraco: precisa de pelo menos ${MIN_JWT_SECRET_LENGTH} caracteres. ` +
        `Gere um com: ${GENERATE_HINT}`,
    );
  }
  return {
    secret,
    signOptions: {
      algorithm: JWT_ALGORITHM,
      expiresIn: (env.JWT_EXPIRES_IN || '8h') as NonNullable<JwtModuleOptions['signOptions']>['expiresIn'],
    },
    verifyOptions: { algorithms: [JWT_ALGORITHM] },
  };
}
