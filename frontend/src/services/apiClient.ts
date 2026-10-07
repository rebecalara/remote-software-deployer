import { expireSession, getToken } from './session';

const API_URL = import.meta.env.VITE_API_URL ?? '/api';

/** Erro HTTP da API, com a mensagem que o backend devolveu (já em português). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Token ausente, vencido ou recusado pelo backend — a sessão já foi encerrada. */
export class SessionExpiredError extends ApiError {
  constructor() {
    super(401, 'Sua sessão expirou. Entre novamente.');
    this.name = 'SessionExpiredError';
  }
}

export class NetworkError extends Error {
  constructor() {
    super('Não foi possível conectar ao servidor. Tente novamente em instantes.');
    this.name = 'NetworkError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

/**
 * Chamada autenticada à API. Toda rota protegida passa por aqui.
 * (O login é a exceção: lá um 401 significa "senha errada", não "sessão expirou" —
 * por isso ele continua no authService, fora deste cliente.)
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = getToken();
  if (!token) {
    // Sessão já vencida no cliente: nem chega a chamar o backend.
    expireSession();
    throw new SessionExpiredError();
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new NetworkError();
  }

  if (response.status === 401) {
    expireSession();
    throw new SessionExpiredError();
  }

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

// O NestJS devolve { statusCode, message, error }; `message` pode ser string ou lista.
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    if (Array.isArray(body.message)) return body.message.join(' ');
    if (body.message) return body.message;
  } catch {
    // corpo vazio ou não-JSON (ex.: proxy do Vite com backend fora do ar → 502/504)
  }
  if (response.status >= 500) {
    return 'Não foi possível conectar ao servidor. Tente novamente em instantes.';
  }
  return `Erro inesperado (${response.status}).`;
}
