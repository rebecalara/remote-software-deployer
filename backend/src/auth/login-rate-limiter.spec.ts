import { LOGIN_MAX_ATTEMPTS, LOGIN_SWEEP_EVERY, LOGIN_WINDOW_MS, LoginRateLimiter } from './login-rate-limiter';

const MIN = 60_000;

describe('LoginRateLimiter', () => {
  it('5 tentativas em 15 minutos', () => {
    expect(LOGIN_MAX_ATTEMPTS).toBe(5);
    expect(LOGIN_WINDOW_MS).toBe(15 * MIN);
  });

  it('libera 5 tentativas e bloqueia a sexta, com o tempo até liberar', () => {
    const limiter = new LoginRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire('203.0.113.7', t0 + i * MIN).allowed).toBe(true);
    }
    const blocked = limiter.tryAcquire('203.0.113.7', t0 + 5 * MIN);
    expect(blocked).toEqual({ allowed: false, retryAfterSeconds: 10 * 60 });
  });

  it('janela deslizante: libera de novo quando a tentativa mais antiga passa dos 15 minutos', () => {
    const limiter = new LoginRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.tryAcquire('ip', t0 + i * MIN);
    expect(limiter.tryAcquire('ip', t0 + 15 * MIN - 1).allowed).toBe(false);
    expect(limiter.tryAcquire('ip', t0 + 15 * MIN).allowed).toBe(true);
    // A nova tentativa ocupou a vaga liberada: a próxima volta a ser bloqueada.
    expect(limiter.tryAcquire('ip', t0 + 15 * MIN).allowed).toBe(false);
  });

  it('tentativa bloqueada não conta (não empurra o fim do bloqueio)', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 5; i++) limiter.tryAcquire('ip', 0);
    for (let i = 0; i < 50; i++) limiter.tryAcquire('ip', 14 * MIN);
    expect(limiter.tryAcquire('ip', 15 * MIN).allowed).toBe(true);
  });

  it('retryAfterSeconds arredonda para cima e é no mínimo 1', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 5; i++) limiter.tryAcquire('ip', 0);
    expect(limiter.tryAcquire('ip', 15 * MIN - 1)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.tryAcquire('ip', 15 * MIN - 1500)).toEqual({ allowed: false, retryAfterSeconds: 2 });
  });

  it('login com sucesso não conta: release() devolve a vaga', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 20; i++) {
      const attempt = limiter.tryAcquire('ip', i);
      expect(attempt.allowed).toBe(true);
      if ('release' in attempt) attempt.release();
    }
  });

  it('sucesso não apaga as falhas anteriores (uma conta válida não "zera" o contador do atacante)', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 4; i++) limiter.tryAcquire('ip', 0);
    const ok = limiter.tryAcquire('ip', 0);
    if ('release' in ok) ok.release();
    expect(limiter.tryAcquire('ip', 0).allowed).toBe(true); // 5ª falha
    expect(limiter.tryAcquire('ip', 0).allowed).toBe(false);
  });

  it('release() duas vezes não devolve vaga a mais', () => {
    const limiter = new LoginRateLimiter();
    const first = limiter.tryAcquire('ip', 0);
    for (let i = 0; i < 4; i++) limiter.tryAcquire('ip', 0);
    if ('release' in first) {
      first.release();
      first.release();
    }
    expect(limiter.tryAcquire('ip', 0).allowed).toBe(true);
    expect(limiter.tryAcquire('ip', 0).allowed).toBe(false);
  });

  it('tentativas simultâneas contam na hora (a vaga é reservada antes do LDAP responder)', () => {
    const limiter = new LoginRateLimiter();
    const results = Array.from({ length: 8 }, () => limiter.tryAcquire('ip', 0).allowed);
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it('cada IP tem a própria contagem', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 5; i++) limiter.tryAcquire('a', 0);
    expect(limiter.tryAcquire('a', 0).allowed).toBe(false);
    expect(limiter.tryAcquire('b', 0).allowed).toBe(true);
  });

  it('a limpeza roda sozinha: com muitos IPs diferentes, os vencidos são apagados sem chamar sweep()', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 10_000; i++) limiter.tryAcquire(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, 0);
    expect(limiter.size).toBe(10_000);
    // Depois da janela, novos IPs chegando: a cada SWEEP_EVERY chamadas os vencidos saem.
    for (let i = 0; i < LOGIN_SWEEP_EVERY; i++) limiter.tryAcquire(`172.16.${(i >> 8) & 255}.${i & 255}`, 15 * MIN);
    expect(limiter.size).toBeLessThanOrEqual(LOGIN_SWEEP_EVERY);
    expect(limiter.size).toBeGreaterThan(0);
  });

  it('memória limitada: o número de IPs guardados nunca passa da janela atual + SWEEP_EVERY', () => {
    const limiter = new LoginRateLimiter();
    let max = 0;
    // 30 mil IPs diferentes, um por segundo de relógio simulado (cada um vence em 15 min = 900 s).
    for (let i = 0; i < 30_000; i++) {
      limiter.tryAcquire(`ip-${i}`, i * 1000);
      max = Math.max(max, limiter.size);
    }
    expect(max).toBeLessThanOrEqual(900 + LOGIN_SWEEP_EVERY);
  });

  it('esquece IPs sem tentativa na janela (a memória não cresce para sempre)', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 1000; i++) limiter.tryAcquire(`10.0.${Math.floor(i / 250)}.${i % 250}`, 0);
    expect(limiter.size).toBe(1000);
    limiter.tryAcquire('outro', 15 * MIN);
    limiter.sweep(15 * MIN);
    expect(limiter.size).toBe(1);
  });
});
