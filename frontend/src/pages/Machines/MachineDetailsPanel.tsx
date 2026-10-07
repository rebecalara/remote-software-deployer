import { useEffect, type ReactNode } from 'react';
import { MonitorIcon, XIcon } from '../../components/icons';
import { formatDateTime, formatRelative } from '../../utils/format';
import type { Machine } from '../../types/machine';
import { MissingFromAdBadge, StatusBadge } from './MachineBadges';

interface MachineDetailsPanelProps {
  machine: Machine;
  now: number;
  onClose: () => void;
}

// Só dado real: o que o AD fornece. CPU/RAM/disco, IP e software instalado
// dependem de WinRM (Bloco 4 em diante) — ver DECISIONS.md, recorte do mockup.
export function MachineDetailsPanel({ machine, now, onClose }: MachineDetailsPanelProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      aria-label={`Detalhes da máquina ${machine.hostname}`}
      className="flex h-full w-full flex-col bg-white xl:w-80 xl:rounded-xl xl:border xl:border-slate-200 xl:shadow-sm"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-slate-900">Detalhes da máquina</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar detalhes"
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
            <MonitorIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="font-mono text-base font-semibold break-all text-slate-900">{machine.hostname}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <StatusBadge status={machine.status} />
              {!machine.seenInLastSync && <MissingFromAdBadge />}
            </div>
          </div>
        </div>

        <dl className="mt-6 space-y-3 text-sm">
          <Row label="Sistema operacional">{machine.operatingSystem ?? <Muted>Não informado no AD</Muted>}</Row>
          <Row label="Setor">{machine.department ?? <Muted>Sem OU de setor</Muted>}</Row>
          <Row label="Endereço IP">{machine.ipAddress ?? <Muted>Não disponível no AD</Muted>}</Row>
          <Row label="Confirmada no AD em">
            {formatDateTime(machine.lastSync)}
            {machine.lastSync && <span className="block text-xs text-slate-400">{formatRelative(machine.lastSync, now)}</span>}
          </Row>
        </dl>

        {!machine.seenInLastSync && (
          <p className="mt-6 rounded-lg bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
            Esta máquina não apareceu na sincronização mais recente — pode ter sido removida ou
            movida para fora da OU monitorada. Ela continua no sistema para preservar o histórico,
            mas não pode ser selecionada para implantação.
          </p>
        )}

        <p className="mt-6 text-xs text-slate-400">
          O status de conexão (online/offline) será verificado a partir do módulo de monitoramento.
        </p>
      </div>
    </aside>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-900">{children}</dd>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="font-normal text-slate-400">{children}</span>;
}
