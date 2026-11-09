import type { MachineStatus } from '../../types/machine';

const STATUS_STYLES: Record<MachineStatus, { label: string; className: string; dot: string }> = {
  ONLINE: { label: 'Online', className: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  OFFLINE: { label: 'Offline', className: 'border-slate-200 bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  // O AD não sabe se a máquina está ligada; status real vem com o monitoramento (Bloco 5).
  UNKNOWN: { label: 'Não verificado', className: 'border-slate-200 bg-white text-slate-500', dot: 'bg-slate-300' },
};

export function StatusBadge({ status }: { status: MachineStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${style.className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden="true" />
      {style.label}
    </span>
  );
}

/** Máquina que não apareceu na sincronização mais recente (saiu do AD). */
export function MissingFromAdBadge() {
  return (
    <span className="inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-800">
      Não encontrada no AD
    </span>
  );
}
