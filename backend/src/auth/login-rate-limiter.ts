import { Injectable } from '@nestjs/common';

// Limite de tentativas de login por IP (DECISIONS.md): no máximo 5 em 15 minutos, janela
// deslizante. Protege contra força bruta e contra o bloqueio das contas no AD (cada bind
// errado conta para a política de bloqueio do domínio).
//
// A vaga é reservada ANTES de consultar o LDAP — tentativas simultâneas não passam do
// limite — e devolvida se o login der certo ou se o AD estiver indisponível: nesses dois
// casos a tentativa não conta. Sucesso não apaga as falhas anteriores (quem tem uma
// conta válida não "zera" o contador para tentar outras).
// Tentativa bloqueada não conta (não empurra o fim do bloqueio).
//
// Em memória, por processo: zera no restart, e com mais de uma instância cada uma conta
// por conta própria (mesma limitação da fila de implantações).

export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60_000;
/**
 * A cada quantas chamadas os IPs sem tentativa na janela são esquecidos. Com isso, o mapa
 * guarda no máximo os IPs que tentaram nos últimos 15 minutos mais SWEEP_EVERY vencidos.
 */
export const LOGIN_SWEEP_EVERY = 500;

export type LoginAttempt =
  | { allowed: true; release: () => void }
  | { allowed: false; retryAfterSeconds: number };

interface Bucket {
  /** Uma entrada por tentativa (objeto, para o release() tirar exatamente a sua). */
  attempts: Array<{ at: number }>;
}

@Injectable()
export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private calls = 0;

  tryAcquire(ip: string, now: number = Date.now()): LoginAttempt {
    if (++this.calls % LOGIN_SWEEP_EVERY === 0) this.sweep(now);

    const bucket = this.buckets.get(ip) ?? { attempts: [] };
    bucket.attempts = bucket.attempts.filter((a) => now - a.at < LOGIN_WINDOW_MS);

    if (bucket.attempts.length >= LOGIN_MAX_ATTEMPTS) {
      this.buckets.set(ip, bucket);
      const oldest = Math.min(...bucket.attempts.map((a) => a.at));
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + LOGIN_WINDOW_MS - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    }

    const attempt = { at: now };
    bucket.attempts.push(attempt);
    this.buckets.set(ip, bucket);
    return {
      allowed: true,
      release: () => {
        const index = bucket.attempts.indexOf(attempt);
        if (index >= 0) bucket.attempts.splice(index, 1);
      },
    };
  }

  /** Esquece os IPs sem tentativa dentro da janela. */
  sweep(now: number = Date.now()): void {
    for (const [ip, bucket] of this.buckets) {
      if (!bucket.attempts.some((a) => now - a.at < LOGIN_WINDOW_MS)) this.buckets.delete(ip);
    }
  }

  /** IPs guardados (para teste). */
  get size(): number {
    return this.buckets.size;
  }
}
