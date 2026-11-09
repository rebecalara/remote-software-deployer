import type { AuthenticatedUser } from '../types/auth';

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

export function loadSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as StoredSession;
    if (!session.token || isTokenExpired(session.token)) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
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
