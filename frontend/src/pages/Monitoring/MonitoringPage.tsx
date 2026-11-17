import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshIcon } from '../../components/icons';
import { useAuth } from '../../context/AuthContext';
import { useNow } from '../../hooks/useNow';
import { SessionExpiredError } from '../../services/apiClient';
import { getDeployment, getDeploymentOverview, listDeployments } from '../../services/deploymentService';
import type { Deployment, DeploymentOverview, DeploymentSummary } from '../../types/deployment';
import { DeploymentTable, toggleInSet } from '../Deployments/DeploymentTable';
import { Counter, LiveIndicator, MineToggle } from '../Deployments/deploymentUi';

// Monitoramento (Bloco 5, RF06/RF10): implantações em andamento e, abaixo, as encerradas
// nas últimas 24 h. Cada implantação expande na própria linha (máquinas, fases, logs e
// "Cancelar pendentes"). ?open=<id> abre e destaca uma implantação (tela de sucesso da
// Nova Instalação, Dashboard). Polling de 3 s só enquanto houver implantação em
// andamento (PLANNING §9: sem WebSocket no MVP). O alternador "Todas / Minhas" filtra
// as listas; os contadores são sempre de todas.
const POLL_MS = 3_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE = 100;
const MAX_FINISHED = 50;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado.';
}

export function MonitoringPage() {
  const { user } = useAuth();
  const canDeploy = user?.role === 'ADMIN' || user?.role === 'OPERATOR';
  const now = useNow(1_000);
  const [params, setParams] = useSearchParams();
  const mine = params.get('mine') === 'true';
  const openParam = params.get('open');

  const [overview, setOverview] = useState<DeploymentOverview | null>(null);
  const [active, setActive] = useState<DeploymentSummary[] | null>(null);
  const [finished, setFinished] = useState<DeploymentSummary[] | null>(null);
  const [finishedTotal, setFinishedTotal] = useState(0);
  const [pinned, setPinned] = useState<Deployment | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set(openParam ? [openParam] : []));
  const [error, setError] = useState<string | null>(null);

  // ?open que muda com a tela já aberta (ex.: outro link para o Monitoramento).
  useEffect(() => {
    if (openParam) setOpenIds((s) => (s.has(openParam) ? s : new Set(s).add(openParam)));
  }, [openParam]);

  const load = useCallback(async () => {
    try {
      const finishedFrom = new Date(Date.now() - WINDOW_MS).toISOString();
      const [o, a, f] = await Promise.all([
        getDeploymentOverview(),
        listDeployments({ state: 'active', pageSize: MAX_ACTIVE, mine }),
        listDeployments({ state: 'finished', finishedFrom, pageSize: MAX_FINISHED, mine }),
      ]);
      // As três listas trocam juntas: uma implantação que acabou de encerrar sai de
      // "em andamento" e entra em "encerradas" na mesma renderização, sem sumir.
      setOverview(o);
      setActive(a.items);
      setFinished(f.items);
      setFinishedTotal(f.total);
      setError(null);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setError(messageOf(err));
    }
  }, [mine]);

  useEffect(() => {
    void load();
  }, [load]);

  // ?open de uma implantação que não está em nenhuma das listas (ex.: escondida pelo
  // "Minhas", ou encerrada há mais de 24 h): mostra à parte, para o link nunca cair no vazio.
  useEffect(() => {
    if (!openParam || active === null || finished === null) return;
    if ([...active, ...finished].some((d) => d.id === openParam)) {
      setPinned(null);
      return;
    }
    if (pinned?.id === openParam) return;
    getDeployment(openParam)
      .then(setPinned)
      .catch(() => setPinned(null));
  }, [openParam, active, finished, pinned?.id]);

  const live = (overview?.activeDeployments ?? 0) > 0 || (active?.length ?? 0) > 0;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, load]);

  /** O painel aberto percebeu o fim antes do polling da lista: atualiza já. */
  const onPanelUpdate = useCallback(
    (d: Deployment) => {
      if (d.finishedAt && active?.some((a) => a.id === d.id)) void load();
    },
    [active, load],
  );

  function toggle(id: string) {
    setOpenIds((s) => toggleInSet(s, id));
    if (id === openParam && openIds.has(id)) {
      const next = new URLSearchParams(window.location.search);
      next.delete('open');
      setParams(next, { replace: true });
    }
  }

  function setMine(value: boolean) {
    const next = new URLSearchParams(window.location.search);
    if (value) next.set('mine', 'true');
    else next.delete('mine');
    setActive(null);
    setFinished(null);
    setParams(next, { replace: true });
  }

  const w = overview?.finishedInWindow;
  const tableProps = { openIds, onToggle: toggle, highlightId: openParam, now, onPanelUpdate };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Contadores (sempre de todas) */}
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
        <MineToggle mine={mine} onChange={setMine} />
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

      {pinned && (
        <section className="space-y-2" data-testid="pinned-section">
          <h2 className="text-sm font-semibold text-slate-700">Implantação aberta pelo link</h2>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <DeploymentTable items={[pinned]} ariaLabel="Implantação aberta pelo link" {...tableProps} />
          </div>
        </section>
      )}

      {/* Em andamento */}
      <section className="space-y-2" data-testid="active-section">
        <h2 className="text-sm font-semibold text-slate-700">
          Em andamento{active && active.length > 0 ? ` (${active.length})` : ''}
        </h2>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {active === null ? (
            <p className="px-6 py-8 text-center text-sm text-slate-500">{error ? 'Sem dados.' : 'Carregando…'}</p>
          ) : active.length === 0 ? (
            <div className="px-6 py-8 text-center">
              <p className="text-sm text-slate-500">
                {mine ? 'Nenhuma implantação sua em andamento.' : 'Nenhuma implantação em andamento.'}
              </p>
              {canDeploy && (
                <Link to="/deployments/new" className="mt-2 inline-block text-sm font-medium text-blue-700 hover:underline">
                  Nova instalação
                </Link>
              )}
            </div>
          ) : (
            <DeploymentTable items={active} ariaLabel="Implantações em andamento" {...tableProps} />
          )}
        </div>
      </section>

      {/* Encerradas nas últimas 24 h */}
      <section className="space-y-2" data-testid="finished-section">
        <h2 className="text-sm font-semibold text-slate-700">
          Encerradas nas últimas 24 h{finished && finished.length > 0 ? ` (${finishedTotal})` : ''}
        </h2>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {finished === null ? (
            <p className="px-6 py-8 text-center text-sm text-slate-500">{error ? 'Sem dados.' : 'Carregando…'}</p>
          ) : finished.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-slate-500">Nenhuma implantação encerrada nas últimas 24 h.</p>
          ) : (
            <DeploymentTable items={finished} ariaLabel="Implantações encerradas nas últimas 24 h" {...tableProps} />
          )}
        </div>
        <p className="text-xs text-slate-500">
          {finished !== null && finishedTotal > finished.length && <>Mostrando as {finished.length} mais recentes de {finishedTotal}. </>}
          As mais antigas ficam no{' '}
          <Link to={mine ? '/history?mine=true' : '/history'} className="font-medium text-blue-700 hover:underline">
            Histórico
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
