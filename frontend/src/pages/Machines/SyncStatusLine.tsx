import { AlertTriangleIcon, RefreshIcon } from '../../components/icons';
import { formatRelative } from '../../utils/format';
import type { SyncStatus } from '../../types/machine';

interface SyncStatusLineProps {
  status: SyncStatus | null;
  /** Fallback quando o backend acabou de reiniciar e o status em memória ainda está vazio. */
  lastSyncAt: string | null;
  now: number;
}

/**
 * Deixa visível a falha da sincronização AUTOMÁTICA — sem isso, a lista só
 * ficaria desatualizada em silêncio.
 */
export function SyncStatusLine({ status, lastSyncAt, now }: SyncStatusLineProps) {
  if (status?.running) {
    return (
      <p className="flex items-center gap-2 text-xs text-blue-700">
        <RefreshIcon className="h-3.5 w-3.5 animate-spin" />
        Sincronizando com o AD…
      </p>
    );
  }

  const lastSuccess = status?.lastResult?.syncedAt ?? lastSyncAt;

  if (status?.lastError) {
    return (
      <p className="flex items-start gap-2 text-xs text-amber-800" role="alert">
        <AlertTriangleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
        <span>
          Última tentativa de sincronização falhou {formatRelative(status.lastRunAt, now)}: {status.lastError}
          {lastSuccess && <> · Último sucesso {formatRelative(lastSuccess, now)}</>}
        </span>
      </p>
    );
  }

  return (
    <p className="text-xs text-slate-500">
      {lastSuccess ? <>Última sincronização {formatRelative(lastSuccess, now)}</> : 'Ainda não sincronizado'}
      {status && !status.autoSyncEnabled && <> · Sincronização automática desativada</>}
      {status?.nextRunAt && <> · Próxima {formatRelative(status.nextRunAt, now)}</>}
    </p>
  );
}
