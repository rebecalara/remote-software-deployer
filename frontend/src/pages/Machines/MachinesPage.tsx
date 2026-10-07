import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RefreshIcon, SearchIcon } from '../../components/icons';
import { useAuth } from '../../context/AuthContext';
import { useNow } from '../../hooks/useNow';
import { SessionExpiredError } from '../../services/apiClient';
import { getSyncStatus, listMachines, syncMachines } from '../../services/machineService';
import type { Machine, MachineListResponse, SyncStatus } from '../../types/machine';
import { formatRelative } from '../../utils/format';
import { MachineDetailsPanel } from './MachineDetailsPanel';
import { MissingFromAdBadge, StatusBadge } from './MachineBadges';
import { SyncStatusLine } from './SyncStatusLine';

type PresenceFilter = 'all' | 'present' | 'missing';
const ALL = 'all';
const NO_DEPARTMENT = '__none__';

// Polling simples (PLANNING §9: sem WebSocket no MVP). Mais rápido enquanto há
// sincronização rodando, para o resultado aparecer assim que ela terminar.
const STATUS_POLL_MS = 30_000;
const STATUS_POLL_RUNNING_MS = 3_000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado.';
}

export function MachinesPage() {
  const { user } = useAuth();
  const canSync = user?.role === 'ADMIN' || user?.role === 'OPERATOR';
  const now = useNow();

  const [data, setData] = useState<MachineListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState(ALL);
  const [presence, setPresence] = useState<PresenceFilter>(ALL);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [detailId, setDetailId] = useState<string | null>(null);

  // ---------- carregamento ----------

  const loadMachines = useCallback(async () => {
    try {
      const result = await listMachines();
      setData(result);
      setLoadError(null);
      // Seleção só pode conter máquinas que ainda existem e estão no AD.
      const selectable = new Set(result.machines.filter((m) => m.seenInLastSync).map((m) => m.id));
      setSelected((prev) => new Set([...prev].filter((id) => selectable.has(id))));
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setLoadError(messageOf(err));
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setSyncStatus(await getSyncStatus());
    } catch {
      // Status é complementar: se falhar, a lista continua utilizável.
    }
  }, []);

  useEffect(() => {
    void loadMachines();
    void loadStatus();
  }, [loadMachines, loadStatus]);

  useEffect(() => {
    const id = window.setInterval(loadStatus, syncStatus?.running ? STATUS_POLL_RUNNING_MS : STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [loadStatus, syncStatus?.running]);

  // Quando qualquer sincronização termina (automática ou manual, desta ou de outra
  // aba), o lastRunAt muda — é o sinal para recarregar a lista.
  const lastRunSeen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (syncStatus === null) return;
    if (lastRunSeen.current !== undefined && syncStatus.lastRunAt !== lastRunSeen.current) {
      void loadMachines();
    }
    lastRunSeen.current = syncStatus.lastRunAt;
  }, [syncStatus, loadMachines]);

  async function handleSync() {
    setSyncing(true);
    setFeedback(null);
    try {
      const result = await syncMachines();
      const parts = [`${result.total} máquinas no AD`, `${result.created} novas`];
      if (result.notSeen > 0) parts.push(`${result.notSeen} não encontradas`);
      setFeedback({ kind: 'success', text: `Sincronização concluída: ${parts.join(', ')}.` });
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      setFeedback({ kind: 'error', text: messageOf(err) });
    } finally {
      setSyncing(false);
      void loadStatus(); // dispara o recarregamento da lista via lastRunAt
    }
  }

  // ---------- filtros ----------

  const machines = useMemo(() => data?.machines ?? [], [data]);

  const departments = useMemo(
    () =>
      [...new Set(machines.map((m) => m.department).filter((d): d is string => d !== null))].sort((a, b) =>
        a.localeCompare(b, 'pt-BR'),
      ),
    [machines],
  );
  const hasNoDepartment = machines.some((m) => m.department === null);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return machines.filter((m) => {
      if (term && ![m.hostname, m.operatingSystem, m.department].some((v) => v?.toLowerCase().includes(term))) {
        return false;
      }
      if (department === NO_DEPARTMENT && m.department !== null) return false;
      if (department !== ALL && department !== NO_DEPARTMENT && m.department !== department) return false;
      if (presence === 'present' && !m.seenInLastSync) return false;
      if (presence === 'missing' && m.seenInLastSync) return false;
      return true;
    });
  }, [machines, search, department, presence]);

  const filtersActive = search.trim() !== '' || department !== ALL || presence !== ALL;
  const missingCount = machines.filter((m) => !m.seenInLastSync).length;
  const unverifiedCount = machines.filter((m) => m.status === 'UNKNOWN').length;

  // ---------- seleção (RF03) ----------

  const selectableVisible = filtered.filter((m) => m.seenInLastSync);
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((m) => selected.has(m.id));
  const someVisibleSelected = selectableVisible.some((m) => selected.has(m.id));

  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [someVisibleSelected, allVisibleSelected]);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // "Selecionar todas" age só sobre as visíveis após o filtro.
  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      selectableVisible.forEach((m) => (allVisibleSelected ? next.delete(m.id) : next.add(m.id)));
      return next;
    });
  }

  function clearFilters() {
    setSearch('');
    setDepartment(ALL);
    setPresence(ALL);
  }

  const detailMachine = machines.find((m) => m.id === detailId) ?? null;
  const closeDetails = useCallback(() => setDetailId(null), []);
  const syncBusy = syncing || syncStatus?.running === true;

  // ---------- render ----------

  return (
    <div className="flex min-h-full">
      <div className="flex min-w-0 flex-1 flex-col p-4 sm:p-6">
        {/* Barra de ferramentas */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative min-w-56 flex-1">
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

          <select
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            aria-label="Filtrar por setor"
            className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-500 sm:flex-none"
          >
            <option value={ALL}>Todos os setores</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
            {hasNoDepartment && <option value={NO_DEPARTMENT}>Sem setor</option>}
          </select>

          <select
            value={presence}
            onChange={(e) => setPresence(e.target.value as PresenceFilter)}
            aria-label="Filtrar por presença no AD"
            className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-500 sm:flex-none"
          >
            <option value={ALL}>Todas</option>
            <option value="present">Presentes no AD</option>
            <option value="missing">Não encontradas no AD</option>
          </select>

          {canSync && (
            <button
              type="button"
              onClick={handleSync}
              disabled={syncBusy}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshIcon className={`h-4 w-4 ${syncBusy ? 'animate-spin' : ''}`} />
              {syncBusy ? 'Sincronizando…' : 'Sincronizar agora'}
            </button>
          )}
        </div>

        {/* Resumo + status da sincronização */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Chip>Total: {machines.length}</Chip>
            <Chip>Não verificadas: {unverifiedCount}</Chip>
            {missingCount > 0 && <Chip tone="amber">Não encontradas no AD: {missingCount}</Chip>}
            {filtersActive && (
              <span className="text-slate-500">
                · Mostrando {filtered.length} de {machines.length}
              </span>
            )}
          </div>
          <SyncStatusLine status={syncStatus} lastSyncAt={data?.lastSyncAt ?? null} now={now} />
        </div>

        {feedback && (
          <p
            role={feedback.kind === 'error' ? 'alert' : 'status'}
            className={`mt-3 rounded-lg px-3 py-2 text-sm ${
              feedback.kind === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'
            }`}
          >
            {feedback.text}
          </p>
        )}

        {/* Tabela */}
        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {loadError ? (
            <EmptyState title="Não foi possível carregar as máquinas." detail={loadError}>
              <button type="button" onClick={loadMachines} className="text-sm font-medium text-blue-700 hover:underline">
                Tentar de novo
              </button>
            </EmptyState>
          ) : data === null ? (
            <EmptyState title="Carregando máquinas…" />
          ) : machines.length === 0 ? (
            <EmptyState
              title="Nenhuma máquina sincronizada ainda."
              detail={canSync ? 'Use "Sincronizar agora" para buscar as máquinas do AD.' : 'Aguarde a próxima sincronização automática.'}
            />
          ) : filtered.length === 0 ? (
            <EmptyState title="Nenhuma máquina corresponde aos filtros.">
              <button type="button" onClick={clearFilters} className="text-sm font-medium text-blue-700 hover:underline">
                Limpar filtros
              </button>
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase">
                  <tr>
                    <th scope="col" className="w-12 px-4 py-3">
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
                  {filtered.map((m) => (
                    <MachineRow
                      key={m.id}
                      machine={m}
                      now={now}
                      checked={selected.has(m.id)}
                      active={m.id === detailId}
                      onToggle={() => toggleOne(m.id)}
                      onOpen={() => setDetailId(m.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Barra de seleção (RF03) — o botão vira funcional no Bloco 4 */}
        {selected.size > 0 && (
          <div className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-lg">
            <p className="text-sm font-medium text-slate-900">
              {selected.size} {selected.size === 1 ? 'máquina selecionada' : 'máquinas selecionadas'}
            </p>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-sm text-slate-500 hover:text-slate-700 hover:underline"
            >
              Limpar seleção
            </button>
            <button
              type="button"
              disabled
              title="Disponível a partir do Bloco 4 (Implantação Remota)"
              className="ml-auto cursor-not-allowed rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white opacity-50"
            >
              Implantar software
            </button>
          </div>
        )}
      </div>

      {/* Painel de detalhes: coluna fixa em telas largas, sobreposto nas menores */}
      {detailMachine && (
        <>
          <div className="hidden shrink-0 py-6 pr-6 xl:block">
            <div className="sticky top-6 h-[calc(100vh-7rem)]">
              <MachineDetailsPanel machine={detailMachine} now={now} onClose={closeDetails} />
            </div>
          </div>
          <div className="fixed inset-0 z-30 xl:hidden">
            <div className="absolute inset-0 bg-slate-950/40" onClick={closeDetails} />
            <div className="absolute inset-y-0 right-0 w-full max-w-sm shadow-xl">
              <MachineDetailsPanel machine={detailMachine} now={now} onClose={closeDetails} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface MachineRowProps {
  machine: Machine;
  now: number;
  checked: boolean;
  active: boolean;
  onToggle: () => void;
  onOpen: () => void;
}

function MachineRow({ machine: m, now, checked, active, onToggle, onOpen }: MachineRowProps) {
  const selectable = m.seenInLastSync;
  return (
    <tr
      onClick={onOpen}
      className={`cursor-pointer transition-colors ${active ? 'bg-blue-50/70' : 'hover:bg-slate-50'} ${
        selectable ? '' : 'text-slate-400'
      }`}
    >
      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={!selectable}
          title={selectable ? undefined : 'Máquina não encontrada no AD — não pode ser selecionada'}
          aria-label={`Selecionar ${m.hostname}`}
          className="h-4 w-4 rounded border-slate-300 accent-blue-600 disabled:cursor-not-allowed"
        />
      </td>
      <td className="px-4 py-3 font-mono text-[13px] font-semibold whitespace-nowrap text-slate-900">
        {m.hostname}
      </td>
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
}

function Chip({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'amber' }) {
  const styles =
    tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-slate-200 bg-white text-slate-600';
  return <span className={`rounded-md border px-2.5 py-1 font-medium ${styles}`}>{children}</span>;
}

function EmptyState({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-16 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {detail && <p className="mt-1 text-sm text-slate-500">{detail}</p>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
