import { useState } from 'react';
import { CheckCircleIcon, ChevronRightIcon, RefreshIcon } from '../../components/icons';
import { Tooltip, TooltipTarget } from '../../components/Tooltip';
import type { InventorySummary } from '../../types/inventory';
import { formatDateTime } from '../../utils/format';
import { OutsideCatalogBadge, VendorBadge } from './deploymentUi';
import { fromInventory, machinesToConsult, type UninstallTarget } from './uninstallTarget';
import { EmptyState, plural } from './wizardParts';

export interface ConsultProgress {
  running: boolean;
  done: number;
  total: number;
  failures: Array<{ hostname: string; message: string }>;
}

/** Regra para quem não é MSI (decisão da autora: exceção controlada). Vai na dica do título. */
export const OTHER_UNINSTALL_RULE =
  'Lista do software encontrado no inventário das máquinas selecionadas. MSI é removido pelo ' +
  'Windows Installer; programas que não são MSI, só pelo comando silencioso que o próprio programa ' +
  'declarou (QuietUninstallString), depois de conferido pelo sistema. O comando comum de ' +
  'desinstalação (UninstallString) nunca é executado.';


/**
 * Passo 2 em "Desinstalar": o software instalado nas máquinas selecionadas, a partir da
 * última consulta guardada de cada uma (RF08), agrupado, com quantas delas têm cada item.
 * Só aparece o que o sistema consegue desinstalar; o resto fica numa linha que expande.
 * Máquinas sem inventário ou com inventário antigo: aviso e "Consultar agora".
 */
