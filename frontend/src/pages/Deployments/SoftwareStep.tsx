import { useMemo, useState } from 'react';
import { CheckCircleIcon, SearchIcon } from '../../components/icons';
import type { Software } from '../../types/software';
import { formatBytes } from '../../utils/format';
import { EmptyState, StepCard, TypeBadge } from './wizardParts';

interface SoftwareStepProps {
  software: Software[] | null;
  loadError: string | null;
  onRetry: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Passo 2: UM software por implantação (o backend recebe um softwareId). Lista só os
 * ativos; os que ainda não têm instalador aparecem, mas não podem ser escolhidos.
 */
export function SoftwareStep({ software, loadError, onRetry, selectedId, onSelect }: SoftwareStepProps) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = [...(software ?? [])].sort(
      (a, b) => Number(b.installer !== null) - Number(a.installer !== null) || a.name.localeCompare(b.name, 'pt-BR'),
    );
    if (!term) return list;
    return list.filter((s) => [s.name, s.version, s.vendor].some((v) => v?.toLowerCase().includes(term)));
  }, [software, search]);

  return (
    <StepCard title="Selecionar software para implantar" subtitle="Escolha um software do catálogo.">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 sm:px-6">
        <label className="relative min-w-56 flex-1 sm:max-w-md">
          <span className="sr-only">Buscar software</span>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, versão ou fabricante"
            className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pr-3 pl-9 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          />
        </label>
      </div>

      {loadError ? (
        <EmptyState title="Não foi possível carregar o catálogo." detail={loadError}>
          <button type="button" onClick={onRetry} className="text-sm font-medium text-blue-700 hover:underline">
            Tentar de novo
          </button>
        </EmptyState>
      ) : software === null ? (
        <EmptyState title="Carregando catálogo…" />
      ) : software.length === 0 ? (
        <EmptyState title="Nenhum software ativo no catálogo." detail="Cadastre o software no Catálogo de Software." />
      ) : filtered.length === 0 ? (
        <EmptyState title="Nenhum software corresponde à busca." />
      ) : (
        <div role="radiogroup" aria-label="Software" className="grid gap-3 p-4 sm:p-6 lg:grid-cols-2">
          {filtered.map((s) => {
            const available = s.installer !== null;
            const selected = s.id === selectedId;
            const details = [s.version, s.vendor, available ? formatBytes(s.installer!.sizeBytes) : null].filter(Boolean);
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!available}
                onClick={() => onSelect(s.id)}
                title={available ? undefined : 'Este software ainda não tem instalador enviado'}
                className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                  selected
                    ? 'border-blue-500 bg-blue-50/70 ring-1 ring-blue-500'
                    : available
                      ? 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                      : 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-60'
                }`}
              >
                <TypeBadge type={s.installType} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900">{s.name}</span>
                  <span className="block truncate text-xs text-slate-500">
                    <span className="font-mono">{details[0]}</span>
                    {details.slice(1).map((d) => ` · ${d}`)}
                  </span>
                </span>
                {!available && (
                  <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-800">
                    Sem instalador
                  </span>
                )}
                {selected && <CheckCircleIcon className="h-5 w-5 shrink-0 text-blue-700" />}
              </button>
            );
          })}
        </div>
      )}
    </StepCard>
  );
}
