import { useMemo, useState, type ReactNode } from 'react';
import { CheckCircleIcon, SearchIcon } from '../../components/icons';
import { Tooltip } from '../../components/Tooltip';
import type { DeploymentAction } from '../../types/deployment';
import type { Software } from '../../types/software';
import { formatBytes } from '../../utils/format';
import { EXE_UNINSTALL_UNAVAILABLE } from './deploymentUi';
import { OTHER_UNINSTALL_RULE } from './UninstallChoices';
import { EmptyState, StepCard, TypeBadge } from './wizardParts';

interface SoftwareStepProps {
  /** Todos os softwares do catálogo, inclusive desativados (a desinstalação aceita). */
  software: Software[] | null;
  loadError: string | null;
  onRetry: () => void;
  action: DeploymentAction;
  onActionChange: (action: DeploymentAction) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Em "Desinstalar": a lista do software instalado nas máquinas, filtrada pela mesma busca. */
  renderUninstall: (search: string) => ReactNode;
}

/** Por que um software não pode ser escolhido nesta ação (null = pode). */
export function unavailableReason(s: Software, action: DeploymentAction): { badge: string; title: string } | null {
  if (action === 'UNINSTALL') {
    if (s.installType !== 'MSI') return { badge: 'Desinstalação só para MSI', title: EXE_UNINSTALL_UNAVAILABLE };
    if (!s.uninstallAvailable) {
      return { badge: 'Sem ProductCode', title: 'O ProductCode deste MSI não foi lido. Envie o instalador de novo no catálogo.' };
    }
    return null;
  }
  if (!s.installer) return { badge: 'Sem instalador', title: 'Este software ainda não tem instalador enviado.' };
  return null;
}

/**
 * Passo 2: a ação (instalar ou desinstalar) e UM software. Instalar lista os ativos do
 * catálogo (os sem instalador aparecem, mas não podem ser escolhidos); desinstalar lista o
 * software encontrado no inventário das máquinas selecionadas. Uma busca só, para as duas.
 */
export function SoftwareStep({
  software,
  loadError,
  onRetry,
  action,
  onActionChange,
  selectedId,
  onSelect,
  renderUninstall,
}: SoftwareStepProps) {
  const [search, setSearch] = useState('');
  const uninstall = action === 'UNINSTALL';

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = [...(software ?? [])]
      .filter((s) => s.active)
      // Os que podem ser escolhidos primeiro; depois, por nome.
      .sort(
        (a, b) =>
          Number(unavailableReason(a, action) !== null) - Number(unavailableReason(b, action) !== null) ||
          a.name.localeCompare(b.name, 'pt-BR'),
      );
    if (!term) return list;
    return list.filter((s) => [s.name, s.version, s.vendor].some((v) => v?.toLowerCase().includes(term)));
  }, [software, search, action]);

  return (
    <StepCard
      title={uninstall ? 'Selecionar software para desinstalar' : 'Selecionar software para implantar'}
      info={uninstall ? OTHER_UNINSTALL_RULE : undefined}
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 sm:px-6">
        <div role="radiogroup" aria-label="Ação" className="inline-flex rounded-lg bg-slate-100 p-1">
          {(['INSTALL', 'UNINSTALL'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={action === value}
              onClick={() => action !== value && onActionChange(value)}
              className={`rounded-md px-3 py-1.5 text-body font-medium whitespace-nowrap ${
                action === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {value === 'INSTALL' ? 'Instalar' : 'Desinstalar'}
            </button>
          ))}
        </div>
        <label className="relative min-w-56 flex-1 sm:max-w-md">
          <span className="sr-only">Buscar software</span>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar software"
            className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pr-3 pl-9 text-body outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          />
        </label>
      </div>

      {uninstall ? (
        renderUninstall(search)
      ) : loadError ? (
        <EmptyState title="Não foi possível carregar o catálogo." detail={loadError}>
          <button type="button" onClick={onRetry} className="text-body font-medium text-blue-700 hover:underline">
            Tentar de novo
          </button>
        </EmptyState>
      ) : software === null ? (
        <EmptyState title="Carregando catálogo…" />
      ) : filtered.length === 0 && !search.trim() ? (
        <EmptyState title="Nenhum software ativo no catálogo." detail="Cadastre o software no Catálogo de Software." />
      ) : filtered.length === 0 ? (
        <EmptyState title="Nenhum software corresponde à busca." />
      ) : (
        <div role="radiogroup" aria-label="Software" className="grid gap-3 p-4 sm:p-6 lg:grid-cols-2">
          {filtered.map((s) => {
            const blocked = unavailableReason(s, action);
            const selected = s.id === selectedId;
            const details = [s.version, s.vendor, s.installer ? formatBytes(s.installer.sizeBytes) : null].filter(Boolean);
            const card = (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={blocked !== null || undefined}
                onClick={() => blocked === null && onSelect(s.id)}
                className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 ${
                  selected
                    ? 'border-blue-500 bg-blue-50/70 ring-1 ring-blue-500'
                    : blocked === null
                      ? 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                      : 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-60'
                }`}
              >
                <TypeBadge type={s.installType} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-semibold text-slate-900">{s.name}</span>
                  <span className="block truncate text-meta text-slate-500">
                    <span className="font-mono">{details[0]}</span>
                    {details.slice(1).map((d) => ` · ${d}`)}
                  </span>
                </span>
                {blocked && (
                  <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-meta font-medium whitespace-nowrap text-amber-800">
                    {blocked.badge}
                  </span>
                )}
                {selected && <CheckCircleIcon className="h-5 w-5 shrink-0 text-blue-700" />}
              </button>
            );
            // Bloqueado: o motivo vai na dica (o card continua focável para ela chegar ao teclado).
            return blocked ? (
              <Tooltip key={s.id} content={blocked.title}>
                {card}
              </Tooltip>
            ) : (
              card
            );
          })}
        </div>
      )}
    </StepCard>
  );
}
