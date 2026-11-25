import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FeedbackMessage, type Feedback } from '../../components/FeedbackMessage';
import { Tooltip } from '../../components/Tooltip';
import { RefreshIcon } from '../../components/icons';
import { useAuth } from '../../context/AuthContext';
import { useNow } from '../../hooks/useNow';
import { SessionExpiredError } from '../../services/apiClient';
import { cancelDeployment, getDeployment, getTargetLogs } from '../../services/deploymentService';
import type { Deployment, DeploymentLog, DeploymentStatus, DeploymentTarget, LogLevel } from '../../types/deployment';
import { formatDuration, formatTime } from './deploymentUi';
import { phaseOf, type PhaseTone } from './targetPhase';
import { plural } from './wizardParts';

// Detalhe de UMA implantação (RF06/RF13), aberto na própria linha do Monitoramento e
// do Histórico (acordeão): máquinas com status (a fase durante a execução, o resultado no
// fim), tempo, código de saída e o log de cada uma, e "Cancelar pendentes". Polling simples
// (PLANNING §9, sem WebSocket): a cada 3 s enquanto houver máquina pendente ou em execução.
// O selo "Atualizando a cada 3 s" fica só no topo da tela, não se repete aqui.
const POLL_MS = 3_000;

type Filter = 'all' | 'active' | 'succeeded' | 'failed' | 'cancelled';

const FINAL: DeploymentStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

// Último estado lido de cada implantação. Quando a implantação passa de "em andamento"
// para "encerradas" no Monitoramento, a linha muda de seção e o painel é montado de novo:
// com o cache, ele reaparece já preenchido, sem piscar "Carregando…".
// Pelo mesmo motivo, a aba e o log aberto de cada implantação também sobrevivem à troca.
const lastSeen = new Map<string, Deployment>();
const lastView = new Map<string, { filter: Filter; expanded: string | null }>();

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado.';
}

