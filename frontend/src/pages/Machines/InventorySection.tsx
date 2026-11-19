import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshIcon, SearchIcon } from '../../components/icons';
import { SessionExpiredError } from '../../services/apiClient';
import { collectInventory, getInventory } from '../../services/inventoryService';
import type { InventoryItem, InventoryState } from '../../types/inventory';
import type { Machine } from '../../types/machine';
import { formatDateTime, formatRelative } from '../../utils/format';
import type { NewDeploymentLocationState } from '../Deployments/NewDeploymentPage';

// RF08: software instalado na máquina. A consulta é AO VIVO pelo WinRM (só leitura, só
// ADMIN/OPERATOR) e a última consulta bem-sucedida fica guardada, com data e quem
// consultou — por isso a lista é uma foto daquele momento, não o estado de agora.

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado.';
}

/** "2026-11-19" → "19/11/2026" (sem passar por Date: evita voltar um dia pelo fuso). */
function formatDay(day: string | null): string | null {
  if (!day) return null;
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

export function InventorySection({ machine, canCollect, now }: { machine: Machine; canCollect: boolean; now: number }) {
  const navigate = useNavigate();
  const [state, setState] = useState<InventoryState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [collectError, setCollectError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    try {
      setState(await getInventory(machine.id));
      setLoadError(null);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setLoadError(messageOf(err));
    }
  }, [machine.id]);

  useEffect(() => {
    setState(null);
    setCollectError(null);
    setSearch('');
    void load();
  }, [load]);

  async function collect() {
    setCollecting(true);
    setCollectError(null);
    try {
      const inventory = await collectInventory(machine.id);
      setState((s) => (s ? { ...s, inventory } : s));
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setCollectError(messageOf(err));
    } finally {
      setCollecting(false);
    }
  }

  const inventory = state?.inventory ?? null;
  const items = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = inventory?.items ?? [];
    return term ? list.filter((i) => [i.name, i.publisher, i.version].some((v) => v?.toLowerCase().includes(term))) : list;
  }, [inventory, search]);

  const blockedReason = !state
    ? null
    : !state.collectAvailable
      ? `Consulta indisponível neste servidor: ${state.collectUnavailableReason}`
      : !machine.seenInLastSync
        ? 'A máquina não apareceu na última sincronização com o AD.'
        : null;

  function uninstall(item: InventoryItem) {
    if (!item.catalog) return;
    navigate('/deployments/new', {
      state: {
        machineIds: [machine.id],
        softwareId: item.catalog.softwareId,
        action: 'UNINSTALL',
        startAtReview: true,
      } satisfies NewDeploymentLocationState,
    });
  }

  return (
    <section className="mt-6 border-t border-slate-100 pt-5" aria-label="Software instalado" data-testid="inventory">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Software instalado</h3>
        {inventory && !collecting && (
          <span className="text-xs text-slate-500">{inventory.items.length} itens</span>
        )}
      </div>

      {loadError && <p className="mt-2 text-xs text-red-700">Não foi possível carregar: {loadError}</p>}

      {inventory ? (
        <p className="mt-1 text-xs text-slate-500" data-testid="inventory-meta">
          Consultado em {formatDateTime(inventory.collectedAt)} ({formatRelative(inventory.collectedAt, now)}) por{' '}
          {inventory.collectedBy.displayName || inventory.collectedBy.username}. Lista do momento da consulta.
        </p>
      ) : (
        state && <p className="mt-1 text-xs text-slate-500">Ainda não consultado. A consulta lê a máquina ao vivo, sem alterar nada nela.</p>
      )}

      {canCollect && state && (
        <div className="mt-3">
          <button
            type="button"
            onClick={collect}
            disabled={collecting || blockedReason !== null}
            title={blockedReason ?? undefined}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshIcon className={`h-4 w-4 ${collecting ? 'animate-spin' : ''}`} />
            {collecting ? 'Consultando a máquina…' : inventory ? 'Consultar de novo' : 'Consultar softwares instalados'}
          </button>
          {blockedReason && <p className="mt-1.5 text-xs text-slate-500" data-testid="inventory-blocked">{blockedReason}</p>}
          {collecting && <p className="mt-1.5 text-xs text-slate-500">Pode levar até 2 minutos se a máquina demorar a responder.</p>}
        </div>
      )}

      {collectError && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700" data-testid="inventory-error">
          {collectError}
          {inventory && <span className="block text-red-600/80">A lista abaixo é da consulta anterior.</span>}
        </p>
      )}

      {inventory && inventory.items.length > 0 && (
        <>
          {inventory.items.length > 6 && (
            <label className="relative mt-3 block">
              <span className="sr-only">Buscar no software instalado</span>
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nome ou fabricante"
                className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pr-2 pl-8 text-xs outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              />
            </label>
          )}
          <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200" data-testid="inventory-list">
            {items.map((item) => (
              <li key={`${item.name}|${item.version}|${item.productCode}`} className="px-3 py-2.5 text-xs" data-item={item.name}>
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold break-words text-slate-900">{item.name}</span>
                    <span className="block text-slate-500">
                      {[item.version && <span key="v" className="font-mono">{item.version}</span>, item.publisher, formatDay(item.installDate) && `instalado em ${formatDay(item.installDate)}`, item.arch === '32' ? '32 bits' : null]
                        .filter(Boolean)
                        .map((part, i) => (
                          <span key={i}>
                            {i > 0 && ' · '}
                            {part}
                          </span>
                        ))}
                    </span>
                    {item.productCode && (
                      <span className="mt-0.5 block font-mono text-[11px] break-all text-slate-400">{item.productCode}</span>
                    )}
                  </span>
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] ${item.productCode ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}
                  >
                    {/* Sem ProductCode não dá para dizer o tipo (EXE, componente do Windows…). */}
                    {item.productCode ? 'MSI' : 'Outro'}
                  </span>
                </div>
                {item.catalog && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span
                      className="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800"
                      data-testid="catalog-badge"
                    >
                      No catálogo: {item.catalog.name} {item.catalog.version}
                      {!item.catalog.active && ' (desativado)'}
                    </span>
                    {canCollect && machine.seenInLastSync && item.catalog.uninstallAvailable && (
                      <button
                        type="button"
                        onClick={() => uninstall(item)}
                        className="rounded-md border border-violet-200 bg-white px-2 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-50"
                      >
                        Desinstalar
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
            {items.length === 0 && <li className="px-3 py-3 text-xs text-slate-500">Nenhum item corresponde à busca.</li>}
          </ul>
          <p className="mt-2 text-[11px] text-slate-400">
            Lidos das chaves Uninstall do registro (64 e 32 bits). Programas instalados só para um usuário não aparecem.
          </p>
        </>
      )}
    </section>
  );
}
