import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ListPagination } from '../../components/ListPagination';
import { SearchIcon } from '../../components/icons';
import { usePagedList } from '../../hooks/usePagedList';
import type { Machine } from '../../types/machine';
import { formatRelative } from '../../utils/format';
import { MissingFromAdBadge, StatusBadge } from '../Machines/MachineBadges';
import { EmptyState, StepCard } from './wizardParts';

/** Máquinas por página (mesmo valor da tela de Máquinas). */
const PAGE_SIZE = 100;
const ALL = 'all';
const NO_DEPARTMENT = '__none__';

interface MachineStepProps {
  machines: Machine[] | null;
  loadError: string | null;
  onRetry: () => void;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  now: number;
}

/**
 * Passo 1: mesmas colunas e status da tela de Máquinas (só dado real: sem IP, sem
 * Online/Ocupado). Máquina que saiu do AD aparece, mas não pode ser selecionada.
 * Com muitas máquinas: busca adiada, linhas memorizadas e páginas de 100 (como em Máquinas).
 */
export function MachineStep({ machines, loadError, onRetry, selected, onChange, now }: MachineStepProps) {
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [department, setDepartment] = useState(ALL);

  // Setores: o mesmo filtro da tela de Máquinas.
  const departments = useMemo(
    () =>
      [...new Set((machines ?? []).map((m) => m.department).filter((d): d is string => d !== null))].sort((a, b) =>
        a.localeCompare(b, 'pt-BR'),
      ),
    [machines],
  );
  const hasNoDepartment = (machines ?? []).some((m) => m.department === null);

  const filtered = useMemo(() => {
    const term = deferredSearch.trim().toLowerCase();
    if (!machines) return [];
    return machines.filter((m) => {
      if (department === NO_DEPARTMENT && m.department !== null) return false;
      if (department !== ALL && department !== NO_DEPARTMENT && m.department !== department) return false;
      return !term || [m.hostname, m.operatingSystem, m.department].some((v) => v?.toLowerCase().includes(term));
    });
  }, [machines, deferredSearch, department]);
  const paged = usePagedList(filtered, PAGE_SIZE, `${deferredSearch}|${department}`);
  const filtersActive = search.trim() !== '' || department !== ALL;

  // "Selecionar todas" vale para as máquinas visíveis no filtro (de todas as páginas) e
  // presentes no AD; as já marcadas fora do filtro continuam marcadas.
  const selectableVisible = useMemo(() => filtered.filter((m) => m.seenInLastSync), [filtered]);
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((m) => selected.has(m.id));
  const someVisibleSelected = selectableVisible.some((m) => selected.has(m.id));

  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [someVisibleSelected, allVisibleSelected]);

  // Estável (lê a seleção atual por ref): com React.memo, marcar uma máquina redesenha só a linha dela.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const toggleOne = useCallback(
    (id: string) => {
      const next = new Set(selectedRef.current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange(next);
    },
    [onChange],
  );

  function toggleAllVisible() {
    const next = new Set(selected);
    selectableVisible.forEach((m) => (allVisibleSelected ? next.delete(m.id) : next.add(m.id)));
    onChange(next);
  }

  return (
    <StepCard title="Selecionar máquinas de destino">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 sm:px-6">
        <label className="relative min-w-56 flex-1 sm:max-w-md">
          <span className="sr-only">Buscar máquina</span>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar máquina"
            className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pr-3 pl-9 text-body outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          />
        </label>
        <select
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          aria-label="Filtrar por setor"
          className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-body outline-none focus:border-blue-500 sm:flex-none"
        >
          <option value={ALL}>Todos os setores</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
          {hasNoDepartment && <option value={NO_DEPARTMENT}>Sem setor</option>}
        </select>
        {machines && filtersActive && (
          <span className="text-meta text-slate-500" data-testid="filter-count">
            Mostrando {filtered.length} de {machines.length}
          </span>
        )}
      </div>

      {loadError ? (
        <EmptyState title="Não foi possível carregar as máquinas." detail={loadError}>
          <button type="button" onClick={onRetry} className="text-body font-medium text-blue-700 hover:underline">
            Tentar de novo
          </button>
        </EmptyState>
      ) : machines === null ? (
        <EmptyState title="Carregando máquinas…" />
      ) : machines.length === 0 ? (
        <EmptyState
          title="Nenhuma máquina sincronizada ainda."
          detail='As máquinas vêm do AD: use "Sincronizar com o AD" na tela de Máquinas.'
        />
      ) : filtered.length === 0 ? (
        <EmptyState title="Nenhuma máquina corresponde à busca e ao filtro.">
          <button
            type="button"
            onClick={() => {
              setSearch('');
              setDepartment(ALL);
            }}
            className="text-body font-medium text-blue-700 hover:underline"
          >
            Limpar filtros
          </button>
        </EmptyState>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-body">
              <thead className="border-b border-slate-200 bg-slate-50 text-meta font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="w-12 px-4 py-3 sm:pl-6">
                    <input
                      ref={headerCheckbox}
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      disabled={selectableVisible.length === 0}
                      aria-label={`Selecionar as ${selectableVisible.length} máquinas visíveis no filtro`}
                      title={`Selecionar as ${selectableVisible.length} máquinas visíveis no filtro (de todas as páginas); as já marcadas fora dele continuam marcadas`}
                      className="h-4 w-4 rounded border-slate-300 accent-blue-600"
                    />
                  </th>
                  <th scope="col" className="px-4 py-3">Nome</th>
                  <th scope="col" className="px-4 py-3">Sistema operacional</th>
                  <th scope="col" className="px-4 py-3">Setor</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3">Confirmada no AD</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paged.pageItems.map((m) => (
                  <StepRow key={m.id} machine={m} checked={selected.has(m.id)} now={now} onToggle={toggleOne} />
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > PAGE_SIZE && (
            <div className="border-t border-slate-100 px-4 py-3 sm:px-6">
              <ListPagination {...paged} onPage={paged.setPage} label="Páginas de máquinas" />
            </div>
          )}
        </>
      )}
    </StepCard>
  );
}

// Memorizada: só redesenha a linha cujas props mudaram (marcar uma máquina).
const StepRow = memo(function StepRow({
  machine: m,
  checked,
  now,
  onToggle,
}: {
  machine: Machine;
  checked: boolean;
  now: number;
  onToggle: (id: string) => void;
}) {
  const selectable = m.seenInLastSync;
  return (
    <tr
      onClick={() => selectable && onToggle(m.id)}
      className={`transition-colors ${selectable ? 'cursor-pointer hover:bg-slate-50' : 'text-slate-400'} ${checked ? 'bg-blue-50/60' : ''}`}
    >
      <td className="px-4 py-3 sm:pl-6" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(m.id)}
          disabled={!selectable}
          title={selectable ? undefined : 'Máquina não encontrada no AD — não pode ser selecionada'}
          aria-label={`Selecionar ${m.hostname}`}
          className="h-4 w-4 rounded border-slate-300 accent-blue-600 disabled:cursor-not-allowed"
        />
      </td>
      <td className="px-4 py-3 font-mono text-body font-semibold whitespace-nowrap text-slate-900">{m.hostname}</td>
      <td className="px-4 py-3 whitespace-nowrap">{m.operatingSystem ?? <span className="text-slate-400">—</span>}</td>
      <td className="px-4 py-3 whitespace-nowrap">{m.department ?? <span className="text-slate-400">—</span>}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1.5">
          <StatusBadge status={m.status} />
          {!m.seenInLastSync && <MissingFromAdBadge />}
        </div>
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-slate-500">{formatRelative(m.lastSync, now)}</td>
    </tr>
  );
});
