import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginRateLimiter } from './login-rate-limiter';

/**
 * CVE-2026-111181 (body-parser < 2.4.0): um corpo comprimido seguido de bytes extras podia derrubar
 * o processo — o decodificador ficava ligado ao pedido sem tratamento de erro, e os bytes que
 * chegavam depois do fim do quadro viravam uma exceção não tratada. O backend usa o express.json
 * do Nest (inflate ligado) em toda rota JSON, inclusive o login público.
 *
 * Os dois casos rodam contra o app Nest de verdade, pelo socket, sem supertest: o envio em duas
 * partes é o que leva os bytes extras ao decodificador. Em qualquer caso o processo precisa seguir
 * respondendo e nenhuma exceção pode escapar.
 */

const LOGIN_DELAY_MS = 400; // o bind no AD leva tempo: é a janela em que os bytes extras chegam

interface RawResponse {
  status: number;
  ms: number;
}

describe('login com corpo comprimido e bytes sobrando (CVE-2026-111181)', () => {
  let app: INestApplication;
  let port: number;
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  const login = jest.fn(
    () => new Promise((_resolve, reject) => setTimeout(() => reject(new UnauthorizedException('Usuário ou senha inválidos.')), LOGIN_DELAY_MS)),
  );

  beforeAll(async () => {
    process.on('uncaughtException', onUncaught);
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [LoginRateLimiter, { provide: AuthService, useValue: { login } }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as { port: number }).port;
  });
  afterAll(async () => {
    await app.close();
    process.off('uncaughtException', onUncaught);
  });
  beforeEach(() => {
    uncaught.length = 0;
    login.mockClear();
  });

  /** Manda `first`; os `trailing` vão depois de `delayMs`, ainda no mesmo pedido. */
  function send(encoding: string, first: Buffer, trailing: Buffer, delayMs: number, ip: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/auth/login',
          method: 'POST',
          agent: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': encoding,
            'Content-Length': first.length + trailing.length,
            'X-Forwarded-For': ip,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: Date.now() - started }));
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('sem resposta em 5 s')));
      req.write(first);
      setTimeout(() => req.end(trailing), delayMs);
    });
  }

  async function stillAlive(): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.250' },
      body: JSON.stringify({ username: 'rebeca', password: 'x' }),
    });
    return res.status;
  }

  const json = Buffer.from(JSON.stringify({ username: 'rebeca', password: 'SenhaDeTeste#1' }));

  it('gzip com bytes sobrando no mesmo envio: 400 rápido, sem chegar ao login, e o processo segue', async () => {
    const body = Buffer.concat([zlib.gzipSync(json), Buffer.alloc(5 * 1024 * 1024, 0x41)]);
    const res = await send('gzip', body, Buffer.alloc(0), 0, '198.51.100.1');
    expect(res.status).toBe(400);
    expect(res.ms).toBeLessThan(2000);
    expect(login).not.toHaveBeenCalled();
    expect(await stillAlive()).toBe(401);
    expect(uncaught).toEqual([]);
  });

  it.each([
    ['deflate', () => Buffer.concat([zlib.deflateSync(json), Buffer.from([0x00])])],
    ['gzip', () => zlib.gzipSync(json)],
    ['br', () => zlib.brotliCompressSync(json)],
  ])('%s válido e os bytes extras chegando DURANTE o login (como no teste oficial): resposta normal e o processo segue', async (encoding, frame) => {
    const res = await send(encoding, frame(), Buffer.alloc(1024), LOGIN_DELAY_MS / 4, `198.51.100.${encoding.length + 10}`);
    expect([400, 401]).toContain(res.status); // 401: o corpo foi lido e o login recusou; 400: o parser recusou os bytes extras
    expect(res.ms).toBeLessThan(LOGIN_DELAY_MS + 2000);
    // Os bytes extras já chegaram e a resposta saiu: o processo precisa continuar de pé.
    await new Promise((r) => setTimeout(r, 200));
    expect(await stillAlive()).toBe(401);
    expect(uncaught).toEqual([]);
  });
});
