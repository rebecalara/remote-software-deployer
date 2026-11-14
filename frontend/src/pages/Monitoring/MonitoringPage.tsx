import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RefreshIcon } from '../../components/icons';
import { useAuth } from '../../context/AuthContext';
import { useNow } from '../../hooks/useNow';
import { SessionExpiredError } from '../../services/apiClient';
import { getDeploymentOverview, listDeployments } from '../../services/deploymentService';
import type { DeploymentOverview, DeploymentSummary } from '../../types/deployment';
import { formatDateTime } from '../../utils/format';
import { Counter, LiveIndicator, StatusBadge, countsText, durationText } from '../Deployments/deploymentUi';

// Painel de Monitoramento (Bloco 5, RF06/RF10) — página inicial do sistema. Contadores
// reais sobre todas as implantações e a lista das mais recentes, cada uma levando ao
// acompanhamento (/deployments/:id). Polling de 3 s SÓ enquanto houver implantação em
// andamento (PLANNING §9: sem WebSocket no MVP).
const POLL_MS = 3_000;
const RECENT = 20;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado.';
}

export function MonitoringPage() {
  const { user } = useAuth();
  const canDeploy = user?.role === 'ADMIN' || user?.role === 'OPERATOR';
  const navigate = useNavigate();
  const now = useNow(1_000);

  const [overview, setOverview] = useState<DeploymentOverview | null>(null);
  const [recent, setRecent] = useState<DeploymentSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, page] = await Promise.all([getDeploymentOverview(), listDeployments({ pageSize: RECENT })]);
      setOverview(o);
      setRecent(page.items);
      setTotal(page.total);
      setError(null);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const live = (overview?.activeDeployments ?? 0) > 0;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const w = overview?.finishedInWindow;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Contadores */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Counter label="Implantações ativas" value={overview?.activeDeployments ?? 0} />
        <Counter
          label="Máquinas em andamento"
          value={overview?.runningTargets ?? 0}
          tone="blue"
          detail={overview && overview.pendingTargets > 0 ? `${overview.pendingTargets} na fila` : undefined}
        />
        <Counter label={`Concluídas (${overview?.windowHours ?? 24} h)`} value={w?.succeeded ?? 0} tone="green" />
        <Counter
          label={`Com falha (${overview?.windowHours ?? 24} h)`}
          value={w?.failed ?? 0}
          tone="red"
          detail={w && w.cancelled > 0 ? `${w.cancelled} ${w.cancelled === 1 ? 'cancelada' : 'canceladas'}` : undefined}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-700">Implantações recentes</h2>
        <div className="flex items-center gap-2 text-xs">
          <LiveIndicator live={live} idleText="Nenhuma implantação em andamento" />
          <button
            type="button"
            onClick={load}
            aria-label="Atualizar agora"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-200/60 hover:text-slate-700"
          >
            <RefreshIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Não foi possível atualizar o painel: {error}
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {recent === null ? (
          <p className="px-6 py-12 text-center text-sm text-slate-500">{error ? 'Sem dados.' : 'Carregando…'}</p>
        ) : recent.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm font-medium text-slate-700">Nenhuma implantação ainda.</p>
            {canDeploy && (
              <Link to="/deployments/new" className="mt-2 inline-block text-sm font-medium text-blue-700 hover:underline">
                Nova instalação
              </Link>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3">Implantação</th>
                  <th scope="col" className="px-4 py-3">Máquinas</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3">Solicitada por</th>
                  <th scope="col" className="px-4 py-3">Criada em</th>
                  <th scope="col" className="px-4 py-3">Duração</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recent.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() => navigate(`/deployments/${d.id}`)}
                    className="cursor-pointer hover:bg-slate-50"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`/deployments/${d.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="font-medium text-slate-900 hover:text-blue-700 hover:underline"
                      >
                        {d.name}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {d.software.name} <span className="font-mono">{d.software.version}</span>
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{countsText(d.counts)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                      {d.requestedBy.displayName || d.requestedBy.username}
                    </td>
                    <td className="px-4 py-3 font-mono text-[13px] whitespace-nowrap text-slate-600">
                      {formatDateTime(d.createdAt)}
                    </td>
                    <td className="px-4 py-3 font-mono text-[13px] whitespace-nowrap text-slate-600">
                      {durationText(d.startedAt, d.finishedAt, now, d.finishedAt === null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {recent !== null && total > recent.length && (
        <p className="text-xs text-slate-500">
          Mostrando as {recent.length} mais recentes de {total}.{' '}
          <Link to="/history" className="font-medium text-blue-700 hover:underline">
            Ver o histórico completo
          </Link>
        </p>
      )}
    </div>
  );
}
