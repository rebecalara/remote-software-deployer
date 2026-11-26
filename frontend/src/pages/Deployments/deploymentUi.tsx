import { Tooltip, TooltipTarget } from '../../components/Tooltip';
import type { DeploymentAction, DeploymentCounts, DeploymentDisplayStatus, DeploymentSummary } from '../../types/deployment';

// Peças compartilhadas pelo painel de uma implantação (DeploymentPanel), pelo Monitoramento e
// pelo Histórico.

const STATUS_STYLE: Record<DeploymentDisplayStatus, { label: string; className: string; dot: string }> = {
  PENDING: { label: 'Aguardando', className: 'border-slate-200 bg-slate-50 text-slate-600', dot: 'bg-slate-400' },
  RUNNING: { label: 'Em andamento', className: 'border-blue-200 bg-blue-50 text-blue-700', dot: 'bg-blue-500' },
  SUCCEEDED: { label: 'Concluído', className: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  // Parcial: alguma máquina concluiu e alguma falhou (calculado no backend). Falhou: nenhuma concluiu.
  PARTIAL: { label: 'Parcial', className: 'border-amber-200 bg-amber-50 text-amber-800', dot: 'bg-amber-500' },
  FAILED: { label: 'Falhou', className: 'border-red-200 bg-red-50 text-red-700', dot: 'bg-red-500' },
  CANCELLED: { label: 'Cancelado', className: 'border-slate-200 bg-slate-100 text-slate-500', dot: 'bg-slate-400' },
};

export const STATUS_LABEL: Record<DeploymentDisplayStatus, string> = Object.fromEntries(
  Object.entries(STATUS_STYLE).map(([k, v]) => [k, v.label]),
) as Record<DeploymentDisplayStatus, string>;

/**
 * Selo do status da implantação. "Parcial" traz a dica "N de M máquinas concluídas; veja as
 * falhas" (precisa de `counts`), num botão nativo. `hint={false}`: só o selo, sem dica nem
 * foco — para quando ele está dentro de uma linha clicável (a dica vai para o botão da linha).
 */
export function StatusBadge({
  status,
  counts,
  hint = true,
}: {
  status: DeploymentDisplayStatus;
  counts?: Pick<DeploymentCounts, 'succeeded' | 'total'>;
  hint?: boolean;
}) {
  const s = STATUS_STYLE[status];
  const badge = (
    <span
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-meta font-medium whitespace-nowrap ${s.className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden="true" />
      {s.label}
    </span>
  );
  if (status !== 'PARTIAL' || !counts || !hint) return badge;
  return (
    <Tooltip content={partialHint(counts)}>
      <TooltipTarget className="flex">{badge}</TooltipTarget>
    </Tooltip>
  );
}

/** "1 de 3 máquinas concluídas; veja as falhas" */
export function partialHint(c: Pick<DeploymentCounts, 'succeeded' | 'total'>): string {
  return `${c.succeeded} de ${c.total} ${c.total === 1 ? 'máquina concluída' : 'máquinas concluídas'}; veja as falhas`;
}

/**
 * "Atualizando a cada 3 s": só aparece enquanto há algo em andamento (e o polling está ligado).
 * Sem nada rodando, não aparece — a lista vazia já diz isso.
 */
export function LiveIndicator() {
  return (
    <span
      data-testid="live-indicator"
      className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
      Atualizando a cada 3 s
    </span>
  );
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Duração legível: "4 s", "1 min 5 s", "1 h 2 min" (zeros à direita omitidos: "1 min", "1 h"). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return s > 0 ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}

/** Duração entre dois instantes; sem fim e ainda em andamento, até agora. */
export function durationText(startIso: string | null, endIso: string | null, now: number, running: boolean): string {
  if (!startIso) return '—';
  const end = endIso ? new Date(endIso).getTime() : running ? now : null;
  return end === null ? '—' : formatDuration(end - new Date(startIso).getTime());
}

/**
 * Título curto da implantação: "7-Zip 26.06" (nome + versão do catálogo). Fora do catálogo, o
 * nome do produto como está no inventário; versão e ProductCode vão para a dica (`tip`).
 * A ação (instalar/desinstalar) não entra: fica só no selo.
 */
export function deploymentTitle(d: Pick<DeploymentSummary, 'software' | 'product'>): { title: string; tip: string | null } {
  if (d.software) return { title: `${d.software.name} ${d.software.version}`, tip: null };
  const p = d.product;
  const tip = [p?.version && `Versão ${p.version}`, p?.productCode && `ProductCode ${p.productCode}`].filter(Boolean).join(' · ');
  return { title: p?.name ?? '—', tip: tip || null };
}

/** Selo para produto desinstalado que não está no catálogo. */
export function OutsideCatalogBadge() {
  return (
    <span className="inline-flex rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-meta font-medium whitespace-nowrap text-amber-800">
      Fora do catálogo
    </span>
  );
}

/** Selo para desinstalação pelo comando do fabricante (programa que não é MSI). */
export function VendorBadge() {
  return (
    <span className="inline-flex rounded-md border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-meta font-medium whitespace-nowrap text-orange-800">
      Comando do fabricante
    </span>
  );
}

/**
 * Selos da implantação nas listas (Monitoramento, Histórico, Dashboard): só o que foge da
 * instalação comum — "Desinstalação", "Fora do catálogo", "Comando do fabricante". Uma
 * instalação do catálogo não ganha selo.
 */
export function DeploymentBadges({ deployment: d }: { deployment: Pick<DeploymentSummary, 'action' | 'software' | 'vendorCommand'> }) {
  return (
    <>
      {d.action === 'UNINSTALL' && <ActionBadge action="UNINSTALL" />}
      {d.vendorCommand ? <VendorBadge /> : !d.software && <OutsideCatalogBadge />}
    </>
  );
}

/** Selo "Instalação" / "Desinstalação". */
export function ActionBadge({ action }: { action: DeploymentAction }) {
  return action === 'UNINSTALL' ? (
    <span className="inline-flex rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-meta font-medium whitespace-nowrap text-violet-700">
      Desinstalação
    </span>
  ) : (
    <span className="inline-flex rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-meta font-medium whitespace-nowrap text-slate-600">
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
      className={`rounded-md px-3 py-1.5 text-body font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
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
