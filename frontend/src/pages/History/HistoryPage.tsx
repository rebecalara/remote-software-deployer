import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SearchIcon } from '../../components/icons';
import { ApiError, SessionExpiredError } from '../../services/apiClient';
import { getDeployment, listDeployments } from '../../services/deploymentService';
import { listSoftware } from '../../services/softwareService';
import type { Deployment, DeploymentAction, DeploymentListFilters, DeploymentPage, DeploymentStatus } from '../../types/deployment';
import type { Software } from '../../types/software';
import { useNow } from '../../hooks/useNow';
import { DeploymentTable, toggleInSet } from '../Deployments/DeploymentTable';
import { MineToggle, STATUS_LABEL } from '../Deployments/deploymentUi';

// Histórico (Bloco 6, RF07/RF13): só implantações ENCERRADAS (as em andamento ficam no
// Monitoramento), com filtros e paginação. Os filtros ficam na URL
// (?mine=&action=&from=&to=&status=&softwareId=&machine=&page=&open=): voltar no navegador ou
// copiar o link preserva a busca. Cada implantação expande na própria linha, com as
// máquinas e o log de cada uma (RF13); ?open=<id> abre e destaca uma.
const PAGE_SIZE = 20;
const STATUSES: DeploymentStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
const MACHINE_DEBOUNCE_MS = 400;

/** "2026-11-14" (dia escolhido, no fuso de quem usa) → instante ISO do início do dia. */
function startOfDayIso(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
}
/** Fim INCLUSIVO do dia escolhido = início do dia seguinte (o backend usa "antes de"). */
function endOfDayIso(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + 1).toISOString();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado.';
}

