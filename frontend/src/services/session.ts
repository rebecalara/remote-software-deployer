import type { AuthenticatedUser, UserRole } from '../types/auth';

// sessionStorage: sobrevive ao F5, some ao fechar a aba (decisão registrada em DECISIONS.md).
// Único lugar que lê/escreve a sessão — usado pelo AuthContext (React) e pelo
// apiClient (fora do React), para os dois nunca divergirem.
const STORAGE_KEY = 'rsd.auth';

export interface StoredSession {
  token: string;
  user: AuthenticatedUser;
}

type ExpiredListener = () => void;
const expiredListeners = new Set<ExpiredListener>();

// Lê só o `exp` do payload para descartar token vencido no cliente.
// Não verifica assinatura — quem valida o token de verdade é o backend.
export function isTokenExpired(token: string): boolean {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const { exp } = JSON.parse(json) as { exp?: number };
    return typeof exp === 'number' && exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}

/** JWT: três partes base64url, nenhuma vazia (cabeçalho.payload.assinatura). */
const JWT_FORMAT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const ROLES: readonly UserRole[] = ['ADMIN', 'OPERATOR', 'VIEWER'];

/**
 * Sessão no formato esperado, ou null. Vale para o que vem do navegador (sessionStorage pode
 * ter sido alterado por qualquer script da página) e para a resposta do login antes de gravar.
 * Devolve um objeto NOVO só com os campos conhecidos: nada a mais é lido nem guardado.
 */
export function parseSession(value: unknown): StoredSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const { token, user } = value as { token?: unknown; user?: unknown };
  if (typeof token !== 'string' || !JWT_FORMAT.test(token)) return null;
  if (typeof user !== 'object' || user === null) return null;
  const { id, username, displayName, role } = user as Record<string, unknown>;
  if (typeof id !== 'string' || typeof username !== 'string' || typeof displayName !== 'string') return null;
  if (typeof role !== 'string' || !ROLES.includes(role as UserRole)) return null;
  return { token, user: { id, username, displayName, role: role as UserRole } };
}

export function loadSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = parseSession(JSON.parse(raw));
    if (!session || isTokenExpired(session.token)) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    // JSON corrompido: descarta também.
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

/** Grava só uma sessão no formato esperado; fora dele, nada é gravado. */
export function saveSession(session: StoredSession): void {
  const valid = parseSession(session);
  if (!valid) throw new Error('Resposta de login inválida do servidor.');
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(valid));
}

export function clearSession(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

/** Token atual, ou null se não houver sessão válida. */
export function getToken(): string | null {
  return loadSession()?.token ?? null;
}

/** Chamado pelo apiClient ao receber 401: limpa a sessão e avisa quem estiver ouvindo. */
export function expireSession(): void {
  clearSession();
  expiredListeners.forEach((listener) => listener());
}

export function onSessionExpired(listener: ExpiredListener): () => void {
  expiredListeners.add(listener);
  return () => expiredListeners.delete(listener);
}
