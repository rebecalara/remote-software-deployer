import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import logo from '../../assets/logo.png';

export function LoginPage() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
        {/* Fundo decorativo: dois círculos nos cantos */}
        <div className="pointer-events-none absolute -top-48 -right-48 h-[30rem] w-[30rem] rounded-full bg-blue-800/15" />
        <div className="pointer-events-none absolute -bottom-56 -left-40 h-[32rem] w-[32rem] rounded-full bg-blue-900/25" />

        <div className="relative flex flex-1 flex-col items-center justify-center px-12 text-center">
          {/* O PNG tem margem branca em volta do quadro cinza; o scale + overflow só recorta essa margem */}
          <div className="h-36 w-36 overflow-hidden rounded-3xl shadow-2xl shadow-black/50 ring-1 ring-white/10 xl:h-40 xl:w-40">
            <img
              src={logo}
              alt="Brasão da Prefeitura de Joinville"
              className="h-full w-full scale-[1.18] object-contain"
            />
          </div>

          <div className="mt-10 h-px w-12 bg-blue-500/60" />

          <h2 className="mt-10 text-4xl leading-tight font-semibold tracking-tight xl:text-5xl">
            Remote Software
            <span className="block font-bold text-blue-400">Deployer</span>
          </h2>

          <p className="mt-5 max-w-md text-base text-balance text-slate-400">
            Plataforma de gerenciamento e implantação de software
          </p>
        </div>

        {/* Absoluto para não empurrar o conteúdo: assim ele fica no centro exato do painel */}
        <footer className="absolute inset-x-0 bottom-0 border-t border-white/5 px-12 py-6 text-center text-xs tracking-wide text-slate-500">
          Sistema desenvolvido para o Departamento de Tecnologia da Informação — Prefeitura de
          Joinville, SC
        </footer>
      </aside>

      <main className="flex flex-1 flex-col items-center justify-center bg-slate-100 px-4 py-10">
        <div className="w-full max-w-md">
          {/* Identidade compacta para quando o painel institucional está oculto */}
          <div className="mb-8 flex items-center justify-center gap-4 lg:hidden">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl shadow-md">
              <img
                src={logo}
                alt="Brasão da Prefeitura de Joinville"
                className="h-full w-full scale-[1.18] object-contain"
              />
            </div>
            <p className="text-xl leading-tight font-semibold tracking-tight text-slate-900">
              Remote Software
              <span className="block font-bold text-blue-700">Deployer</span>
            </p>
          </div>

          <div className="rounded-2xl bg-white p-8 shadow-lg">
            <h1 className="text-2xl font-bold text-slate-900">Entrar no sistema</h1>
            <p className="mt-1 text-sm text-slate-500">
              Utilize suas credenciais de rede institucionais
            </p>

            <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
              <Field label="Usuário" htmlFor="username">
                <UserIcon className="h-4 w-4 text-slate-400" />
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

              <Field label="Senha" htmlFor="password">
                <LockIcon className="h-4 w-4 text-slate-400" />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  placeholder="••••••••"
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
                <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
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

            <p className="mt-8 border-t border-slate-100 pt-6 text-center text-xs text-slate-500">
              Problemas com acesso? Contate o suporte de TI.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20">
        {children}
      </div>
    </div>
  );
}

type IconProps = { className?: string };

function Svg({ className = 'h-5 w-5', children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function UserIcon(props: IconProps) {
  return <Svg {...props}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>;
}
function LockIcon(props: IconProps) {
  return <Svg {...props}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Svg>;
}
function EyeIcon(props: IconProps) {
  return <Svg {...props}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Svg>;
}
function EyeOffIcon(props: IconProps) {
  return <Svg {...props}><path d="M3 3l18 18" /><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></Svg>;
}
