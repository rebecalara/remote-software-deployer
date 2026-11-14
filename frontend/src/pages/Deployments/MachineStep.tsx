import { useEffect, useMemo, useRef, useState } from 'react';
import { SearchIcon } from '../../components/icons';
import type { Machine } from '../../types/machine';
import { formatRelative } from '../../utils/format';
import { MissingFromAdBadge, StatusBadge } from '../Machines/MachineBadges';
import { EmptyState, StepCard } from './wizardParts';

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
 */
export function MachineStep({ machines, loadError, onRetry, selected, onChange, now }: MachineStepProps) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!machines) return [];
    if (!term) return machines;
    return machines.filter((m) =>
      [m.hostname, m.operatingSystem, m.department].some((v) => v?.toLowerCase().includes(term)),
    );
  }, [machines, search]);

  // "Selecionar todas" age só sobre as visíveis após a busca (e presentes no AD).
  const selectableVisible = filtered.filter((m) => m.seenInLastSync);
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((m) => selected.has(m.id));
  const someVisibleSelected = selectableVisible.some((m) => selected.has(m.id));

  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [someVisibleSelected, allVisibleSelected]);

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  function toggleAllVisible() {
    const next = new Set(selected);
    selectableVisible.forEach((m) => (allVisibleSelected ? next.delete(m.id) : next.add(m.id)));
    onChange(next);
  }

  return (
    <StepCard title="Selecionar máquinas de destino" subtitle="Selecione as máquinas onde o software será instalado.">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 sm:px-6">
        <label className="relative min-w-56 flex-1 sm:max-w-md">
          <span className="sr-only">Buscar máquinas</span>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, sistema ou setor"
            className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pr-3 pl-9 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          />
        </label>
        {machines && search.trim() !== '' && (
          <span className="text-xs text-slate-500">
            Mostrando {filtered.length} de {machines.length}
          </span>
        )}
      </div>

      {loadError ? (
        <EmptyState title="Não foi possível carregar as máquinas." detail={loadError}>
          <button type="button" onClick={onRetry} className="text-sm font-medium text-blue-700 hover:underline">
            Tentar de novo
          </button>
        </EmptyState>
      ) : machines === null ? (
        <EmptyState title="Carregando máquinas…" />
      ) : machines.length === 0 ? (
        <EmptyState
          title="Nenhuma máquina sincronizada ainda."
          detail='As máquinas vêm do AD: use "Sincronizar agora" na tela de Máquinas.'
        />
      ) : filtered.length === 0 ? (
        <EmptyState title="Nenhuma máquina corresponde à busca.">
          <button type="button" onClick={() => setSearch('')} className="text-sm font-medium text-blue-700 hover:underline">
            Limpar busca
          </button>
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase">
              <tr>
                <th scope="col" className="w-12 px-4 py-3 sm:pl-6">
                  <input
                    ref={headerCheckbox}
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    disabled={selectableVisible.length === 0}
                    aria-label="Selecionar todas as máquinas visíveis"
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
              {filtered.map((m) => {
                const selectable = m.seenInLastSync;
                const checked = selected.has(m.id);
                return (
                  <tr
                    key={m.id}
                    onClick={() => selectable && toggleOne(m.id)}
                    className={`transition-colors ${selectable ? 'cursor-pointer hover:bg-slate-50' : 'text-slate-400'} ${
                      checked ? 'bg-blue-50/60' : ''
                    }`}
                  >
                    <td className="px-4 py-3 sm:pl-6" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(m.id)}
                        disabled={!selectable}
                        title={selectable ? undefined : 'Máquina não encontrada no AD — não pode ser selecionada'}
                        aria-label={`Selecionar ${m.hostname}`}
                        className="h-4 w-4 rounded border-slate-300 accent-blue-600 disabled:cursor-not-allowed"
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-[13px] font-semibold whitespace-nowrap text-slate-900">
                      {m.hostname}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {m.operatingSystem ?? <span className="text-slate-400">—</span>}
                    </td>
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
              })}
            </tbody>
          </table>
        </div>
      )}
    </StepCard>
  );
}