export function DeploymentPanel({
  deploymentId,
  onUpdate,
}: {
  deploymentId: string;
  /** Chamado a cada leitura: a lista usa para perceber o fim sem esperar o próprio polling. */
  onUpdate?: (deployment: Deployment) => void;
}) {
  const { user } = useAuth();
  const canCancel = user?.role === 'ADMIN' || user?.role === 'OPERATOR';
  const now = useNow(1_000);

  const [deployment, setDeployment] = useState<Deployment | null>(() => lastSeen.get(deploymentId) ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(() => lastView.get(deploymentId)?.filter ?? 'all');
  const [expanded, setExpanded] = useState<string | null>(() => lastView.get(deploymentId)?.expanded ?? null);
  useEffect(() => {
    lastView.set(deploymentId, { filter, expanded });
  }, [deploymentId, filter, expanded]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  const apply = useCallback((d: Deployment) => {
    lastSeen.set(d.id, d);
    setDeployment(d);
    onUpdateRef.current?.(d);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await getDeployment(deploymentId));
      setLoadError(null);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setLoadError(messageOf(err));
    }
  }, [deploymentId, apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const finished = deployment?.finishedAt != null;
  useEffect(() => {
    if (!deployment || finished) return;
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [deployment, finished, load]);

  async function handleCancel() {
    setCancelling(true);
    setFeedback(null);
    try {
      const before = deployment?.counts.pending ?? 0;
      const updated = await cancelDeployment(deploymentId);
      apply(updated);
      const cancelled = before - updated.counts.pending;
      setFeedback({ kind: 'success', text: `${plural(cancelled, 'máquina pendente cancelada', 'máquinas pendentes canceladas')}.` });
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setFeedback({ kind: 'error', text: messageOf(err) });
      void load();
    } finally {
      setCancelling(false);
      setConfirmCancel(false);
    }
  }

  // A aba "Em andamento" some quando a implantação encerra; quem estava nela volta a "Todas".
  useEffect(() => {
    if (finished && filter === 'active') setFilter('all');
  }, [finished, filter]);

  const targets = useMemo(() => deployment?.targets ?? [], [deployment]);
  const visible = useMemo(
    () =>
      targets.filter((t) => {
        if (filter === 'active') return t.status === 'PENDING' || t.status === 'RUNNING';
        if (filter === 'succeeded') return t.status === 'SUCCEEDED';
        if (filter === 'failed') return t.status === 'FAILED';
        if (filter === 'cancelled') return t.status === 'CANCELLED';
        return true;
      }),
    [targets, filter],
  );

  if (!deployment) {
    return (
      <p className="px-2 py-4 text-body text-slate-500">
        {loadError ? `Não foi possível carregar a implantação: ${loadError}` : 'Carregando máquinas…'}
      </p>
    );
  }

  const c = deployment.counts;
  const active = c.pending + c.running;

  return (
    <div className="space-y-3" data-testid="deployment-panel">
      {deployment.vendorCommand && (
        <p className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-meta text-orange-900" data-testid="vendor-command">
          Comando do fabricante executado: <span className="font-mono break-all">{deployment.vendorCommand}</span>
        </p>
      )}
      {/* Abas por status (só com mais de 1 máquina) + cancelar + atualizar (só em andamento) */}
      {(c.total > 1 || (canCancel && c.pending > 0 && !confirmCancel) || !finished) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {c.total > 1 ? (
            <div role="tablist" aria-label="Filtrar máquinas" className="flex flex-wrap gap-1 border-b border-slate-200">
              <Tab active={filter === 'all'} onClick={() => setFilter('all')}>Todas ({c.total})</Tab>
              {!finished && (
                <Tab active={filter === 'active'} onClick={() => setFilter('active')}>Em andamento ({active})</Tab>
              )}
              <Tab active={filter === 'succeeded'} onClick={() => setFilter('succeeded')}>Concluídas ({c.succeeded})</Tab>
              <Tab active={filter === 'failed'} onClick={() => setFilter('failed')}>Com falha ({c.failed})</Tab>
              {c.cancelled > 0 && (
                <Tab active={filter === 'cancelled'} onClick={() => setFilter('cancelled')}>Canceladas ({c.cancelled})</Tab>
              )}
            </div>
          ) : (
            <span />
          )}
          <div className="flex flex-wrap items-center gap-2 text-meta">
            {canCancel && c.pending > 0 && !confirmCancel && (
              <button
                type="button"
                onClick={() => setConfirmCancel(true)}
                className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-body font-medium text-red-700 hover:bg-red-50"
              >
                Cancelar pendentes ({c.pending})
              </button>
            )}
            {!finished && (
              <Tooltip content="Atualizar esta implantação agora" asLabel align="end">
                <button
                  type="button"
                  onClick={load}
                  className="rounded-md p-1.5 text-slate-500 hover:bg-slate-200/60 hover:text-slate-700"
                >
                  <RefreshIcon className="h-4 w-4" />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      )}

      {confirmCancel && (
        <div
          role="alertdialog"
          aria-label="Confirmar cancelamento"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-body text-amber-900"
        >
          <span className="min-w-0 flex-1">
            {c.pending === 1
              ? 'Cancelar a máquina que ainda não começou?'
              : `Cancelar as ${c.pending} máquinas que ainda não começaram?`}{' '}
            As que estão em execução terminam normalmente.
          </span>
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            className="rounded-lg bg-red-700 px-3 py-1.5 font-semibold text-white hover:bg-red-800 disabled:opacity-60"
          >
            {cancelling ? 'Cancelando…' : 'Cancelar pendentes'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmCancel(false)}
            disabled={cancelling}
            className="rounded-lg px-3 py-1.5 font-medium text-amber-900 hover:bg-amber-100"
          >
            Voltar
          </button>
        </div>
      )}

      {feedback && <FeedbackMessage feedback={feedback} onDismiss={() => setFeedback(null)} />}
      {loadError && (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-body text-amber-800">
          Falha ao atualizar ({loadError}). Tentando de novo a cada 3 s.
        </p>
      )}

      {/* Máquinas */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {visible.length === 0 ? (
          <p className="px-6 py-8 text-center text-body text-slate-500">Nenhuma máquina neste filtro.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-body">
              <thead className="border-b border-slate-200 bg-slate-50 text-meta font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="w-10 px-3 py-2.5" aria-label="Expandir log" />
                  <th scope="col" className="px-4 py-2.5">Máquina</th>
                  <th scope="col" className="px-4 py-2.5">Status</th>
                  <th scope="col" className="px-4 py-2.5">Início</th>
                  <th scope="col" className="px-4 py-2.5">Tempo decorrido</th>
                  <th scope="col" className="px-4 py-2.5">Código de saída</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((t) => (
                  <TargetRow
                    key={t.id}
                    deploymentId={deployment.id}
                    target={t}
                    now={now}
                    open={expanded === t.id}
                    onToggle={() => setExpanded(expanded === t.id ? null : t.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- linha da máquina + log ----------

// Status da máquina numa coluna só: durante a execução, a fase ("Copiando o instalador");
// no fim, o resultado ("Concluído", "Já estava instalado", "Falhou"…).
const PHASE_STYLE: Record<PhaseTone, { className: string; dot: string }> = {
  waiting: { className: 'border-slate-200 bg-slate-50 text-slate-600', dot: 'bg-slate-400' },
  running: { className: 'border-blue-200 bg-blue-50 text-blue-700', dot: 'bg-blue-500 animate-pulse motion-reduce:animate-none' },
  success: { className: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  warning: { className: 'border-amber-200 bg-amber-50 text-amber-800', dot: 'bg-amber-500' },
  danger: { className: 'border-red-200 bg-red-50 text-red-700', dot: 'bg-red-500' },
  muted: { className: 'border-slate-200 bg-slate-100 text-slate-500', dot: 'bg-slate-400' },
};

function PhaseBadge({ label, tone }: { label: string; tone: PhaseTone }) {
  const st = PHASE_STYLE[tone];
  return (
    <span
      data-testid="phase"
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-meta font-medium whitespace-nowrap ${st.className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

function TargetRow({
  deploymentId,
  target: t,
  now,
  open,
  onToggle,
}: {
  deploymentId: string;
  target: DeploymentTarget;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const phase = phaseOf(t);
  const start = t.startedAt ? new Date(t.startedAt).getTime() : null;
  const end = t.finishedAt ? new Date(t.finishedAt).getTime() : t.status === 'RUNNING' ? now : null;

  return (
    <>
      <tr onClick={onToggle} className={`cursor-pointer ${open ? 'bg-slate-50' : 'hover:bg-slate-50'}`} data-machine={t.hostname}>
        <td className="px-3 py-2.5 text-slate-400">
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Ocultar' : 'Mostrar'} o log de ${t.hostname}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-slate-200/70"
          >
            <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true">
              ›
            </span>
          </button>
        </td>
        <td className="px-4 py-2.5 font-mono text-body font-semibold whitespace-nowrap text-slate-900">{t.hostname}</td>
        <td className="px-4 py-2.5">
          <PhaseBadge label={phase.label} tone={phase.tone} />
        </td>
        <td className="px-4 py-2.5 text-body whitespace-nowrap text-slate-600">{formatTime(t.startedAt)}</td>
        <td className="px-4 py-2.5 text-body whitespace-nowrap text-slate-600 tabular-nums">
          {start !== null && end !== null ? formatDuration(end - start) : '—'}
        </td>
        <td className="px-4 py-2.5 font-mono text-body whitespace-nowrap text-slate-600">{t.exitCode ?? '—'}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-slate-50 px-4 pt-2 pb-4">
            <LogPanel deploymentId={deploymentId} target={t} />
          </td>
        </tr>
      )}
    </>
  );
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  DEBUG: 'text-slate-500',
  INFO: 'text-slate-200',
  WARN: 'text-amber-300',
  ERROR: 'text-red-400',
};

/** Passos reais da máquina (DeploymentLog), atualizados enquanto ela não termina. */
function LogPanel({ deploymentId, target }: { deploymentId: string; target: DeploymentTarget }) {
  const [logs, setLogs] = useState<DeploymentLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const done = FINAL.includes(target.status);

  const load = useCallback(async () => {
    try {
      setLogs(await getTargetLogs(deploymentId, target.id));
      setError(null);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setError(messageOf(err));
    }
  }, [deploymentId, target.id]);

  // Recarrega quando a linha recebe um passo novo (lastLog muda a cada polling do painel)
  // e, enquanto a máquina não termina, também no mesmo ritmo de 3 s.
  useEffect(() => {
    void load();
  }, [load, target.lastLog?.timestamp, target.status]);
  useEffect(() => {
    if (done) return;
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [done, load]);

  // Rola até o fim quando chega passo novo, se a pessoa já estava no fim.
  const atBottom = useRef(true);
  useEffect(() => {
    if (box.current && atBottom.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs]);

  return (
    <div>
      <div
        ref={box}
        role="log"
        aria-label={`Log de ${target.hostname}`}
        data-testid="log-panel"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="max-h-72 overflow-y-auto rounded-lg bg-slate-950 px-4 py-3 font-mono text-meta leading-relaxed"
      >
        {error ? (
          <p className="text-red-400">Não foi possível carregar o log: {error}</p>
        ) : logs === null ? (
          <p className="text-slate-500">Carregando…</p>
        ) : logs.length === 0 ? (
          <p className="text-slate-500">Nenhum passo registrado ainda — a máquina está aguardando na fila.</p>
        ) : (
          logs.map((l, i) => (
            <p key={i} className={`break-words whitespace-pre-wrap ${LEVEL_COLOR[l.level]}`}>
              <span className="text-slate-500">[{formatTime(l.timestamp)}]</span> {l.message}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-body font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
        active ? 'border-blue-700 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
  );
}
