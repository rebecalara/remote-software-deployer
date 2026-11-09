import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import * as authService from '../services/authService';
import {
  clearSession,
  isTokenExpired,
  loadSession,
  onSessionExpired,
  saveSession,
  type StoredSession,
} from '../services/session';
import type { AuthenticatedUser } from '../types/auth';

interface AuthContextValue {
  user: AuthenticatedUser | null;
  token: string | null;
  isAuthenticated: boolean;
  /** true quando a sessão acabou por 401/expiração (não por "Sair") — a tela de login avisa. */
  sessionExpired: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(loadSession);
  const [sessionExpired, setSessionExpired] = useState(false);

  // O apiClient encerra a sessão ao receber 401; aqui o React fica sabendo,
  // e o ProtectedRoute redireciona para /login.
  useEffect(
    () =>
      onSessionExpired(() => {
        setSession(null);
        setSessionExpired(true);
      }),
    [],
  );

  const login = useCallback(async (username: string, password: string) => {
    const { accessToken, user } = await authService.login(username, password);
    const next = { token: accessToken, user };
    saveSession(next);
    setSession(next);
    setSessionExpired(false);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setSession(null);
    setSessionExpired(false);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      token: session?.token ?? null,
      isAuthenticated: session !== null && !isTokenExpired(session.token),
      sessionExpired,
      login,
      logout,
    }),
    [session, sessionExpired, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth precisa estar dentro de <AuthProvider>.');
  return ctx;
}
