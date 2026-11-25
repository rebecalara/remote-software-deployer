import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, SessionExpiredError } from '../../services/apiClient';
import { getDeployment } from '../../services/deploymentService';

// /deployments/:id não é mais uma tela: só redireciona para onde a implantação está,
// já expandida e destacada (?open=<id>). Em andamento ou encerrada há menos de 24 h →
// Monitoramento; mais antiga → Histórico. Mantém funcionando links antigos e os do
// Dashboard.
const WINDOW_MS = 24 * 60 * 60 * 1000;

export function DeploymentRedirect() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<{ notFound: boolean; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDeployment(id)
      .then((d) => {
        if (cancelled) return;
        const recent = d.finishedAt === null || Date.now() - new Date(d.finishedAt).getTime() < WINDOW_MS;
        const query = `?open=${encodeURIComponent(d.id)}`;
        navigate(recent ? `/monitoring${query}` : `/history${query}`, { replace: true });
      })
      .catch((err) => {
        if (cancelled || err instanceof SessionExpiredError) return;
        const status = err instanceof ApiError ? err.status : null;
        setError({ notFound: status === 404 || status === 400, message: err instanceof Error ? err.message : 'Erro inesperado.' });
      });
    return () => {
      cancelled = true;
    };
  }, [id, navigate]);

  if (!error) return <p className="p-6 text-body text-slate-500">Abrindo a implantação…</p>;

  return (
    <div className="p-4 sm:p-6">
      <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center shadow-sm">
        <p className="text-body font-medium text-slate-700">
          {error.notFound ? 'Implantação não encontrada.' : 'Não foi possível abrir a implantação.'}
        </p>
        {!error.notFound && <p className="mt-1 text-body text-slate-500">{error.message}</p>}
        <div className="mt-4 flex justify-center gap-4 text-body font-medium">
          <Link to="/monitoring" className="text-blue-700 hover:underline">
            Monitoramento
          </Link>
          <Link to="/history" className="text-blue-700 hover:underline">
            Histórico
          </Link>
        </div>
      </div>
    </div>
  );
}