export function HistoryPage() {
  const now = useNow(1_000);
  const [params, setParams] = useSearchParams();
  const openParam = params.get('open');
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const status = (params.get('status') ?? '') as DeploymentStatus | '';
  const action = (params.get('action') ?? '') as DeploymentAction | '';
  const softwareId = params.get('softwareId') ?? '';
  const machine = params.get('machine') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const mine = params.get('mine') === 'true';

  const [machineInput, setMachineInput] = useState(machine);
  const [software, setSoftware] = useState<Software[]>([]);
  const [data, setData] = useState<DeploymentPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set(openParam ? [openParam] : []));
  const [pinned, setPinned] = useState<Deployment | null>(null);

  useEffect(() => {
    if (openParam) setOpenIds((s) => (s.has(openParam) ? s : new Set(s).add(openParam)));
  }, [openParam]);

  // ?open de uma implantação fora da página atual (outros filtros, outra página):
  // mostrada à parte, acima da lista, para o link nunca cair no vazio.
  useEffect(() => {
    if (!openParam || data === null) return;
    if (data.items.some((d) => d.id === openParam)) {
      setPinned(null);
      return;
    }
    if (pinned?.id === openParam) return;
    getDeployment(openParam)
      .then((d) => setPinned(d.finishedAt ? d : null))
      .catch(() => setPinned(null));
  }, [openParam, data, pinned?.id]);

  function toggle(id: string) {
    setOpenIds((s) => toggleInSet(s, id));
    if (id === openParam && openIds.has(id)) {
      const next = new URLSearchParams(window.location.search);
      next.delete('open');
      setParams(next, { replace: true });
    }
  }

  /**
   * Muda um filtro e volta para a página 1 (a não ser que a mudança seja a própria
   * página). Parte da URL ATUAL do navegador, que o roteador atualiza na hora — nem a
   * cópia da renderização nem a forma funcional do setSearchParams servem: as duas
   * entregam os parâmetros da renderização em que a função foi criada. Encontrado no
   * teste no navegador: a busca por máquina (que dispara 400 ms depois) devolvia à URL
   * um filtro de software já limpo, e preencher "De" e "Até" em sequência rápida
   * fazia o segundo apagar o primeiro.
   */
  function update(changes: Record<string, string>) {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (!('page' in changes)) next.delete('page');
    next.delete('open');
    setParams(next, { replace: !('page' in changes) });
  }

  // Busca por máquina: espera a pessoa parar de digitar.
  useEffect(() => {
    if (machineInput.trim() === machine) return;
    const timer = window.setTimeout(() => update({ machine: machineInput.trim() }), MACHINE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [machineInput]); // só a digitação dispara; `update` lê os parâmetros atuais
  useEffect(() => setMachineInput(machine), [machine]);

  useEffect(() => {
    listSoftware(true)
      .then((list) => setSoftware([...list].sort((a, b) => `${a.name} ${a.version}`.localeCompare(`${b.name} ${b.version}`, 'pt-BR'))))
      .catch(() => undefined); // o filtro de software só fica vazio; a lista continua funcionando
  }, []);

  const periodInvalid = from !== '' && to !== '' && to < from;

  const filters = useMemo<DeploymentListFilters>(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      state: 'finished',
      action: action || undefined,
      status: status || undefined,
      softwareId: softwareId || undefined,
      machine: machine || undefined,
      from: from ? startOfDayIso(from) : undefined,
      to: to ? endOfDayIso(to) : undefined,
      mine: mine || undefined,
    }),
    [page, status, softwareId, machine, from, to, mine, action],
  );

  useEffect(() => {
    if (periodInvalid) return;
    let cancelled = false;
    setLoading(true);
    listDeployments(filters)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (cancelled || err instanceof SessionExpiredError) return;
        setError(err instanceof ApiError ? err.message : messageOf(err));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [filters, periodInvalid]);

  const filtersActive = mine || action || from || to || status || softwareId || machine;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const firstItem = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const lastItem = data ? Math.min(data.page * data.pageSize, data.total) : 0;
  const input = 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20';

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <MineToggle mine={mine} onChange={(value) => update({ mine: value ? 'true' : '' })} />

      {/* Filtros */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          De
          <input type="date" value={from} max={to || undefined} onChange={(e) => update({ from: e.target.value })} className={input} aria-label="Criadas a partir de" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Até
          <input type="date" value={to} min={from || undefined} onChange={(e) => update({ to: e.target.value })} className={input} aria-label="Criadas até" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Ação
          <select value={action} onChange={(e) => update({ action: e.target.value })} className={input} aria-label="Ação">
            <option value="">Todas</option>
            <option value="INSTALL">Instalação</option>
            <option value="UNINSTALL">Desinstalação</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Status
          <select value={status} onChange={(e) => update({ status: e.target.value })} className={input} aria-label="Status">
            <option value="">Todos</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-col gap-1 text-xs font-medium text-slate-600">
          Software
          <select value={softwareId} onChange={(e) => update({ softwareId: e.target.value })} className={input} aria-label="Software">
            <option value="">Todos</option>
            {software.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} {s.version}
                {s.active ? '' : ' (desativado)'}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs font-medium text-slate-600">
          Máquina
          <span className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={machineInput}
              onChange={(e) => setMachineInput(e.target.value)}
              placeholder="Nome da máquina"
              aria-label="Máquina"
              className={`${input} w-full pl-9`}
            />
          </span>
        </label>
        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setMachineInput('');
              setParams(new URLSearchParams(), { replace: true });
            }}
            className="px-1 py-2 text-sm font-medium text-blue-700 hover:underline"
          >
            Limpar filtros
          </button>
        )}
      </div>

      {periodInvalid && (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          A data final deve ser igual ou posterior à inicial.
        </p>
      )}
      {error && !periodInvalid && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          Não foi possível carregar o histórico: {error}
        </p>
      )}

      {pinned && (
        <section className="space-y-2" data-testid="pinned-section">
          <h2 className="text-sm font-semibold text-slate-700">Implantação aberta pelo link</h2>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <DeploymentTable items={[pinned]} ariaLabel="Implantação aberta pelo link" openIds={openIds} onToggle={toggle} highlightId={openParam} now={now} />
          </div>
        </section>
      )}

      <div className={`overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${loading ? 'opacity-70' : ''}`}>
        {data === null ? (
          <p className="px-6 py-12 text-center text-sm text-slate-500">{error ? 'Sem dados.' : 'Carregando…'}</p>
        ) : data.items.length === 0 ? (
          <p className="px-6 py-12 text-center text-sm text-slate-500">
            {filtersActive ? 'Nenhuma implantação encontrada com esses filtros.' : 'Nenhuma implantação encerrada ainda.'}
          </p>
        ) : (
          <DeploymentTable
            items={data.items}
            ariaLabel="Implantações encerradas"
            openIds={openIds}
            onToggle={toggle}
            highlightId={openParam}
            now={now}
          />
        )}
      </div>

      {/* Paginação */}
      {data && data.total > 0 && (
        <nav aria-label="Paginação" className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
          <p data-testid="page-range">
            {firstItem}–{lastItem} de {data.total}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={data.page <= 1 || loading}
              onClick={() => update({ page: String(data.page - 1) })}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Anterior
            </button>
            <span>
              Página {data.page} de {totalPages}
            </span>
            <button
              type="button"
              disabled={data.page >= totalPages || loading}
              onClick={() => update({ page: String(data.page + 1) })}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Próxima
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}
