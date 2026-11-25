import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { FeedbackMessage, type Feedback } from '../../components/FeedbackMessage';
import { RefreshIcon } from '../../components/icons';
import { Tooltip } from '../../components/Tooltip';
import { useAuth } from '../../context/AuthContext';
import { useNow } from '../../hooks/useNow';
import { SessionExpiredError } from '../../services/apiClient';
import { getDeployment, listDeployments } from '../../services/deploymentService';
import type { Deployment, DeploymentSummary } from '../../types/deployment';
import { DeploymentTable, toggleInSet } from '../Deployments/DeploymentTable';
import { LiveIndicator, MineToggle } from '../Deployments/deploymentUi';

// Monitoramento (Bloco 5, RF06/RF10): implantações em andamento e, abaixo, as encerradas
// nas últimas 24 h. Cada implantação expande na própria linha (máquinas, fases, logs e
// "Cancelar pendentes"). ?open=<id> abre e destaca uma implantação (ao iniciar na
// Nova Implantação, Dashboard). Polling de 3 s só enquanto houver implantação em
// andamento nas listas mostradas (PLANNING §9: sem WebSocket no MVP). O alternador
// "Todas / Minhas" filtra as listas. Sem cartões de contagem: o número de cada seção fica no
// título dela ("Em andamento (N)", "Encerradas nas últimas 24 h (N)").
const POLL_MS = 3_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE = 100;
const MAX_FINISHED = 50;

/** A Nova Implantação chega aqui com a mensagem de sucesso (state da navegação). */
export interface MonitoringLocationState {
  feedback?: Feedback;
}

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

  const [active, setActive] = useState<DeploymentSummary[] | null>(null);
  const [finished, setFinished] = useState<DeploymentSummary[] | null>(null);
  const [finishedTotal, setFinishedTotal] = useState(0);
  const [pinned, setPinned] = useState<Deployment | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set(openParam ? [openParam] : []));
  const [error, setError] = useState<string | null>(null);

  // Mensagem vinda da Nova Implantação ("Implantação iniciada: …"). Lida uma vez e tirada do
  // histórico, para não voltar num F5 ou ao voltar no navegador.
  const location = useLocation();
  const navigate = useNavigate();
  const [feedback, setFeedback] = useState<Feedback | null>(
    () => (location.state as MonitoringLocationState | null)?.feedback ?? null,
  );
  useEffect(() => {
    if ((location.state as MonitoringLocationState | null)?.feedback) {
      navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
    }
  }, [location, navigate]);

  // ?open que muda com a tela já aberta (ex.: outro link para o Monitoramento).
  useEffect(() => {
    if (openParam) setOpenIds((s) => (s.has(openParam) ? s : new Set(s).add(openParam)));
  }, [openParam]);

  const load = useCallback(async () => {
    try {
      const finishedFrom = new Date(Date.now() - WINDOW_MS).toISOString();
      const [a, f] = await Promise.all([
        listDeployments({ state: 'active', pageSize: MAX_ACTIVE, mine }),
        listDeployments({ state: 'finished', finishedFrom, pageSize: MAX_FINISHED, mine }),
      ]);
      // As duas listas trocam juntas: uma implantação que acabou de encerrar sai de
      // "em andamento" e entra em "encerradas" na mesma renderização, sem sumir.
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

  // Algo em andamento NAS LISTAS MOSTRADAS (ou na implantação aberta pelo link): só então
  // há polling e o selo "Atualizando a cada 3 s". Sem nada rodando, o selo some.
  const live = (active?.length ?? 0) > 0 || (pinned !== null && pinned.finishedAt === null);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, load]);

  /** O painel aberto percebeu o fim antes do polling da lista: atualiza já. */
  const onPanelUpdate = useCallback(
    (d: Deployment) => {
      if (d.finishedAt && active?.some((a) => a.id === d.id)) void load();
      // A implantação aberta pelo link não vem nas listas: a linha dela segue o painel.
      setPinned((p) => (p && p.id === d.id ? d : p));
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

  const tableProps = { openIds, onToggle: toggle, highlightId: openParam, now, onPanelUpdate, hideRequester: mine };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {feedback && <FeedbackMessage feedback={feedback} onDismiss={() => setFeedback(null)} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <MineToggle mine={mine} onChange={setMine} />
        <div className="flex items-center gap-2 text-meta">
          {live && <LiveIndicator />}
          <Tooltip content="Atualizar agora" asLabel align="end">
            <button
              type="button"
              onClick={load}
              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-200/60 hover:text-slate-700"
            >
              <RefreshIcon className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-body text-amber-800">
          Não foi possível atualizar o painel: {error}
        </p>
      )}

      {pinned && (
        <section className="space-y-2" data-testid="pinned-section">
          <h2 className="text-section font-semibold text-slate-700">Implantação aberta pelo link</h2>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <DeploymentTable items={[pinned]} ariaLabel="Implantação aberta pelo link" {...tableProps} />
          </div>
        </section>
      )}

      {/* Em andamento */}
      <section className="space-y-2" data-testid="active-section">
        <h2 className="text-section font-semibold text-slate-700">
          Em andamento{active && active.length > 0 ? ` (${active.length})` : ''}
        </h2>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {active === null ? (
            <p className="px-6 py-8 text-center text-body text-slate-500">{error ? 'Sem dados.' : 'Carregando…'}</p>
          ) : active.length === 0 ? (
            <div className="px-6 py-8 text-center">
              <p className="text-body text-slate-500">
                {mine ? 'Nenhuma implantação sua em andamento.' : 'Nenhuma implantação em andamento.'}
              </p>
              {canDeploy && (
                <Link to="/deployments/new" className="mt-2 inline-block text-body font-medium text-blue-700 hover:underline">
                  Nova implantação
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
        <h2 className="text-section font-semibold text-slate-700">
          Encerradas nas últimas 24 h{finished && finished.length > 0 ? ` (${finishedTotal})` : ''}
        </h2>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {finished === null ? (
            <p className="px-6 py-8 text-center text-body text-slate-500">{error ? 'Sem dados.' : 'Carregando…'}</p>
          ) : finished.length === 0 ? (
            <p className="px-6 py-8 text-center text-body text-slate-500">Nenhuma implantação encerrada nas últimas 24 h.</p>
          ) : (
            <DeploymentTable items={finished} ariaLabel="Implantações encerradas nas últimas 24 h" {...tableProps} />
          )}
        </div>
        <p className="text-meta text-slate-500">
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
