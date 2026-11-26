import { Global, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from './auth.module';
import { JWT_ALGORITHM, MIN_JWT_SECRET_LENGTH, buildJwtModuleOptions } from './jwt.config';

// JWT_SECRET forte obrigatório e algoritmo fixo (HS256) na assinatura e na verificação.

const STRONG = 'x'.repeat(MIN_JWT_SECRET_LENGTH);

/** Token montado à mão (para testar algoritmos que a biblioteca não deveria aceitar). */
function handMadeToken(header: object, payload: object, secret: string | null, alg = 'sha512'): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64(header)}.${b64(payload)}`;
  const sig = secret === null ? '' : createHmac(alg, secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

describe('buildJwtModuleOptions', () => {
  it('mínimo de 32 caracteres e algoritmo HS256', () => {
    expect(MIN_JWT_SECRET_LENGTH).toBe(32);
    expect(JWT_ALGORITHM).toBe('HS256');
  });

  it.each([
    ['ausente', undefined],
    ['vazio', ''],
    ['só espaços', ' '.repeat(40)],
    ['31 caracteres', 'x'.repeat(31)],
  ])('recusa JWT_SECRET %s, com uma mensagem que diz como gerar um', (_label, secret) => {
    expect(() => buildJwtModuleOptions({ JWT_SECRET: secret })).toThrow(/JWT_SECRET.*32 caracteres.*randomBytes/s);
  });

  it('aceita 32 caracteres ou mais, e fixa HS256 na assinatura e na verificação', () => {
    const options = buildJwtModuleOptions({ JWT_SECRET: STRONG, JWT_EXPIRES_IN: '2h' });
    expect(options.secret).toBe(STRONG);
    expect(options.signOptions).toMatchObject({ algorithm: 'HS256', expiresIn: '2h' });
    expect(options.verifyOptions).toEqual({ algorithms: ['HS256'] });
  });

  it('JWT_EXPIRES_IN ausente: 8 h', () => {
    expect(buildJwtModuleOptions({ JWT_SECRET: STRONG }).signOptions).toMatchObject({ expiresIn: '8h' });
  });
});

describe('JwtService com as opções do sistema', () => {
  const service = new JwtService(buildJwtModuleOptions({ JWT_SECRET: STRONG }));

  it('assina em HS256 e aceita o próprio token', async () => {
    const token = await service.signAsync({ sub: 'u1' });
    expect(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())).toMatchObject({ alg: 'HS256' });
    await expect(service.verifyAsync(token)).resolves.toMatchObject({ sub: 'u1' });
  });

  it('recusa token com o MESMO segredo em outro algoritmo (HS512)', async () => {
    const token = handMadeToken({ alg: 'HS512', typ: 'JWT' }, { sub: 'u1' }, STRONG, 'sha512');
    await expect(service.verifyAsync(token)).rejects.toThrow();
  });

  it('recusa token sem assinatura (alg "none")', async () => {
    const token = handMadeToken({ alg: 'none', typ: 'JWT' }, { sub: 'u1' }, null);
    await expect(service.verifyAsync(token)).rejects.toThrow();
  });

  it('recusa token assinado com outro segredo', async () => {
    const other = new JwtService(buildJwtModuleOptions({ JWT_SECRET: 'y'.repeat(40) }));
    await expect(service.verifyAsync(await other.signAsync({ sub: 'u1' }))).rejects.toThrow();
  });
});

describe('AuthModule na subida', () => {
  const ORIGINAL = process.env.JWT_SECRET;
  afterEach(() => {
    process.env.JWT_SECRET = ORIGINAL;
  });

  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: {} }], exports: [PrismaService] })
  class FakePrismaModule {}

  it('não sobe com JWT_SECRET fraco', async () => {
    process.env.JWT_SECRET = 'curto-demais';
    await expect(Test.createTestingModule({ imports: [FakePrismaModule, AuthModule] }).compile()).rejects.toThrow(/JWT_SECRET/);
  });

  it('sobe com JWT_SECRET forte, e o JwtService do módulo usa HS256', async () => {
    process.env.JWT_SECRET = STRONG;
    const moduleRef = await Test.createTestingModule({ imports: [FakePrismaModule, AuthModule] }).compile();
    const token = await moduleRef.get(JwtService).signAsync({ sub: 'u1' });
    expect(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).alg).toBe('HS256');
    const hs512 = handMadeToken({ alg: 'HS512', typ: 'JWT' }, { sub: 'u1' }, STRONG, 'sha512');
    await expect(moduleRef.get(JwtService).verifyAsync(hs512)).rejects.toThrow();
  });
});
