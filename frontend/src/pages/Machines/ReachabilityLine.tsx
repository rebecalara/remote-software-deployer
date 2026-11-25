import { AlertTriangleIcon, RefreshIcon } from '../../components/icons';
import type { ReachabilityStatus } from '../../types/machine';
import { formatDateTime, formatRelative } from '../../utils/format';

/**
 * Linha curta do resumo da tela de Máquinas: "WinRM verificado há 8 min". Os detalhes
 * (data exata, erro, motivo de estar desligada, automático desativado) ficam na dica.
 * lastCheckedAt: reserva vinda das máquinas, para quando o backend acabou de reiniciar e o
 * status em memória ainda está vazio.
 */
export function ReachabilityLine({
  status,
  lastCheckedAt,
  now,
}: {
  status: ReachabilityStatus | null;
  lastCheckedAt: string | null;
  now: number;
}) {
  if (!status) return null;
  if (!status.available) {
    return (
      <p className="text-meta text-slate-500" data-testid="reachability-line" title={status.unavailableReason ?? undefined}>
        WinRM: verificação desligada neste servidor
      </p>
    );
  }
  if (status.running) {
    return (
      <p className="flex items-center gap-1.5 text-meta text-blue-700" data-testid="reachability-line">
        <RefreshIcon className="h-3.5 w-3.5 animate-spin" />
        Verificando o WinRM
        {status.progress && status.progress.total > 0 && <> · {status.progress.checked} de {status.progress.total}</>}…
      </p>
    );
  }
  if (status.lastError) {
    return (
      <p className="flex items-center gap-1.5 text-meta text-amber-800" role="alert" data-testid="reachability-line" title={status.lastError}>
        <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0" />
        Falha ao verificar o WinRM {formatRelative(status.lastRunAt, now)}
      </p>
    );
  }
  const checkedAt = status.lastResult?.checkedAt ?? lastCheckedAt;
  return (
    <p
      className="text-meta text-slate-500"
      data-testid="reachability-line"
      title={[checkedAt ? `Verificado em ${formatDateTime(checkedAt)}` : null, status.autoCheckEnabled ? null : 'Verificação automática desativada']
        .filter(Boolean)
        .join(' · ') || undefined}
    >
      {checkedAt ? `WinRM verificado ${formatRelative(checkedAt, now)}` : 'WinRM ainda não verificado'}
    </p>
  );
}
