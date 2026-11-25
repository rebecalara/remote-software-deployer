import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { RsdLoginBrand } from '../../components/brand/RsdLoginBrand';
import { RsdMark } from '../../components/brand/RsdMark';
import { RsdWordmark } from '../../components/brand/RsdWordmark';
import { EyeIcon, EyeOffIcon } from '../../components/icons';
import { safeRedirectPath } from '../../routes/safeRedirect';

export function LoginPage() {
  const { login, isAuthenticated, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Página para voltar (sessão expirada ou link direto), só se for caminho interno; senão,
  // e depois de "Sair" ou abrindo /login direto, o Dashboard.
  const from = safeRedirectPath((location.state as { from?: unknown } | null)?.from);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const capsLock = useCapsLock();

  if (isAuthenticated) {
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado ao entrar.');
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* Painel institucional — some em telas pequenas */}
      <aside className="relative hidden w-1/2 flex-col overflow-hidden bg-slate-950 text-white lg:flex">
        <div className="relative flex flex-1 flex-col items-center justify-center px-12 text-center">
          <RsdLoginBrand />
        </div>

        {/* Absoluto para não empurrar o conteúdo: assim ele fica no centro exato do painel */}
        <footer className="absolute inset-x-0 bottom-0 border-t border-white/5 px-12 py-6 text-center text-meta tracking-wide text-slate-500">
          Sistema desenvolvido para o Departamento de Tecnologia da Informação — Prefeitura de
          Joinville, SC
        </footer>
      </aside>

      <main className="flex flex-1 flex-col items-center justify-center bg-slate-100 px-4 py-10">
        <div className="w-full max-w-md">
          {/* Identidade compacta para quando o painel institucional está oculto */}
          <div className="mb-8 flex items-center justify-center gap-4 lg:hidden">
            <RsdMark className="h-14 w-14 shrink-0" />
            <div className="leading-tight">
              <p>
                <RsdWordmark className="text-stat" />
              </p>
              <p className="text-meta tracking-wider text-slate-500 uppercase">Remote Software Deployer</p>
            </div>
          </div>

          <div className="rounded-2xl bg-white p-8 shadow-lg">
            <h1 className="text-page font-semibold text-slate-900">Entrar no sistema</h1>
            <p className="mt-1 text-body text-slate-500">
              Utilize suas credenciais de rede institucionais
            </p>

            {sessionExpired && !error && (
              <p role="status" className="mt-6 rounded-lg bg-amber-50 px-3 py-2 text-body text-amber-800">
                Sua sessão expirou. Entre novamente para continuar.
              </p>
            )}

            <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
              <Field label="Usuário" htmlFor="username">
                <input
                  id="username"
                  type="text"
                  autoComplete="username"
                  autoFocus
                  required
                  placeholder="seu.usuario"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-transparent text-slate-900 outline-none placeholder:text-slate-400"
                />
              </Field>

              <Field
                label="Senha"
                htmlFor="password"
                after={
                  // Sempre montado (vazio quando desligado): assim o leitor de tela anuncia quando aparece.
                  <p id="caps-lock-warning" role="status" aria-live="polite" className={`text-meta font-medium text-amber-700 ${capsLock ? 'mt-1.5' : ''}`}>
                    {capsLock ? 'Caps Lock ativado' : ''}
                  </p>
                }
              >
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  aria-describedby="caps-lock-warning"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-transparent text-slate-900 outline-none placeholder:text-slate-400"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  className="text-slate-400 hover:text-slate-600"
                >
                  {showPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                </button>
              </Field>

              {error && (
                <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-body text-red-700">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting || !username.trim() || !password}
                className="w-full rounded-lg bg-blue-700 py-3 font-semibold text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Entrando…' : 'Entrar'}
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * Caps Lock ligado? Lido de qualquer tecla ou clique na página (getModifierState); começa
 * desligado, porque o navegador só informa o estado num evento de teclado ou mouse.
 */
function useCapsLock(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = (e: KeyboardEvent | MouseEvent) => {
      if (typeof e.getModifierState === 'function') setOn(e.getModifierState('CapsLock'));
    };
    window.addEventListener('keydown', read);
    window.addEventListener('keyup', read);
    window.addEventListener('mousedown', read);
    return () => {
      window.removeEventListener('keydown', read);
      window.removeEventListener('keyup', read);
      window.removeEventListener('mousedown', read);
    };
  }, []);
  return on;
}

function Field({ label, htmlFor, children, after }: { label: string; htmlFor: string; children: ReactNode; after?: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-body font-medium text-slate-700">
        {label}
      </label>
      <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20">
        {children}
      </div>
      {after}
    </div>
  );
}
