import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

// Mínimo de propósito: o conteúdo real do Dashboard não é do Bloco 2.
export function DashboardPage() {
  const { user } = useAuth();

  return (
    <div className="p-4 sm:p-6">
      <h2 className="text-2xl font-bold text-slate-900">Olá, {user?.displayName || user?.username}</h2>
      <p className="mt-1 text-slate-500">Bem-vindo ao Remote Software Deployer.</p>

      <Link
        to="/machines"
        className="mt-6 inline-flex rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
      >
        Ver máquinas
      </Link>
    </div>
  );
}
