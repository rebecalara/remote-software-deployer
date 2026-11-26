import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Sem sessão, vai para o login. Guarda a página (caminho + busca + âncora) para voltar
 * depois do login quando a sessão expirou ou a pessoa abriu um link direto; depois de
 * "Sair", não guarda nada: o próximo login vai para o Dashboard.
 */
export function ProtectedRoute() {
  const { isAuthenticated, loggedOut } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    const state = loggedOut ? undefined : { from: `${location.pathname}${location.search}${location.hash}` };
    return <Navigate to="/login" replace state={state} />;
  }
  return <Outlet />;
}
