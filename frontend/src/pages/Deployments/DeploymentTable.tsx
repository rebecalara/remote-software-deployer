import { Fragment, useEffect, useRef } from 'react';
import type { Deployment, DeploymentSummary } from '../../types/deployment';
import { formatDateTime } from '../../utils/format';
import { DeploymentPanel } from './DeploymentPanel';
import { ActionBadge, OutsideCatalogBadge, StatusBadge, VendorBadge, countsText, deploymentTarget, durationText } from './deploymentUi';

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
}: {
  items: DeploymentSummary[];
  openIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  highlightId?: string | null;
  now: number;
  onPanelUpdate?: (deployment: Deployment) => void;
  ariaLabel: string;
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
      <table className="w-full min-w-[880px] text-left text-sm" aria-label={ariaLabel}>
        <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase">
          <tr>
            <th scope="col" className="w-10 px-3 py-3" aria-label="Expandir" />
            <th scope="col" className="px-4 py-3">Implantação</th>
            <th scope="col" className="px-4 py-3">Máquinas</th>
            <th scope="col" className="px-4 py-3">Status</th>
            <th scope="col" className="px-4 py-3">Solicitada por</th>
            <th scope="col" className="px-4 py-3">Criada em</th>
            <th scope="col" className="px-4 py-3">Duração</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((d) => {
            const open = openIds.has(d.id);
            const highlighted = d.id === highlightId;
            return (
              <Fragment key={d.id}>
                <tr
                  data-deployment={d.id}
                  onClick={() => onToggle(d.id)}
                  className={`cursor-pointer ${highlighted ? 'bg-blue-50/70 shadow-[inset_3px_0_0_0_#1d4ed8]' : open ? 'bg-slate-50' : 'hover:bg-slate-50'}`}
                >
                  <td className="px-3 py-3 text-slate-400">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={`${open ? 'Recolher' : 'Expandir'} ${d.name}`}
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
                  </td>
                  <td className="px-4 py-3">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                      <span>{d.name}</span>
                      <ActionBadge action={d.action} />
                    </p>
                    <p className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                      <span>
                        {deploymentTarget(d).name} <span className="font-mono">{deploymentTarget(d).version}</span>
                      </span>
                      {d.vendorCommand ? <VendorBadge /> : !deploymentTarget(d).inCatalog && <OutsideCatalogBadge />}
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
