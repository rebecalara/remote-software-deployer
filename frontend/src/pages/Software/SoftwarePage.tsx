import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { FeedbackMessage, type Feedback } from '../../components/FeedbackMessage';
import { PencilIcon, PlusIcon, PowerIcon, SearchIcon, TrashIcon } from '../../components/icons';
import { Tooltip } from '../../components/Tooltip';
import { useAuth } from '../../context/AuthContext';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { SessionExpiredError } from '../../services/apiClient';
import {
  activateSoftware,
  deactivateSoftware,
  deleteSoftware,
  getInstallerLimits,
  listSoftware,
} from '../../services/softwareService';
import type { InstallerLimits, Software } from '../../types/software';
import { formatBytes, formatDate } from '../../utils/format';
import { SoftwareFormPanel } from './SoftwareFormPanel';

type StatusFilter = 'active' | 'inactive' | 'all';

/** Painel aberto: cadastro novo (software null) ou um software existente. */
type PanelState = { software: Software | null } | null;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado.';
}

export function SoftwarePage() {
  const { user } = useAuth();
  // Escrita no catálogo: ADMIN e OPERATOR (DECISIONS.md). VIEWER só consulta.
  const canWrite = user?.role === 'ADMIN' || user?.role === 'OPERATOR';

  const [items, setItems] = useState<Software[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [limits, setLimits] = useState<InstallerLimits | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [panel, setPanel] = useState<PanelState>(null);
  const [confirmDelete, setConfirmDelete] = useState<Software | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const wide = useMediaQuery('(min-width: 1280px)');

  // Alteração não salva / envio em andamento no painel: fechar (X, Cancelar, Esc, fundo) ou
  // trocar de linha pede confirmação na janela do sistema, não no confirm() do navegador.
  const guardRef = useRef({ dirty: false, saving: false });
  const onGuardChange = useCallback((guard: { dirty: boolean; saving: boolean }) => {
    guardRef.current = guard;
  }, []);

  /** O que fazer se a pessoa confirmar o descarte (fechar o painel ou abrir outro software). */
  const [discardThen, setDiscardThen] = useState<(() => void) | null>(null);

  function leavePanel(then: () => void) {
    if (guardRef.current.saving) return; // durante o envio, só o "Cancelar envio"
    if (guardRef.current.dirty) setDiscardThen(() => then);
    else then();
  }

  function openPanel(software: Software | null) {
    if (panel && (panel.software?.id ?? null) === (software?.id ?? null)) return;
    const open = () => {
      guardRef.current = { dirty: false, saving: false };
      setPanel({ software });
    };
    if (panel) leavePanel(open);
    else open();
  }

  const closePanel = useCallback(() => {
    guardRef.current = { dirty: false, saving: false };
    setPanel(null);
  }, []);

  // Sempre traz todos (inclusive desativados) e filtra aqui: a contagem por status
  // sai da mesma lista, sem segunda chamada.
  const load = useCallback(async () => {
    try {
      setItems(await listSoftware(true));
      setLoadError(null);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setLoadError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void load();
    // Limites do envio: se falhar, a tela segue funcionando (o servidor confere de novo).
    getInstallerLimits().then(setLimits).catch(() => setLimits(null));
  }, [load]);

  // Com o painel aberto ao lado, Fabricante e Atualizado saem da tabela (estão no painel):
  // sem isso, o nome quebrava e as ações ficavam fora da área visível.
  const compact = panel !== null && wide;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (items ?? []).filter((s) => {
      if (status === 'active' && !s.active) return false;
      if (status === 'inactive' && s.active) return false;
      if (!term) return true;
      return [s.name, s.vendor, s.version].some((v) => v?.toLowerCase().includes(term));
    });
  }, [items, search, status]);

  const activeCount = (items ?? []).filter((s) => s.active).length;
  const inactiveCount = (items ?? []).length - activeCount;

  async function toggleActive(software: Software) {
    if (busyId) return;
    setBusyId(software.id);
    setFeedback(null);
    try {
      if (software.active) await deactivateSoftware(software.id);
      else await activateSoftware(software.id);
      setFeedback({
        kind: 'success',
        text: software.active
          ? `"${software.name} ${software.version}" desativado: não aparece mais para novas implantações.`
          : `"${software.name} ${software.version}" reativado.`,
      });
      await load();
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setFeedback({ kind: 'error', text: messageOf(err) });
    } finally {
      setBusyId(null);
    }
  }

  function askDelete(software: Software) {
    if (busyId || software.deploymentCount > 0) return;
    setConfirmDelete(software);
  }

  async function remove(software: Software) {
    setConfirmDelete(null);
    setBusyId(software.id);
    setFeedback(null);
    try {
      await deleteSoftware(software.id);
      if (panel?.software?.id === software.id) closePanel();
      setFeedback({ kind: 'success', text: `"${software.name} ${software.version}" apagado do catálogo.` });
      await load();
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setFeedback({ kind: 'error', text: messageOf(err) });
    } finally {
      setBusyId(null);
    }
  }

  const panelNode = panel && (
    <SoftwareFormPanel
      key={panel.software?.id ?? 'new'}
      software={panel.software}
      limits={limits}
      canWrite={canWrite}
      onClose={() => leavePanel(closePanel)}
      onGuardChange={onGuardChange}
      onChanged={() => void load()}
      onSaved={(saved, message) => {
        closePanel();
        setFeedback({ kind: 'success', text: `${message} (${saved.name} ${saved.version})` });
        void load();
      }}
    />
  );

  return (
    <div className="flex min-h-full">
      <div className="flex min-w-0 flex-1 flex-col p-4 sm:p-6">
        {/* Barra de ferramentas */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative min-w-56 flex-1">
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

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            aria-label="Filtrar por status"
            className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-body outline-none focus:border-blue-500 sm:flex-none"
          >
            <option value="active">Ativos ({activeCount})</option>
            <option value="inactive">Desativados ({inactiveCount})</option>
            <option value="all">Todos ({activeCount + inactiveCount})</option>
          </select>

          <span className="text-body text-slate-500">
            {filtered.length} {filtered.length === 1 ? 'software' : 'softwares'}
          </span>

          {canWrite && (
            <button
              type="button"
              onClick={() => openPanel(null)}
              className="ml-auto inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-body font-semibold text-white hover:bg-blue-800"
            >
              <PlusIcon className="h-4 w-4" />
              Adicionar software
            </button>
          )}
        </div>

        {feedback && <FeedbackMessage feedback={feedback} onDismiss={() => setFeedback(null)} className="mt-4" />}

        {/* Tabela */}
        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {loadError ? (
            <EmptyState title="Não foi possível carregar o catálogo." detail={loadError}>
              <button type="button" onClick={load} className="text-body font-medium text-blue-700 hover:underline">
                Tentar de novo
              </button>
            </EmptyState>
          ) : items === null ? (
            <EmptyState title="Carregando catálogo…" />
          ) : items.length === 0 ? (
            <EmptyState
              title="Nenhum software no catálogo ainda."
              detail={canWrite ? 'Use "Adicionar software" para cadastrar o primeiro.' : undefined}
            />
          ) : filtered.length === 0 ? (
            <EmptyState title="Nenhum software corresponde à busca e ao filtro." />
          ) : (
            <div className="overflow-x-auto">
              <table className={`w-full text-left text-body ${compact ? 'min-w-[560px]' : 'min-w-[720px]'}`}>
                <thead className="border-b border-slate-200 bg-slate-50 text-meta font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase">
                  <tr>
                    <th scope="col" className="px-4 py-3">Software</th>
                    <th scope="col" className="px-4 py-3">Versão</th>
                    {!compact && <th scope="col" className="px-4 py-3">Fabricante</th>}
                    <th scope="col" className="px-4 py-3">Implantações</th>
                    <th scope="col" className="px-4 py-3">Tamanho</th>
                    {!compact && <th scope="col" className="px-4 py-3">Atualizado</th>}
                    {/* relative: o rótulo só para leitor de tela é absoluto; sem um ancestral
                        posicionado, ele escapava da rolagem da tabela e alargava a página no celular. */}
                    <th scope="col" className="relative px-4 py-3">
                      <span className="sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => openPanel(s)}
                      className={`cursor-pointer transition-colors ${
                        panel?.software?.id === s.id ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                      } ${s.active ? '' : 'text-slate-400'}`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                          <TypeBadge type={s.installType} />
                          <span className={`font-medium whitespace-nowrap ${s.active ? 'text-slate-900' : ''}`}>{s.name}</span>
                          {!s.active && <Badge tone="slate">Desativado</Badge>}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-body whitespace-nowrap">{s.version}</td>
                      {!compact && <td className="px-4 py-3">{s.vendor ?? <span className="text-slate-400">—</span>}</td>}
                      <td className="px-4 py-3 tabular-nums">{s.deploymentCount}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {s.installer ? formatBytes(s.installer.sizeBytes) : <Badge tone="amber">Sem instalador</Badge>}
                      </td>
                      {!compact && <td className="px-4 py-3 whitespace-nowrap">{formatDate(s.updatedAt)}</td>}
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        {canWrite && (
                          <div className="flex justify-end gap-1">
                            <IconButton tip={`Editar ${s.name}`} onClick={() => openPanel(s)}>
                              <PencilIcon className="h-4 w-4" />
                            </IconButton>
                            <IconButton
                              tip={
                                s.active
                                  ? `Desativar ${s.name}: deixa de aparecer para novas implantações`
                                  : `Reativar ${s.name}`
                              }
                              onClick={() => toggleActive(s)}
                              disabled={busyId === s.id}
                            >
                              <PowerIcon className="h-4 w-4" />
                            </IconButton>
                            <IconButton
                              tip={
                                s.deploymentCount > 0
                                  ? `Não é possível apagar ${s.name}: já foi implantado, e apagar perderia o histórico. Desative em vez de apagar.`
                                  : `Apagar ${s.name}`
                              }
                              onClick={() => askDelete(s)}
                              disabled={busyId === s.id || s.deploymentCount > 0}
                              danger
                            >
                              <TrashIcon className="h-4 w-4" />
                            </IconButton>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {discardThen && (
          <ConfirmDialog
            title="Descartar alterações?"
            confirmLabel="Descartar"
            cancelLabel="Continuar editando"
            onCancel={() => setDiscardThen(null)}
            onConfirm={() => {
              const then = discardThen;
              setDiscardThen(null);
              then();
            }}
          >
            As alterações deste software ainda não foram salvas.
          </ConfirmDialog>
        )}

        {confirmDelete && (
          <ConfirmDialog
            title="Apagar software?"
            confirmLabel="Apagar"
            onCancel={() => setConfirmDelete(null)}
            onConfirm={() => remove(confirmDelete)}
          >
            "{confirmDelete.name} {confirmDelete.version}" será removido do catálogo
            {confirmDelete.installer ? ', junto com o arquivo do instalador' : ''}. Isso não pode ser desfeito.
          </ConfirmDialog>
        )}
      </div>

      {/* Painel de cadastro/edição (SidePanel): coluna fixa em telas largas, sobreposto nas menores. */}
      {panelNode}
    </div>
  );
}

function TypeBadge({ type }: { type: Software['installType'] }) {
  return (
    <span
      className="inline-flex w-10 shrink-0 justify-center rounded border border-slate-200 bg-slate-50 py-0.5 font-mono text-meta font-semibold text-slate-600"
      title={type === 'MSI' ? 'Windows Installer (MSI)' : 'Executável (EXE)'}
    >
      {type}
    </span>
  );
}

function Badge({ tone, children }: { tone: 'green' | 'slate' | 'amber'; children: ReactNode }) {
  const styles = {
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    slate: 'border-slate-200 bg-slate-100 text-slate-600',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
  }[tone];
  return (
    <span className={`inline-flex rounded-md border px-2 py-0.5 text-meta font-medium whitespace-nowrap ${styles}`}>
      {children}
    </span>
  );
}

/**
 * Botão só com ícone, com a dica como nome (Tooltip asLabel). Desativado por aria-disabled
 * (não disabled): continua focável, para a dica com o motivo chegar ao teclado.
 */
function IconButton(props: { tip: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <Tooltip content={props.tip} align="end" asLabel>
      <button
        type="button"
        aria-disabled={props.disabled || undefined}
        onClick={() => !props.disabled && props.onClick()}
        className={`rounded-md p-1.5 text-slate-400 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/50 aria-disabled:cursor-not-allowed aria-disabled:opacity-30 ${
          props.danger ? 'hover:bg-red-50 hover:text-red-600' : 'hover:bg-slate-100 hover:text-slate-700'
        } aria-disabled:hover:bg-transparent aria-disabled:hover:text-slate-400`}
      >
        {props.children}
      </button>
    </Tooltip>
  );
}

function EmptyState({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-16 text-center">
      <p className="text-body font-medium text-slate-700">{title}</p>
      {detail && <p className="mt-1 text-body text-slate-500">{detail}</p>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
