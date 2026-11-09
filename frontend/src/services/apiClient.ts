import { expireSession, getToken } from './session';

const API_URL = import.meta.env.VITE_API_URL ?? '/api';

/** Erro HTTP da API, com a mensagem que o backend devolveu (já em português). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Campo com problema, quando o backend informa (ex.: "installArgs[2]" num 400). */
    readonly field?: string,
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

/** Envio cancelado por quem chamou (AbortSignal) — não é erro do servidor nem da rede. */
export class UploadCancelledError extends Error {
  constructor() {
    super('Envio cancelado.');
    this.name = 'UploadCancelledError';
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
    const { message, field } = parseErrorBody(await response.text().catch(() => ''), response.status);
    throw new ApiError(response.status, message, field);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/**
 * Lê o corpo de erro do NestJS ({ statusCode, message, error, field? }) — usado pelo
 * apiFetch e pelo apiUpload. `message` pode ser string ou lista; `field` vem nos 400
 * de validação do catálogo (ex.: "installArgs[2]").
 */
function parseErrorBody(text: string, status: number): { message: string; field?: string } {
  try {
    const body = JSON.parse(text) as { message?: string | string[]; field?: unknown };
    const field = typeof body.field === 'string' ? body.field : undefined;
    if (Array.isArray(body.message)) return { message: body.message.join(' '), field };
    if (body.message) return { message: body.message, field };
  } catch {
    // corpo vazio ou não-JSON (ex.: proxy do Vite com backend fora do ar → 502/504)
  }
  if (status >= 500) {
    return { message: 'Não foi possível conectar ao servidor. Tente novamente em instantes.' };
  }
  return { message: `Erro inesperado (${status}).` };
}

export interface UploadProgress {
  loaded: number;
  total: number;
  /** 0–100, inteiro. */
  percent: number;
}

export interface UploadOptions {
  /** Nome original exibido no catálogo. Padrão: o nome do File. */
  fileName?: string;
  onProgress?: (progress: UploadProgress) => void;
  /** Para o botão "Cancelar": aborta o envio (o servidor apaga o arquivo parcial). */
  signal?: AbortSignal;
}

/**
 * Envio de arquivo autenticado, ao lado do apiFetch (que continua igual): corpo
 * binário (application/octet-stream) e nome original em X-File-Name. Usa
 * XMLHttpRequest porque o fetch não informa o progresso do ENVIO.
 *
 * Mesmas regras do apiFetch: 401 encerra a sessão; erro da API chega com a
 * mensagem do backend; falha de rede vira NetworkError.
 */
export function apiUpload<T>(path: string, file: Blob, options: UploadOptions = {}): Promise<T> {
  const token = getToken();
  if (!token) {
    expireSession();
    return Promise.reject(new SessionExpiredError());
  }
  if (options.signal?.aborted) return Promise.reject(new UploadCancelledError());

  const fileName = options.fileName ?? (file instanceof File ? file.name : 'instalador');

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API_URL}${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    // Cabeçalho HTTP não carrega acento com segurança: o backend decodifica.
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(fileName));

    xhr.upload.onprogress = (event) => {
      if (!options.onProgress || !event.lengthComputable) return;
      options.onProgress({
        loaded: event.loaded,
        total: event.total,
        percent: Math.min(100, Math.floor((event.loaded / event.total) * 100)),
      });
    };

    const onAbort = () => xhr.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => options.signal?.removeEventListener('abort', onAbort);

    xhr.onload = () => {
      done();
      if (xhr.status === 401) {
        expireSession();
        reject(new SessionExpiredError());
      } else if (xhr.status >= 200 && xhr.status < 300) {
        resolve((xhr.responseText ? JSON.parse(xhr.responseText) : undefined) as T);
      } else {
        const { message, field } = parseErrorBody(xhr.responseText, xhr.status);
        reject(new ApiError(xhr.status, message, field));
      }
    };
    xhr.onerror = () => {
      done();
      reject(new NetworkError());
    };
    xhr.onabort = () => {
      done();
      reject(new UploadCancelledError());
    };

    // O navegador define o Content-Length a partir do Blob — o backend recusa
    // pelo tamanho antes de gravar qualquer coisa.
    xhr.send(file);
  });
}
