import { AlertTriangleIcon, RefreshIcon } from '../../components/icons';
import { formatDateTime, formatRelative } from '../../utils/format';
import type { SyncStatus } from '../../types/machine';

interface SyncStatusLineProps {
  status: SyncStatus | null;
  /** Reserva quando o backend acabou de reiniciar e o status em memória ainda está vazio. */
  lastSyncAt: string | null;
  now: number;
}

/**
 * Linha curta do resumo da tela de Máquinas: "AD sincronizado há 9 min". Deixa visível a
 * falha da sincronização AUTOMÁTICA — sem isso, a lista só ficaria desatualizada em
 * silêncio. Os detalhes (data exata, erro, automático desativado) ficam na dica.
 */
export function SyncStatusLine({ status, lastSyncAt, now }: SyncStatusLineProps) {
  if (status?.running) {
    return (
      <p className="flex items-center gap-1.5 text-meta text-blue-700" data-testid="sync-line">
        <RefreshIcon className="h-3.5 w-3.5 animate-spin" />
        Sincronizando com o AD…
      </p>
    );
  }

  const lastSuccess = status?.lastResult?.syncedAt ?? lastSyncAt;

  if (status?.lastError) {
    return (
      <p
        className="flex items-center gap-1.5 text-meta text-amber-800"
        role="alert"
        data-testid="sync-line"
        title={`${status.lastError}${lastSuccess ? ` · último sucesso em ${formatDateTime(lastSuccess)}` : ''}`}
      >
        <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0" />
        Falha ao sincronizar com o AD {formatRelative(status.lastRunAt, now)}
      </p>
    );
  }

  const off = status !== null && !status.autoSyncEnabled;
  return (
    <p
      className="text-meta text-slate-500"
      data-testid="sync-line"
      title={[lastSuccess ? `Sincronizado em ${formatDateTime(lastSuccess)}` : null, off ? 'Sincronização automática desativada' : null]
        .filter(Boolean)
        .join(' · ') || undefined}
    >
      {lastSuccess ? `AD sincronizado ${formatRelative(lastSuccess, now)}` : 'AD ainda não sincronizado'}
    </p>
  );
}
