import { useState } from 'react';
import { CheckCircleIcon, RefreshIcon, SearchIcon } from '../../components/icons';
import type { InventorySummary } from '../../types/inventory';
import { formatDateTime } from '../../utils/format';
import { OutsideCatalogBadge } from './deploymentUi';
import { fromInventory, machinesToConsult, type UninstallTarget } from './uninstallTarget';
import { EmptyState, plural } from './wizardParts';

export interface ConsultProgress {
  running: boolean;
  done: number;
  total: number;
  failures: Array<{ hostname: string; message: string }>;
}

/** Por que um item que não é MSI não pode ser desinstalado (decisão da autora). */
export const OTHER_NOT_UNINSTALLABLE =
  'Só MSI pode ser desinstalado: para os outros, o único caminho seria executar o comando de desinstalação ' +
  'gravado pelo próprio programa no registro, e o sistema não executa comandos que não sejam dele.';

/**
 * Passo 2 em "Desinstalar": o software instalado nas máquinas selecionadas, a partir da
 * última consulta guardada de cada uma (RF08), agrupado, com quantas delas têm cada item.
 * Máquinas sem inventário ou com inventário antigo: aviso e "Consultar agora".
 */
export function UninstallChoices({
  summary,
  loadError,
  onRetry,
  consult,
  onConsultNow,
  selectedKey,
  onSelect,
}: {
  summary: InventorySummary | null;
  loadError: string | null;
  onRetry: () => void;
  consult: ConsultProgress;
  onConsultNow: () => void;
  selectedKey: string | null;
  onSelect: (target: UninstallTarget) => void;
}) {
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  const matches = (...values: Array<string | null>) => !term || values.some((v) => v?.toLowerCase().includes(term));

  const products = (summary?.products ?? []).filter((p) => matches(p.name, p.publisher, p.version, p.productCode));

  if (loadError) {
    return (
      <EmptyState title="Não foi possível carregar o software instalado." detail={loadError}>
        <button type="button" onClick={onRetry} className="text-sm font-medium text-blue-700 hover:underline">
          Tentar de novo
        </button>
      </EmptyState>
    );
  }
  if (!summary) return <EmptyState title="Carregando o software instalado nas máquinas…" />;

  const total = summary.machines.length;
  const toConsult = machinesToConsult(summary);
  const missing = summary.machines.filter((m) => m.inventoryAt === null);
  const stale = summary.machines.filter((m) => m.stale);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {(missing.length > 0 || stale.length > 0 || consult.running || consult.failures.length > 0) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900" data-testid="inventory-notice">
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
          <ul className="mt-1.5 space-y-0.5 text-xs text-amber-800">
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
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60"
              >
                <RefreshIcon className={`h-4 w-4 ${consult.running ? 'animate-spin' : ''}`} />
                {consult.running ? 'Consultando…' : `Consultar agora (${toConsult.length})`}
              </button>
            )}
            {(consult.running || consult.total > 0) && (
              <span className="text-xs" data-testid="consult-progress">
                {consult.done} de {consult.total} consultadas
                {consult.failures.length > 0 && ` · ${plural(consult.failures.length, 'com falha', 'com falha')}`}
              </span>
            )}
          </div>
          {consult.failures.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-red-700" data-testid="consult-failures">
              {consult.failures.map((f) => (
                <li key={f.hostname}>
                  <span className="font-mono">{f.hostname}</span>: {f.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <label className="relative block sm:max-w-md">
        <span className="sr-only">Buscar no software instalado</span>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome, fabricante ou ProductCode"
          className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pr-3 pl-9 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
        />
      </label>

      <p className="text-xs text-slate-500">{OTHER_NOT_UNINSTALLABLE}</p>

      <div role="radiogroup" aria-label="Software instalado" className="grid gap-2 lg:grid-cols-2" data-testid="installed-products">
        {products.length === 0 && (
          <p className="text-sm text-slate-500 lg:col-span-2">
            {summary.products.length === 0 ? 'Nenhum software no inventário das máquinas selecionadas.' : 'Nenhum item corresponde à busca.'}
          </p>
        )}
        {products.map((p) => {
          const msi = p.kind === 'MSI';
          const target = msi ? fromInventory(p) : null;
          const selected = target !== null && target.key === selectedKey;
          return (
            <button
              key={p.key}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!msi}
              onClick={() => target && onSelect(target)}
              title={msi ? undefined : OTHER_NOT_UNINSTALLABLE}
              data-product={p.name}
              className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                selected
                  ? 'border-blue-500 bg-blue-50/70 ring-1 ring-blue-500'
                  : msi
                    ? 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                    : 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-60'
              }`}
            >
              <span
                className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] ${msi ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-500'}`}
              >
                {msi ? 'MSI' : 'Outro'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold break-words text-slate-900">{p.name}</span>
                <span className="block text-xs text-slate-500">
                  {[p.version, p.publisher].filter(Boolean).join(' · ') || '—'}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="font-medium text-slate-700" data-testid="machine-count">
                    em {p.machineIds.length} de {plural(total, 'máquina', 'máquinas')}
                  </span>
                  {msi && (p.catalog ? (
                    <span className="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800">
                      No catálogo
                    </span>
                  ) : (
                    <OutsideCatalogBadge />
                  ))}
                  {!msi && <span className="text-[11px] text-slate-500">não é MSI — não pode ser desinstalado</span>}
                </span>
              </span>
              {selected && <CheckCircleIcon className="h-5 w-5 shrink-0 text-blue-700" />}
            </button>
          );
        })}
      </div>

    </div>
  );
}
