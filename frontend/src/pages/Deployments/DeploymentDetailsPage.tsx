import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { RefreshIcon } from '../../components/icons';
import { useAuth } from '../../context/AuthContext';
import { useNow } from '../../hooks/useNow';
import { ApiError, SessionExpiredError } from '../../services/apiClient';
import { cancelDeployment, getDeployment, getTargetLogs } from '../../services/deploymentService';
import type { Deployment, DeploymentLog, DeploymentStatus, DeploymentTarget, LogLevel } from '../../types/deployment';
import { formatDateTime } from '../../utils/format';
import { phaseOf, type PhaseTone } from './targetPhase';
import { plural } from './wizardParts';

// Acompanhamento de UMA implantação (RF06), a partir do mockup de Monitoramento do
// Portfólio. Polling simples (PLANNING §9, sem WebSocket): a cada 3 s enquanto houver
// máquina pendente ou em execução. O painel geral com todas as implantações é do Bloco 5
// e reaproveita esta tela.
const POLL_MS = 3_000;

type Filter = 'all' | 'active' | 'succeeded' | 'failed' | 'cancelled';

const FINAL: DeploymentStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado.';
}

export function DeploymentDetailsPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const canCancel = user?.role === 'ADMIN' || user?.role === 'OPERATOR';
  const now = useNow(1_000);

  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [loadError, setLoadError] = useState<{ status: number | null; message: string } | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setDeployment(await getDeployment(id));
      setLoadError(null);
      setLastUpdate(Date.now());
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      setLoadError({ status: err instanceof ApiError ? err.status : null, message: messageOf(err) });
    }
  }, [id]);

  useEffect(() => {
    setDeployment(null);
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
      const updated = await cancelDeployment(id);
      setDeployment(updated);
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

  if (loadError && !deployment) {
    return (
      <div className="p-4 sm:p-6">
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center shadow-sm">
          <p className="text-sm font-medium text-slate-700">
            {loadError.status === 404 || loadError.status === 400
              ? 'Implantação não encontrada.'
              : 'Não foi possível carregar a implantação.'}
          </p>
          {loadError.status !== 404 && loadError.status !== 400 && (
            <p className="mt-1 text-sm text-slate-500">{loadError.message}</p>
          )}
          <div className="mt-4 flex justify-center gap-4 text-sm font-medium">
            {loadError.status !== 404 && loadError.status !== 400 && (
              <button type="button" onClick={load} className="text-blue-700 hover:underline">
                Tentar de novo
              </button>
            )}
            <Link to="/deployments/new" className="text-blue-700 hover:underline">
              Nova instalação
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!deployment) {
    return <p className="p-6 text-sm text-slate-500">Carregando implantação…</p>;
  }

  const c = deployment.counts;
  const active = c.pending + c.running;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Cabeçalho: o que é, de quem, quando */}
      <section className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-6">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-slate-900">{deployment.name}</h2>
              <StatusBadge status={deployment.status} />
            </div>
            <p className="mt-1 text-sm text-slate-500">
              <span className="font-medium text-slate-700">{deployment.software.name}</span>{' '}
              <span className="font-mono">{deployment.software.version}</span>
              {' · '}
              solicitada por {deployment.requestedBy.displayName || deployment.requestedBy.username}
              {' · '}
              {formatDateTime(deployment.createdAt)}
              {deployment.finishedAt && <> · encerrada {formatDateTime(deployment.finishedAt)}</>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canCancel && c.pending > 0 && !confirmCancel && (
              <button
                type="button"
                onClick={() => setConfirmCancel(true)}
                className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
              >
                Cancelar pendentes ({c.pending})
              </button>
            )}
            <Link
              to="/deployments/new"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Nova instalação
            </Link>
          </div>
        </div>

        {confirmCancel && (
          <div
            role="alertdialog"
            aria-label="Confirmar cancelamento"
            className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
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

        {feedback && (
          <p
            role={feedback.kind === 'error' ? 'alert' : 'status'}
            className={`mt-4 rounded-lg px-3 py-2 text-sm ${
              feedback.kind === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'
            }`}
          >
            {feedback.text}
          </p>
        )}
      </section>

      {/* Contadores */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Counter label="Máquinas" value={c.total} />
        <Counter label="Em andamento" value={active} tone="blue" detail={c.pending > 0 ? `${c.pending} na fila` : undefined} />
        <Counter label="Concluídas" value={c.succeeded} tone="green" />
        <Counter
          label="Com falha"
          value={c.failed}
          tone="red"
          detail={c.cancelled > 0 ? `${plural(c.cancelled, 'cancelada', 'canceladas')}` : undefined}
        />
      </div>

      {/* Filtros + indicador de atualização */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Filtrar máquinas" className="flex flex-wrap gap-1 border-b border-slate-200">
          <Tab active={filter === 'all'} onClick={() => setFilter('all')}>Todas ({c.total})</Tab>
          <Tab active={filter === 'active'} onClick={() => setFilter('active')}>Em andamento ({active})</Tab>
          <Tab active={filter === 'succeeded'} onClick={() => setFilter('succeeded')}>Concluídas ({c.succeeded})</Tab>
          <Tab active={filter === 'failed'} onClick={() => setFilter('failed')}>Com falha ({c.failed})</Tab>
          {c.cancelled > 0 && (
            <Tab active={filter === 'cancelled'} onClick={() => setFilter('cancelled')}>Canceladas ({c.cancelled})</Tab>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs">
          {finished ? (
            <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-600">
              Implantação encerrada
            </span>
          ) : (
            <span
              data-testid="live-indicator"
              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
              Atualizando a cada 3 s
            </span>
          )}
          <button
            type="button"
            onClick={load}
            aria-label="Atualizar agora"
            title={lastUpdate ? `Atualizado às ${new Date(lastUpdate).toLocaleTimeString('pt-BR')}` : 'Atualizar agora'}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-200/60 hover:text-slate-700"
          >
            <RefreshIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {loadError && (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Falha ao atualizar ({loadError.message}). Tentando de novo a cada 3 s.
        </p>
      )}

      {/* Máquinas */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {visible.length === 0 ? (
          <p className="px-6 py-12 text-center text-sm text-slate-500">Nenhuma máquina neste filtro.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="w-10 px-3 py-3" aria-label="Expandir log" />
                  <th scope="col" className="px-4 py-3">Máquina</th>
                  <th scope="col" className="px-4 py-3">Fase</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3">Início</th>
                  <th scope="col" className="px-4 py-3">Tempo decorrido</th>
                  <th scope="col" className="px-4 py-3">Código de saída</th>
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

const STATUS_STYLE: Record<DeploymentStatus, { label: string; className: string; dot: string }> = {
  PENDING: { label: 'Aguardando', className: 'border-slate-200 bg-slate-50 text-slate-600', dot: 'bg-slate-400' },
  RUNNING: { label: 'Em andamento', className: 'border-blue-200 bg-blue-50 text-blue-700', dot: 'bg-blue-500' },
  SUCCEEDED: { label: 'Concluído', className: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  FAILED: { label: 'Falhou', className: 'border-red-200 bg-red-50 text-red-700', dot: 'bg-red-500' },
  CANCELLED: { label: 'Cancelado', className: 'border-slate-200 bg-slate-100 text-slate-500', dot: 'bg-slate-400' },
};

function StatusBadge({ status }: { status: DeploymentStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${s.className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden="true" />
      {s.label}
    </span>
  );
}

const PHASE_COLOR: Record<PhaseTone, string> = {
  waiting: 'text-slate-500',
  running: 'text-blue-700',
  success: 'text-emerald-700',
  warning: 'text-amber-700',
  danger: 'text-red-700',
  muted: 'text-slate-500',
};

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
      <tr onClick={onToggle} className={`cursor-pointer ${open ? 'bg-slate-50' : 'hover:bg-slate-50'}`}>
        <td className="px-3 py-3 text-slate-400">
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
        <td className="px-4 py-3 font-mono text-[13px] font-semibold whitespace-nowrap text-slate-900">{t.hostname}</td>
        <td className={`px-4 py-3 font-medium whitespace-nowrap ${PHASE_COLOR[phase.tone]}`} data-testid="phase">
          {phase.label}
        </td>
        <td className="px-4 py-3">
          <StatusBadge status={t.status} />
        </td>
        <td className="px-4 py-3 font-mono text-[13px] whitespace-nowrap text-slate-600">{formatTime(t.startedAt)}</td>
        <td className="px-4 py-3 font-mono text-[13px] whitespace-nowrap text-slate-600">
          {start !== null && end !== null ? formatDuration(end - start) : '—'}
        </td>
        <td className="px-4 py-3 font-mono text-[13px] whitespace-nowrap text-slate-600">{t.exitCode ?? '—'}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="bg-slate-50 px-4 pt-1 pb-4">
            <LogPanel deploymentId={deploymentId} target={t} phaseLabel={phase.label} />
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
function LogPanel({ deploymentId, target, phaseLabel }: { deploymentId: string; target: DeploymentTarget; phaseLabel: string }) {
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

  // Recarrega quando a linha recebe um passo novo (lastLog muda a cada polling da página)
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
      <p className="mb-2 text-xs font-medium text-slate-600">
        Log de instalação — <span className="font-mono">{target.hostname}</span>
        <span className="text-slate-400"> — {phaseLabel}</span>
      </p>
      <div
        ref={box}
        data-testid="log-panel"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="max-h-72 overflow-y-auto rounded-lg bg-slate-950 px-4 py-3 font-mono text-[12.5px] leading-relaxed"
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

function Counter({
  label,
  value,
  tone = 'slate',
  detail,
}: {
  label: string;
  value: number;
  tone?: 'slate' | 'blue' | 'green' | 'red';
  detail?: string;
}) {
  const color = { slate: 'text-slate-900', blue: 'text-blue-700', green: 'text-emerald-700', red: 'text-red-700' }[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
      <p className="text-xs font-medium text-slate-500">
        {label}
        {detail && <span className="text-slate-400"> · {detail}</span>}
      </p>
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
      className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${
        active ? 'border-blue-700 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** 102 000 ms → "1m 42s"; acima de uma hora, "1h 05m". */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
