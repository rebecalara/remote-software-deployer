import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ActivityIcon, RefreshIcon, SearchIcon } from '../../components/icons';
import { ActionBar } from '../../components/ActionBar';
import { FeedbackMessage, type Feedback } from '../../components/FeedbackMessage';
import { ListPagination } from '../../components/ListPagination';
import { useAuth } from '../../context/AuthContext';
import { useNow } from '../../hooks/useNow';
import { usePagedList } from '../../hooks/usePagedList';
import { ApiError, SessionExpiredError } from '../../services/apiClient';
import {
  checkReachability,
  getReachabilityStatus,
  getSyncStatus,
  listMachines,
  syncMachines,
} from '../../services/machineService';
import type { Machine, MachineListResponse, MachineStatus, ReachabilityStatus, SyncStatus } from '../../types/machine';
import { formatRelative } from '../../utils/format';
import type { NewDeploymentLocationState } from '../Deployments/NewDeploymentPage';
import { MachineDetailsPanel } from './MachineDetailsPanel';
import { MACHINE_STATUS_LABEL, StatusBadge } from './MachineBadges';
import { ReachabilityLine } from './ReachabilityLine';
import { SyncStatusLine } from './SyncStatusLine';

type StatusFilter = 'all' | MachineStatus;
const ALL = 'all';
const NO_DEPARTMENT = '__none__';
/** Máquinas por página: com 1000 linhas a tabela travava a busca e o "selecionar todas". */
const PAGE_SIZE = 100;

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
  // Uma cópia só do painel (coluna em tela larga OU sobreposto): com o inventário (RF08),
  // o painel tem estado — duas cópias montadas ficariam com listas diferentes.
  const navigate = useNavigate();

  const [data, setData] = useState<MachineListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [reach, setReach] = useState<ReachabilityStatus | null>(null);
  const [checking, setChecking] = useState(false);
  /** Uma verificação foi pedida por esta tela: avisar o resultado quando ela terminar. */
  const awaitingCheck = useRef(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  /**
   * Pedido de sincronizar/verificar ainda sem resposta: o segundo clique é ignorado. O estado
   * (syncing/checking) desativa o botão, mas só no próximo desenho da tela — um clique duplo
   * rápido chegava antes disso e o backend respondia 409.
   */
  const syncInFlight = useRef(false);
  const checkInFlight = useRef(false);

  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState(ALL);
  /** Selo "X não encontradas no AD" ligado: a lista mostra só essas. */
  const [missingOnly, setMissingOnly] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(ALL);
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
    // Status são complementares: se falharem, a lista continua utilizável.
    const [sync, reachability] = await Promise.allSettled([getSyncStatus(), getReachabilityStatus()]);
    if (sync.status === 'fulfilled') setSyncStatus(sync.value);
    if (reachability.status === 'fulfilled') setReach(reachability.value);
  }, []);

  useEffect(() => {
    void loadMachines();
    void loadStatus();
  }, [loadMachines, loadStatus]);

  const anyRunning = syncStatus?.running === true || reach?.running === true;
  useEffect(() => {
    const id = window.setInterval(loadStatus, anyRunning ? STATUS_POLL_RUNNING_MS : STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [loadStatus, anyRunning]);

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

  // Mesmo sinal para a verificação do WinRM: terminou uma rodada → recarrega a lista e,
  // se foi pedida por esta tela, mostra o resultado.
  const lastReachSeen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (reach === null) return;
    if (lastReachSeen.current !== undefined && reach.lastRunAt !== lastReachSeen.current) {
      void loadMachines();
      if (awaitingCheck.current && !reach.running) {
        awaitingCheck.current = false;
        const r = reach.lastResult;
        setFeedback(
          reach.lastError || !r
            ? { kind: 'error', text: reach.lastError ?? 'A verificação do WinRM não terminou.' }
            : { kind: 'success', text: `Verificação concluída: ${r.responding} de ${r.total} respondendo no WinRM.` },
        );
      }
    }
    lastReachSeen.current = reach.lastRunAt;
  }, [reach, loadMachines]);

  async function handleCheck() {
    if (checkInFlight.current) return;
    checkInFlight.current = true;
    setChecking(true);
    setFeedback(null);
    try {
      setReach(await checkReachability());
      awaitingCheck.current = true;
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      // 409: outra pessoa (ou a verificação automática) já está verificando — não é erro.
      if (err instanceof ApiError && err.status === 409) {
        awaitingCheck.current = true;
        setFeedback({ kind: 'info', text: 'Verificação do WinRM já em andamento.' });
        void loadStatus();
      } else {
        setFeedback({ kind: 'error', text: messageOf(err) });
      }
    } finally {
      checkInFlight.current = false;
      setChecking(false);
    }
  }

  async function handleSync() {
    if (syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncing(true);
    setFeedback(null);
    try {
      const result = await syncMachines();
      const parts = [`${result.total} máquinas no AD`, `${result.created} novas`];
      if (result.notSeen > 0) parts.push(`${result.notSeen} não encontradas`);
      setFeedback({ kind: 'success', text: `Sincronização concluída: ${parts.join(', ')}.` });
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      // 409: outra pessoa (ou a sincronização automática) já está sincronizando — não é erro.
      if (err instanceof ApiError && err.status === 409) {
        setFeedback({ kind: 'info', text: 'Sincronização com o AD já em andamento.' });
      } else {
        setFeedback({ kind: 'error', text: messageOf(err) });
      }
    } finally {
      syncInFlight.current = false;
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

  // Sem WinRM neste servidor (modo demonstração), tudo aparece como "Não verificado",
  // mesmo que o banco tenha um resultado antigo.
  const reachabilityOff = reach !== null && !reach.available;

  const missingCount = machines.filter((m) => !m.seenInLastSync).length;
  // Sem nenhuma não encontrada, o selo some — e o filtro dele também.
  const showMissingOnly = missingOnly && missingCount > 0;

  // Busca adiada: a tecla aparece na hora e a tabela é atualizada logo depois, podendo ser
  // interrompida pela próxima tecla (sem travar a digitação com 1000 linhas).
  const deferredSearch = useDeferredValue(search);
  const filtered = useMemo(() => {
    const term = deferredSearch.trim().toLowerCase();
    return machines.filter((m) => {
      if (term && ![m.hostname, m.operatingSystem, m.department].some((v) => v?.toLowerCase().includes(term))) {
        return false;
      }
      if (department === NO_DEPARTMENT && m.department !== null) return false;
      if (department !== ALL && department !== NO_DEPARTMENT && m.department !== department) return false;
      if (showMissingOnly && m.seenInLastSync) return false;
      if (statusFilter !== ALL && (reachabilityOff ? 'UNKNOWN' : m.status) !== statusFilter) return false;
      return true;
    });
  }, [machines, deferredSearch, department, showMissingOnly, statusFilter, reachabilityOff]);

  const paged = usePagedList(filtered, PAGE_SIZE, `${deferredSearch}|${department}|${showMissingOnly}|${statusFilter}`);

  const filtersActive = search.trim() !== '' || department !== ALL || showMissingOnly || statusFilter !== ALL;
  // Reserva para "WinRM verificado há X" logo depois de o backend reiniciar.
  const lastCheckedAt = machines.reduce<string | null>(
    (max, m) => (m.statusCheckedAt && (!max || m.statusCheckedAt > max) ? m.statusCheckedAt : max),
    null,
  );

  // ---------- seleção (RF03) ----------

  const selectableVisible = filtered.filter((m) => m.seenInLastSync);
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((m) => selected.has(m.id));
  const someVisibleSelected = selectableVisible.some((m) => selected.has(m.id));

  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [someVisibleSelected, allVisibleSelected]);

  // Estável (useCallback): com React.memo, marcar uma máquina redesenha só aquela linha.
  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // "Selecionar todas" vale para TODAS as máquinas filtradas (não só a página visível).
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
    setMissingOnly(false);
    setStatusFilter(ALL);
  }

  const detailMachine = machines.find((m) => m.id === detailId) ?? null;
  const closeDetails = useCallback(() => setDetailId(null), []);
  const syncBusy = syncing || syncStatus?.running === true;
  const checkBusy = checking || reach?.running === true;
  const syncHint = syncStatus?.autoSyncEnabled
    ? `Busca no AD a lista de computadores (automático a cada ${syncStatus.intervalMinutes} min)`
    : 'Busca no AD a lista de computadores (sincronização automática desativada)';
  const checkHint = reach?.autoCheckEnabled
    ? `Testa se a porta do WinRM de cada máquina responde (automático a cada ${reach.intervalMinutes} min)`
    : 'Testa se a porta do WinRM de cada máquina responde (verificação automática desativada)';
  const checkDisabledReason = reachabilityOff ? `Verificação desligada neste servidor: ${reach?.unavailableReason ?? ''}` : undefined;

  // ---------- render ----------

  return (
    <div className="flex min-h-full">
      <div className="flex min-w-0 flex-1 flex-col p-4 sm:p-6">
        {/* Barra de ferramentas */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative min-w-48 flex-1">
            <span className="sr-only">Buscar máquina por nome, sistema ou setor</span>
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

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            aria-label="Filtrar por status do WinRM"
            className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-body outline-none focus:border-blue-500 sm:flex-none"
          >
            <option value={ALL}>Todos os status</option>
            <option value="ONLINE">{MACHINE_STATUS_LABEL.ONLINE}</option>
            <option value="OFFLINE">{MACHINE_STATUS_LABEL.OFFLINE}</option>
            <option value="UNKNOWN">{MACHINE_STATUS_LABEL.UNKNOWN}</option>
          </select>

          {canSync && (
            <button
              type="button"
              onClick={handleSync}
              disabled={syncBusy}
              title={syncHint}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-body font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshIcon className={`h-4 w-4 ${syncBusy ? 'animate-spin' : ''}`} />
              {syncBusy ? 'Sincronizando…' : 'Sincronizar com o AD'}
            </button>
          )}

          {canSync && (
            <button
              type="button"
              onClick={handleCheck}
              disabled={checkBusy || reachabilityOff}
              title={checkDisabledReason ?? checkHint}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-body font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <ActivityIcon className={`h-4 w-4 ${checkBusy ? 'animate-pulse' : ''}`} />
              {checkBusy
                ? reach?.progress && reach.progress.total > 0
                  ? `Verificando ${reach.progress.checked} de ${reach.progress.total}…`
                  : 'Verificando…'
                : 'Verificar WinRM'}
            </button>
          )}
        </div>

        {/* Resumo + status da sincronização */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-2 text-body text-slate-600" data-testid="machines-summary">
            <span>
              {machines.length} {machines.length === 1 ? 'máquina' : 'máquinas'}
              {filtersActive && <span className="text-slate-500"> · mostrando {filtered.length}</span>}
            </span>
            {missingCount > 0 && (
              // Filtra a lista; clicar de novo tira o filtro. Nenhuma máquina é apagada.
              <button
                type="button"
                onClick={() => setMissingOnly((v) => !v)}
                aria-pressed={showMissingOnly}
                data-testid="missing-chip"
                title={showMissingOnly ? 'Mostrar todas as máquinas' : 'Mostrar só as máquinas que não apareceram na última sincronização'}
                className={`rounded-md border px-2.5 py-1 text-meta font-medium ${
                  showMissingOnly
                    ? 'border-amber-500 bg-amber-100 text-amber-900'
                    : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
                }`}
              >
                {missingCount} {missingCount === 1 ? 'não encontrada' : 'não encontradas'} no AD
              </button>
            )}
          </div>
          <div className="flex flex-col items-start gap-0.5 sm:items-end">
            <SyncStatusLine status={syncStatus} lastSyncAt={data?.lastSyncAt ?? null} now={now} />
            <ReachabilityLine status={reach} lastCheckedAt={lastCheckedAt} now={now} />
          </div>
        </div>

        {feedback && <FeedbackMessage feedback={feedback} onDismiss={() => setFeedback(null)} className="mt-3" />}

        {/* Tabela */}
        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {loadError ? (
            <EmptyState title="Não foi possível carregar as máquinas." detail={loadError}>
              <button type="button" onClick={loadMachines} className="text-body font-medium text-blue-700 hover:underline">
                Tentar de novo
              </button>
            </EmptyState>
          ) : data === null ? (
            <EmptyState title="Carregando máquinas…" />
          ) : machines.length === 0 ? (
            <EmptyState
              title="Nenhuma máquina sincronizada ainda."
              detail={canSync ? 'Use "Sincronizar com o AD" para buscar as máquinas.' : 'Aguarde a próxima sincronização automática.'}
            />
          ) : filtered.length === 0 ? (
            <EmptyState title="Nenhuma máquina corresponde aos filtros.">
              <button type="button" onClick={clearFilters} className="text-body font-medium text-blue-700 hover:underline">
                Limpar filtros
              </button>
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-body">
                <thead className="border-b border-slate-200 bg-slate-50 text-meta font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase">
                  <tr>
                    <th scope="col" className="w-12 px-4 py-3">
                      <input
                        ref={headerCheckbox}
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleAllVisible}
                        disabled={selectableVisible.length === 0}
                        aria-label={`Selecionar todas as ${selectableVisible.length} máquinas filtradas`}
                        title={`Selecionar todas as ${selectableVisible.length} máquinas filtradas (de todas as páginas)`}
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
                    <MachineRow
                      key={m.id}
                      machine={m}
                      now={now}
                      checked={selected.has(m.id)}
                      active={m.id === detailId}
                      onToggle={toggleOne}
                      onOpen={setDetailId}
                      reachabilityOff={reachabilityOff}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {filtered.length > PAGE_SIZE && (
          <div className="mt-3">
            <ListPagination {...paged} onPage={paged.setPage} label="Páginas de máquinas" />
          </div>
        )}

        {/* Barra de seleção (RF03) — "Implantar software" abre a Nova Implantação já com estas máquinas */}
        {selected.size > 0 && (
          <ActionBar
            testId="selection-bar"
            actions={
              <button
                type="button"
                disabled={!canSync}
                onClick={() =>
                  navigate('/deployments/new', { state: { machineIds: [...selected] } satisfies NewDeploymentLocationState })
                }
                title={canSync ? undefined : 'Somente Administradores e Operadores iniciam implantações'}
                className="rounded-lg border border-transparent bg-blue-700 px-4 py-2 text-body font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Implantar software
              </button>
            }
          >
            <span className="font-medium text-slate-900">
              {selected.size} {selected.size === 1 ? 'máquina selecionada' : 'máquinas selecionadas'}
            </span>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-slate-500 hover:text-slate-700 hover:underline"
            >
              Limpar seleção
            </button>
          </ActionBar>
        )}
      </div>

      {/* Painel de detalhes: coluna fixa em telas largas, sobreposto nas menores (SidePanel). */}
      {detailMachine && (
        <MachineDetailsPanel machine={detailMachine} now={now} onClose={closeDetails} canCollect={canSync} reachabilityOff={reachabilityOff} />
      )}
    </div>
  );
}

interface MachineRowProps {
  machine: Machine;
  now: number;
  checked: boolean;
  active: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  reachabilityOff: boolean;
}

// Memorizada: só redesenha a linha cujas props mudaram (marcar uma máquina, abrir o painel).
const MachineRow = memo(function MachineRow({ machine: m, now, checked, active, onToggle, onOpen, reachabilityOff }: MachineRowProps) {
  const selectable = m.seenInLastSync;
  return (
    <tr
      onClick={() => onOpen(m.id)}
      className={`cursor-pointer transition-colors ${active ? 'bg-blue-50/70' : 'hover:bg-slate-50'} ${
        selectable ? '' : 'text-slate-400'
      }`}
    >
      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
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
      <td className="px-4 py-3 font-mono text-body font-semibold whitespace-nowrap text-slate-900">
        {m.hostname}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">{m.operatingSystem ?? <span className="text-slate-400">—</span>}</td>
      <td className="px-4 py-3 whitespace-nowrap">{m.department ?? <span className="text-slate-400">—</span>}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1.5">
          <StatusBadge status={m.status} checkedAt={m.statusCheckedAt} verificationOff={reachabilityOff} />
        </div>
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-slate-500">
        {m.seenInLastSync ? (
          formatRelative(m.lastSync, now)
        ) : (
          <span className="font-medium text-amber-700" title={`Última confirmação no AD: ${formatRelative(m.lastSync, now)}`} data-testid="missing-from-ad">
            Não encontrada no AD
          </span>
        )}
      </td>
    </tr>
  );
});

function EmptyState({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-16 text-center">
      <p className="text-body font-medium text-slate-700">{title}</p>
      {detail && <p className="mt-1 text-body text-slate-500">{detail}</p>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
