import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { InfoIcon, RefreshIcon, SearchIcon } from '../../components/icons';
import { Tooltip, TooltipTarget } from '../../components/Tooltip';
import { SessionExpiredError } from '../../services/apiClient';
import { collectInventory, getInventory } from '../../services/inventoryService';
import type { InventoryItem, InventoryState } from '../../types/inventory';
import type { Machine } from '../../types/machine';
import { formatDateTime, formatRelative } from '../../utils/format';
import type { NewDeploymentLocationState } from '../Deployments/NewDeploymentPage';

// RF08: software instalado na máquina. A consulta é AO VIVO pelo WinRM (só leitura, só
// ADMIN/OPERATOR) e a última consulta bem-sucedida fica guardada, com data e quem
// consultou — por isso a lista é uma foto daquele momento, não o estado de agora.
// Regra da tela: mostra o dado; a explicação fica na dica (Tooltip acessível).

const ABOUT_LIST = 'Lidos das chaves Uninstall do registro (64 e 32 bits). Programas instalados só para um usuário não aparecem.';
/** Elementos sem foco próprio que ganham dica: recebem foco pelo teclado. */
const ICON_BUTTON =
  'rounded-md p-1 text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-blue-500/50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

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

  const inventory = state?.inventory ?? null;
  const items = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = inventory?.items ?? [];
    return term ? list.filter((i) => [i.name, i.version].some((v) => v?.toLowerCase().includes(term))) : list;
  }, [inventory, search]);

  const blockedReason = !state
    ? null
    : !state.collectAvailable
      ? `Consulta indisponível neste servidor: ${state.collectUnavailableReason}`
      : !machine.seenInLastSync
        ? 'A máquina não apareceu na última sincronização com o AD.'
        : null;

  async function collect() {
    // aria-disabled (e não disabled) mantém o botão focável, para a dica com o motivo
    // continuar acessível pelo teclado — então o bloqueio é conferido aqui.
    if (collecting || blockedReason) return;
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

  /** Atalho: MSI pelo ProductCode; programa (não MSI) pelo id do comando do fabricante. */
  function uninstall(item: InventoryItem) {
    if (!item.uninstall.available) return;
    navigate('/deployments/new', {
      state: {
        machineIds: [machine.id],
        ...(item.productCode ? { productCode: item.productCode } : { programId: item.uninstall.programId! }),
        action: 'UNINSTALL',
        startAtReview: true,
      } satisfies NewDeploymentLocationState,
    });
  }

  const collectHint = blockedReason
    ? blockedReason
    : collecting
      ? 'Consultando a máquina… pode levar até 2 minutos se ela demorar a responder.'
      : inventory
        ? 'Consultar de novo o software instalado'
        : 'Consultar o software instalado (lê a máquina ao vivo, sem alterar nada nela)';
  const canUninstall = canCollect && machine.seenInLastSync;

  return (
    <section className="mt-6 border-t border-slate-100 pt-5" aria-labelledby="inventory-title" data-testid="inventory">
      <div className="flex items-center gap-1">
        <h3 id="inventory-title" className="text-section font-semibold text-slate-900">
          Software instalado
        </h3>
        <Tooltip content={ABOUT_LIST}>
          <button type="button" aria-label="Sobre esta lista" className={ICON_BUTTON} data-testid="inventory-about">
            <InfoIcon className="h-4 w-4" />
          </button>
        </Tooltip>
        {canCollect && state && (
          <span className="ml-auto">
            <Tooltip content={collectHint} align="end" asLabel>
              <button
                type="button"
                onClick={collect}
                aria-disabled={collecting || blockedReason !== null}
                className={ICON_BUTTON}
                data-testid="inventory-collect"
              >
                <RefreshIcon className={`h-4 w-4 ${collecting ? 'animate-spin' : ''}`} />
              </button>
            </Tooltip>
          </span>
        )}
      </div>

      {loadError && <p className="mt-1 text-meta text-red-700">Não foi possível carregar: {loadError}</p>}

      <p className="mt-0.5 text-meta text-slate-500" data-testid="inventory-meta" aria-live="polite">
        {collecting ? (
          'Consultando a máquina…'
        ) : inventory ? (
          <Tooltip content={`Consultado em ${formatDateTime(inventory.collectedAt)} por ${inventory.collectedBy.displayName || inventory.collectedBy.username}`}>
            <TooltipTarget>Atualizado {formatRelative(inventory.collectedAt, now)}</TooltipTarget>
          </Tooltip>
        ) : state ? (
          'Ainda não consultado'
        ) : null}
      </p>

      {collectError && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-meta text-red-700" data-testid="inventory-error">
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
                placeholder="Buscar programa"
                className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pr-2 pl-8 text-meta outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              />
            </label>
          )}
          <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200" data-testid="inventory-list">
            {items.map((item) => {
              const sub = [item.version, formatDay(item.installDate) && `instalado em ${formatDay(item.installDate)}`].filter(Boolean).join(' · ');
              const showUninstall = canUninstall && item.uninstall.available;
              return (
                <li key={`${item.name}|${item.version}|${item.productCode}`} className="px-3 py-2.5 text-meta" data-item={item.name}>
                  {item.productCode ? (
                    <Tooltip content={`ProductCode ${item.productCode}`}>
                      <TooltipTarget className="block font-semibold break-words text-slate-900" data-testid="item-name">
                        {item.name}
                      </TooltipTarget>
                    </Tooltip>
                  ) : (
                    <span className="block font-semibold break-words text-slate-900" data-testid="item-name">
                      {item.name}
                    </span>
                  )}
                  {sub && <span className="block text-slate-500">{sub}</span>}
                  {(item.productCode || item.catalog || showUninstall) && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {item.productCode && (
                        <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 font-mono text-meta text-blue-700" data-testid="msi-badge">
                          MSI
                        </span>
                      )}
                      {item.catalog && (
                        <Tooltip content={`${item.catalog.name} ${item.catalog.version} no catálogo${item.catalog.active ? '' : ' (desativado)'}`}>
                          <TooltipTarget
                            className="border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-meta font-medium text-emerald-800"
                            data-testid="catalog-badge"
                          >
                            No catálogo
                          </TooltipTarget>
                        </Tooltip>
                      )}
                      {showUninstall &&
                        (item.productCode ? (
                          <button
                            type="button"
                            onClick={() => uninstall(item)}
                            className="rounded-md border border-violet-200 bg-white px-2 py-0.5 text-meta font-medium text-violet-700 hover:bg-violet-50"
                          >
                            Desinstalar
                          </button>
                        ) : (
                          <Tooltip content="Pelo comando do fabricante">
                            <button
                              type="button"
                              onClick={() => uninstall(item)}
                              className="rounded-md border border-violet-200 bg-white px-2 py-0.5 text-meta font-medium text-violet-700 hover:bg-violet-50"
                            >
                              Desinstalar
                            </button>
                          </Tooltip>
                        ))}
                    </div>
                  )}
                </li>
              );
            })}
            {items.length === 0 && <li className="px-3 py-3 text-meta text-slate-500">Nenhum item corresponde à busca.</li>}
          </ul>
        </>
      )}
    </section>
  );
}
