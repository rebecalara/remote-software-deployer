import type { DeploymentAction, DeploymentCounts, DeploymentStatus, DeploymentSummary } from '../../types/deployment';

// Peças compartilhadas pelo painel de uma implantação (DeploymentPanel), pelo Monitoramento e
// pelo Histórico.

const STATUS_STYLE: Record<DeploymentStatus, { label: string; className: string; dot: string }> = {
  PENDING: { label: 'Aguardando', className: 'border-slate-200 bg-slate-50 text-slate-600', dot: 'bg-slate-400' },
  RUNNING: { label: 'Em andamento', className: 'border-blue-200 bg-blue-50 text-blue-700', dot: 'bg-blue-500' },
  SUCCEEDED: { label: 'Concluído', className: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  FAILED: { label: 'Falhou', className: 'border-red-200 bg-red-50 text-red-700', dot: 'bg-red-500' },
  CANCELLED: { label: 'Cancelado', className: 'border-slate-200 bg-slate-100 text-slate-500', dot: 'bg-slate-400' },
};

export const STATUS_LABEL: Record<DeploymentStatus, string> = Object.fromEntries(
  Object.entries(STATUS_STYLE).map(([k, v]) => [k, v.label]),
) as Record<DeploymentStatus, string>;

export function StatusBadge({ status }: { status: DeploymentStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${s.className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden="true" />
      {s.label}
    </span>
  );
}

export function Counter({
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

/** Indicador do polling: "Atualizando a cada 3 s" enquanto há algo em andamento. */
export function LiveIndicator({ live, idleText }: { live: boolean; idleText: string }) {
  return live ? (
    <span
      data-testid="live-indicator"
      className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
      Atualizando a cada 3 s
    </span>
  ) : (
    <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-600">{idleText}</span>
  );
}

/** "2 de 3 concluídas · 1 com falha · 1 na fila" — resumo das máquinas de uma implantação. */
export function countsText(c: DeploymentCounts): string {
  const parts = [`${c.succeeded} de ${c.total} ${c.total === 1 ? 'concluída' : 'concluídas'}`];
  if (c.running > 0) parts.push(`${c.running} em andamento`);
  if (c.pending > 0) parts.push(`${c.pending} na fila`);
  if (c.failed > 0) parts.push(`${c.failed} com falha`);
  if (c.cancelled > 0) parts.push(`${c.cancelled} ${c.cancelled === 1 ? 'cancelada' : 'canceladas'}`);
  return parts.join(' · ');
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** 102 000 ms → "1m 42s"; acima de uma hora, "1h 05m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Duração entre dois instantes; sem fim e ainda em andamento, até agora. */
export function durationText(startIso: string | null, endIso: string | null, now: number, running: boolean): string {
  if (!startIso) return '—';
  const end = endIso ? new Date(endIso).getTime() : running ? now : null;
  return end === null ? '—' : formatDuration(end - new Date(startIso).getTime());
}

/** O que a implantação instala ou remove: software do catálogo ou, fora dele, o produto. */
export function deploymentTarget(d: Pick<DeploymentSummary, 'software' | 'product'>): {
  name: string;
  version: string | null;
  inCatalog: boolean;
} {
  if (d.software) return { name: d.software.name, version: d.software.version, inCatalog: true };
  return { name: d.product?.name ?? '—', version: d.product?.version ?? null, inCatalog: false };
}

/** Selo para produto desinstalado que não está no catálogo. */
export function OutsideCatalogBadge() {
  return (
    <span className="inline-flex rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-amber-800">
      Fora do catálogo
    </span>
  );
}

/** Selo "Instalação" / "Desinstalação" (Monitoramento, Histórico, Dashboard). */
export function ActionBadge({ action }: { action: DeploymentAction }) {
  return action === 'UNINSTALL' ? (
    <span className="inline-flex rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-violet-700">
      Desinstalação
    </span>
  ) : (
    <span className="inline-flex rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-slate-600">
      Instalação
    </span>
  );
}

/** Por que um EXE não tem desinstalação — mesmo texto do 409 do backend. */
export const EXE_UNINSTALL_UNAVAILABLE =
  'A desinstalação remota está disponível só para MSI: um EXE não traz um código de produto confiável, ' +
  'e cada família de instalador desinstala de um jeito.';

/**
 * Alternador "Todas / Minhas implantações" (Histórico e Monitoramento). "Minhas" vira
 * ?mine=true na API; quem é "eu" o backend tira do token, nunca da tela.
 */
export function MineToggle({ mine, onChange }: { mine: boolean; onChange: (mine: boolean) => void }) {
  const option = (value: boolean, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mine === value}
      onClick={() => mine !== value && onChange(value)}
      className={`rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap ${
        mine === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="radiogroup" aria-label="Quais implantações mostrar" className="inline-flex rounded-lg bg-slate-100 p-1">
      {option(false, 'Todas')}
      {option(true, 'Minhas implantações')}
    </div>
  );
}
