import { Fragment, useEffect, useRef } from 'react';
import type { Deployment, DeploymentSummary } from '../../types/deployment';
import { formatDateTime } from '../../utils/format';
import { DeploymentPanel } from './DeploymentPanel';
import { Tooltip } from '../../components/Tooltip';
import { DeploymentBadges, StatusBadge, deploymentTitle, durationText, partialHint } from './deploymentUi';

// Lista de implantações do Monitoramento e do Histórico. Cada linha expande ali mesmo
// (acordeão) e mostra o DeploymentPanel: máquinas, fases, logs e "Cancelar pendentes".
// A linha destacada (?open=<id> na URL) rola até a vista uma vez.

export function DeploymentTable({
  items,
  openIds,
  onToggle,
  highlightId,
  now,
  onPanelUpdate,
  ariaLabel,
  hideRequester = false,
}: {
  items: DeploymentSummary[];
  openIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  highlightId?: string | null;
  now: number;
  onPanelUpdate?: (deployment: Deployment) => void;
  ariaLabel: string;
  /** "Minhas implantações": quem pediu é sempre a própria pessoa — a coluna sai. */
  hideRequester?: boolean;
}) {
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightId || scrolled.current === highlightId) return;
    const row = document.querySelector(`[data-deployment="${highlightId}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      scrolled.current = highlightId;
    }
  }, [highlightId, items]);

  return (
    <div className="overflow-x-auto">
      {/* Abaixo de 1280 px, "Solicitada por" e "Criada em" saem (estão no painel ao abrir), para
          a tabela caber sem rolagem lateral. */}
      <table className="w-full text-left text-body xl:min-w-[880px]" aria-label={ariaLabel}>
        <thead className="border-b border-slate-200 bg-slate-50 text-meta font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase">
          <tr>
            <th scope="col" className="w-10 px-3 py-3" aria-label="Expandir" />
            <th scope="col" className="px-4 py-3">Implantação</th>
            <th scope="col" className="px-4 py-3">Máquinas</th>
            <th scope="col" className="px-4 py-3">Status</th>
            {!hideRequester && <th scope="col" className="hidden px-4 py-3 xl:table-cell">Solicitada por</th>}
            <th scope="col" className="hidden px-4 py-3 xl:table-cell">Criada em</th>
            <th scope="col" className="px-4 py-3">Duração</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((d) => {
            const open = openIds.has(d.id);
            const highlighted = d.id === highlightId;
            const { title, tip } = deploymentTitle(d);
            // A linha inteira é clicável (abre a implantação): nada dentro dela pode ser outro
            // botão. As dicas do título (versão e ProductCode, fora do catálogo) e do Parcial vão
            // para o botão de expandir — o elemento clicável da linha —, como descrição dele.
            const rowHint = [tip, d.status === 'PARTIAL' ? partialHint(d.counts) : null].filter(Boolean).join(' · ') || null;
            const expand = (
              <button
                type="button"
                aria-expanded={open}
                aria-label={`${open ? 'Recolher' : 'Expandir'} ${title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(d.id);
                }}
                className="flex h-6 w-6 items-center justify-center rounded hover:bg-slate-200/70"
              >
                <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true">
                  ›
                </span>
              </button>
            );
            return (
              <Fragment key={d.id}>
                <tr
                  data-deployment={d.id}
                  onClick={() => onToggle(d.id)}
                  className={`cursor-pointer ${highlighted ? 'bg-blue-50/70 shadow-[inset_3px_0_0_0_#1d4ed8]' : open ? 'bg-slate-50' : 'hover:bg-slate-50'}`}
                >
                  <td className="px-3 py-3 text-slate-400">{rowHint ? <Tooltip content={rowHint}>{expand}</Tooltip> : expand}</td>
                  <td className="px-4 py-3">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                      <span data-testid="deployment-title">{title}</span>
                      <DeploymentBadges deployment={d} />
                    </p>
                  </td>
                  {/* Só a quantidade; "N de M concluídas" fica na dica do Parcial e nas abas ao abrir. */}
                  <td className="px-4 py-3 text-slate-600 tabular-nums">{d.counts.total}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={d.status} counts={d.counts} hint={false} />
                  </td>
                  {!hideRequester && (
                    <td className="hidden px-4 py-3 whitespace-nowrap text-slate-600 xl:table-cell">
                      {d.requestedBy.displayName || d.requestedBy.username}
                    </td>
                  )}
                  <td className="hidden px-4 py-3 text-body whitespace-nowrap text-slate-600 xl:table-cell">
                    {formatDateTime(d.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-body whitespace-nowrap text-slate-600 tabular-nums">
                    {durationText(d.startedAt, d.finishedAt, now, d.finishedAt === null)}
                  </td>
                </tr>
                {open && (
                  <tr data-panel-for={d.id}>
                    <td colSpan={7} className={`px-4 pt-2 pb-4 ${highlighted ? 'bg-blue-50/40' : 'bg-slate-50/70'}`}>
                      <DeploymentPanel deploymentId={d.id} onUpdate={onPanelUpdate} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Linhas abertas: começa com o ?open=<id> da URL; abrir/fechar outras é estado local.
 * Fechar a linha do ?open tira o parâmetro da URL (replace), para o F5 não reabrir.
 */
export function toggleInSet(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
