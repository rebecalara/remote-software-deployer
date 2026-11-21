import type { LoginResponse } from '../types/auth';

const API_URL = import.meta.env.VITE_API_URL ?? '/api';

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Usuário ou senha inválidos.');
    this.name = 'InvalidCredentialsError';
  }
}

export class ServerUnavailableError extends Error {
  constructor() {
    super('Não foi possível conectar ao servidor. Tente novamente em instantes.');
    this.name = 'ServerUnavailableError';
  }
}

/** 429: limite de tentativas de login atingido. A mensagem vem do servidor (com o tempo de espera). */
export class TooManyAttemptsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooManyAttemptsError';
  }
}

/** 503: o AD não respondeu. A tentativa não conta no limite de tentativas. */
export class AuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthUnavailableError';
  }
}

const TOO_MANY_ATTEMPTS_FALLBACK = 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.';
const AUTH_UNAVAILABLE_FALLBACK = 'Serviço de autenticação indisponível. Tente novamente em instantes.';

/** Mensagem do corpo de erro do backend ({ message }), ou o texto padrão. */
async function serverMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
  } catch {
    // corpo vazio ou fora do formato: fica a mensagem padrão
  }
  return fallback;
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new ServerUnavailableError();
  }

  if (response.status === 429) {
    throw new TooManyAttemptsError(await serverMessage(response, TOO_MANY_ATTEMPTS_FALLBACK));
  }
  if (response.status === 503) {
    throw new AuthUnavailableError(await serverMessage(response, AUTH_UNAVAILABLE_FALLBACK));
  }
  if (response.status === 400 || response.status === 401) {
    throw new InvalidCredentialsError();
  }
  if (!response.ok) {
    throw new ServerUnavailableError();
  }

  return (await response.json()) as LoginResponse;
}
