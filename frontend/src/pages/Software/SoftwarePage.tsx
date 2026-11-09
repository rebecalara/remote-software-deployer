import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PencilIcon, PlusIcon, PowerIcon, SearchIcon, TrashIcon } from '../../components/icons';
import { useAuth } from '../../context/AuthContext';
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
import { SoftwareFormModal } from './SoftwareFormModal';

type StatusFilter = 'active' | 'inactive' | 'all';

/** Janela aberta: cadastro novo (software null) ou um software existente. */
type ModalState = { software: Software | null } | null;

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
  const [modal, setModal] = useState<ModalState>(null);
  const [confirmDelete, setConfirmDelete] = useState<Software | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

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

  async function remove(software: Software) {
    setConfirmDelete(null);
    setBusyId(software.id);
    setFeedback(null);
    try {
      await deleteSoftware(software.id);
      setFeedback({ kind: 'success', text: `"${software.name} ${software.version}" apagado do catálogo.` });
      await load();
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setFeedback({ kind: 'error', text: messageOf(err) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-4 sm:p-6">
      {/* Barra de ferramentas */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-56 flex-1">
          <span className="sr-only">Buscar software</span>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, fabricante ou versão"
            className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pr-3 pl-9 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          />
        </label>

        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          aria-label="Filtrar por status"
          className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-500 sm:flex-none"
        >
          <option value="active">Ativos ({activeCount})</option>
          <option value="inactive">Desativados ({inactiveCount})</option>
          <option value="all">Todos ({activeCount + inactiveCount})</option>
        </select>

        <span className="text-sm text-slate-500">
          {filtered.length} {filtered.length === 1 ? 'software' : 'softwares'}
        </span>

        {canWrite && (
          <button
            type="button"
            onClick={() => setModal({ software: null })}
            className="ml-auto inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800"
          >
            <PlusIcon className="h-4 w-4" />
            Adicionar software
          </button>
        )}
      </div>

      {feedback && (
        <p
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          className={`mt-4 rounded-lg px-3 py-2 text-sm ${
            feedback.kind === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'
          }`}
        >
          {feedback.text}
        </p>
      )}

      {/* Tabela */}
      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {loadError ? (
          <EmptyState title="Não foi possível carregar o catálogo." detail={loadError}>
            <button type="button" onClick={load} className="text-sm font-medium text-blue-700 hover:underline">
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
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3">Software</th>
                  <th scope="col" className="px-4 py-3">Versão</th>
                  <th scope="col" className="px-4 py-3">Fabricante</th>
                  <th scope="col" className="px-4 py-3">Implantações</th>
                  <th scope="col" className="px-4 py-3">Tamanho</th>
                  <th scope="col" className="px-4 py-3">Atualizado</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => setModal({ software: s })}
                    className={`cursor-pointer transition-colors hover:bg-slate-50 ${s.active ? '' : 'text-slate-400'}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <TypeBadge type={s.installType} />
                        <span className={`font-medium ${s.active ? 'text-slate-900' : ''}`}>{s.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-[13px] whitespace-nowrap">{s.version}</td>
                    <td className="px-4 py-3">{s.vendor ?? <span className="text-slate-400">—</span>}</td>
                    <td className="px-4 py-3 tabular-nums">{s.deploymentCount}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {s.installer ? (
                        formatBytes(s.installer.sizeBytes)
                      ) : (
                        <Badge tone="amber">Sem instalador</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatDate(s.updatedAt)}</td>
                    <td className="px-4 py-3">
                      {s.active ? <Badge tone="green">Ativo</Badge> : <Badge tone="slate">Desativado</Badge>}
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      {canWrite && (
                        <div className="flex justify-end gap-1">
                          <IconButton label={`Editar ${s.name}`} onClick={() => setModal({ software: s })}>
                            <PencilIcon className="h-4 w-4" />
                          </IconButton>
                          <IconButton
                            label={s.active ? `Desativar ${s.name}` : `Reativar ${s.name}`}
                            title={s.active ? 'Desativar' : 'Reativar'}
                            onClick={() => toggleActive(s)}
                            disabled={busyId === s.id}
                          >
                            <PowerIcon className="h-4 w-4" />
                          </IconButton>
                          <IconButton
                            label={`Apagar ${s.name}`}
                            title={
                              s.deploymentCount > 0
                                ? 'Já implantado: não pode ser apagado, para preservar o histórico. Desative em vez de apagar.'
                                : 'Apagar'
                            }
                            onClick={() => setConfirmDelete(s)}
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

      {modal && (
        <SoftwareFormModal
          software={modal.software}
          limits={limits}
          canWrite={canWrite}
          onClose={() => setModal(null)}
          onChanged={() => void load()}
          onSaved={(saved, message) => {
            setModal(null);
            setFeedback({ kind: 'success', text: `${message} (${saved.name} ${saved.version})` });
            void load();
          }}
        />
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
  );
}

function TypeBadge({ type }: { type: Software['installType'] }) {
  return (
    <span
      className="inline-flex w-10 shrink-0 justify-center rounded border border-slate-200 bg-slate-50 py-0.5 font-mono text-[11px] font-semibold text-slate-600"
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
    <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${styles}`}>
      {children}
    </span>
  );
}

function IconButton(props: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.title ?? props.label}
      onClick={props.onClick}
      disabled={props.disabled}
      className={`rounded-md p-1.5 text-slate-400 transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
        props.danger ? 'hover:bg-red-50 hover:text-red-600' : 'hover:bg-slate-100 hover:text-slate-700'
      } disabled:hover:bg-transparent disabled:hover:text-slate-400`}
    >
      {props.children}
    </button>
  );
}

function ConfirmDialog(props: {
  title: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h2 id="confirm-title" className="text-lg font-semibold text-slate-900">{props.title}</h2>
        <p className="mt-2 text-sm text-slate-600">{props.children}</p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={props.onConfirm}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
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