export function UninstallChoices({
  summary,
  search,
  loadError,
  onRetry,
  consult,
  onConsultNow,
  selectedKey,
  onSelect,
}: {
  summary: InventorySummary | null;
  /** A busca do passo 2 ("Buscar software"). */
  search: string;
  loadError: string | null;
  onRetry: () => void;
  consult: ConsultProgress;
  onConsultNow: () => void;
  selectedKey: string | null;
  onSelect: (target: UninstallTarget) => void;
}) {
  const [showBlocked, setShowBlocked] = useState(false);
  const term = search.trim().toLowerCase();
  const matches = (...values: Array<string | null>) => !term || values.some((v) => v?.toLowerCase().includes(term));

  if (loadError) {
    return (
      <EmptyState title="Não foi possível carregar o software instalado." detail={loadError}>
        <button type="button" onClick={onRetry} className="text-body font-medium text-blue-700 hover:underline">
          Tentar de novo
        </button>
      </EmptyState>
    );
  }
  if (!summary) return <EmptyState title="Carregando o software instalado nas máquinas…" />;

  const canUninstall = (p: InventorySummary['products'][number]) => p.kind === 'MSI' || p.uninstall.available;
  const found = summary.products.filter((p) => matches(p.name, p.publisher, p.version, p.productCode));
  const products = found.filter(canUninstall);
  const blocked = found.filter((p) => !canUninstall(p));

  const total = summary.machines.length;
  const toConsult = machinesToConsult(summary);
  const missing = summary.machines.filter((m) => m.inventoryAt === null);
  const stale = summary.machines.filter((m) => m.stale);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {(missing.length > 0 || stale.length > 0 || consult.running || consult.failures.length > 0) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-body text-amber-900" data-testid="inventory-notice">
          {(missing.length > 0 || stale.length > 0) && (
            <p>
              {missing.length > 0 && <>{plural(missing.length, 'máquina sem inventário', 'máquinas sem inventário')}</>}
              {missing.length > 0 && stale.length > 0 && ' e '}
              {stale.length > 0 && (
                <>
                  {plural(stale.length, 'máquina', 'máquinas')} com inventário de mais de {summary.staleAfterDays} dias
                </>
              )}
              : a lista abaixo pode estar incompleta.
            </p>
          )}
          <ul className="mt-1.5 space-y-0.5 text-meta text-amber-800">
            {[...missing, ...stale].map((m) => (
              <li key={m.id}>
                <span className="font-mono">{m.hostname}</span> —{' '}
                {m.inventoryAt ? `consultada em ${formatDateTime(m.inventoryAt)}` : 'nunca consultada'}
              </li>
            ))}
          </ul>
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            {toConsult.length > 0 && (
              <button
                type="button"
                onClick={onConsultNow}
                disabled={consult.running}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-body font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60"
              >
                <RefreshIcon className={`h-4 w-4 ${consult.running ? 'animate-spin' : ''}`} />
                {consult.running ? 'Consultando…' : `Consultar agora (${toConsult.length})`}
              </button>
            )}
            {(consult.running || consult.total > 0) && (
              <span className="text-meta" data-testid="consult-progress">
                {consult.done} de {consult.total} consultadas
                {consult.failures.length > 0 && ` · ${plural(consult.failures.length, 'com falha', 'com falha')}`}
              </span>
            )}
          </div>
          {consult.failures.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-meta text-red-700" data-testid="consult-failures">
              {consult.failures.map((f) => (
                <li key={f.hostname}>
                  <span className="font-mono">{f.hostname}</span>: {f.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div role="radiogroup" aria-label="Software instalado" className="grid gap-2 lg:grid-cols-2" data-testid="installed-products">
        {products.length === 0 && (
          <p className="text-body text-slate-500 lg:col-span-2">
            {summary.products.length === 0
              ? 'Nenhum software no inventário das máquinas selecionadas.'
              : term
                ? 'Nenhum item corresponde à busca.'
                : 'Nenhum software destas máquinas pode ser desinstalado pelo sistema.'}
          </p>
        )}
        {products.map((p) => {
          const msi = p.kind === 'MSI';
          const target = fromInventory(p);
          const selected = target.key === selectedKey;
          return (
            <button
              key={p.key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelect(target)}
              data-product={p.name}
              className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left text-body transition-colors ${
                selected ? 'border-blue-500 bg-blue-50/70 ring-1 ring-blue-500' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block font-semibold break-words text-slate-900">{p.name}</span>
                <span className="block text-meta text-slate-500">
                  {[p.version, p.publisher].filter(Boolean).join(' · ') || '—'}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5 text-meta">
                  <span className="font-medium text-slate-700" data-testid="machine-count">
                    em {p.machineIds.length} de {plural(total, 'máquina', 'máquinas')}
                  </span>
                  {msi && (
                    <span className="rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 font-mono text-meta text-blue-700">
                      MSI
                    </span>
                  )}
                  {msi &&
                    (p.catalog ? (
                      <span className="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-meta font-medium text-emerald-800">
                        No catálogo
                      </span>
                    ) : (
                      <OutsideCatalogBadge />
                    ))}
                  {!msi && <VendorBadge />}
                </span>
              </span>
              {selected && <CheckCircleIcon className="h-5 w-5 shrink-0 text-blue-700" />}
            </button>
          );
        })}
      </div>

      {blocked.length > 0 && (
        <div data-testid="blocked-programs">
          <button
            type="button"
            onClick={() => setShowBlocked((v) => !v)}
            aria-expanded={showBlocked}
            className="inline-flex items-center gap-1 rounded-md text-meta text-slate-500 outline-none hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-blue-500/50"
          >
            <ChevronRightIcon className={`h-3.5 w-3.5 transition-transform ${showBlocked ? 'rotate-90' : ''}`} />
            {blocked.length === 1
              ? '1 programa não pode ser desinstalado pelo sistema'
              : `${blocked.length} programas não podem ser desinstalados pelo sistema`}
          </button>
          {showBlocked && (
            <ul className="mt-2 space-y-1 pl-5 text-meta text-slate-500">
              {blocked.map((p) => (
                <li key={p.key}>
                  <Tooltip content={p.uninstall.reason ?? 'O programa não declarou um comando de desinstalação silenciosa.'}>
                    <TooltipTarget data-testid="blocked-item">
                      {p.name}
                      {p.version && <span className="text-slate-400"> · {p.version}</span>}
                    </TooltipTarget>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
