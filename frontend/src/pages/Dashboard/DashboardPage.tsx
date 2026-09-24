import { useAuth } from '../../context/AuthContext';

export function DashboardPage() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="flex items-center justify-between bg-slate-900 px-6 py-4 text-white">
        <span className="font-semibold">Remote Software Deployer</span>
        <button
          type="button"
          onClick={logout}
          className="rounded-lg border border-white/20 px-3 py-1.5 text-sm hover:bg-white/10"
        >
          Sair
        </button>
      </header>

      <main className="mx-auto max-w-4xl p-6">
        <h1 className="text-2xl font-bold text-slate-900">Olá, {user?.displayName || user?.username}</h1>
        <p className="mt-1 text-slate-500">
          Você está autenticado como <strong>{user?.username}</strong> ({user?.role}).
        </p>
      </main>
    </div>
  );
}
