import type { ReactNode } from 'react';
import { SidePanel } from '../../components/SidePanel';
import { Tooltip } from '../../components/Tooltip';
import { formatDateTime, formatRelative } from '../../utils/format';
import type { Machine } from '../../types/machine';
import { InventorySection } from './InventorySection';
import { MissingFromAdBadge, StatusBadge, machineStatusHint } from './MachineBadges';

interface MachineDetailsPanelProps {
  machine: Machine;
  now: number;
  onClose: () => void;
  /** Verificação do WinRM desligada neste servidor (modo demonstração). */
  reachabilityOff?: boolean;
  /** ADMIN/OPERATOR: consulta o software instalado ao vivo (RF08). */
  canCollect: boolean;
}

/** Elementos sem foco próprio que ganham dica: recebem foco pelo teclado. */
const FOCUSABLE = 'rounded-md outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50';

// Só dado real: o que o AD fornece e, sob demanda, o software instalado lido da própria
// máquina (RF08). IP e CPU/RAM/disco não vêm do AD — ver DECISIONS.md, recorte do mockup.
// Regra da tela: o painel mostra o dado; a explicação fica na dica (Tooltip acessível).
export function MachineDetailsPanel({ machine, now, onClose, canCollect, reachabilityOff = false }: MachineDetailsPanelProps) {
  return (
    <SidePanel
      title="Detalhes da máquina"
      ariaLabel={`Detalhes da máquina ${machine.hostname}`}
      onClose={onClose}
      closeLabel="Fechar detalhes"
    >
      <p className="font-mono text-section font-semibold break-all text-slate-900">{machine.hostname}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <Tooltip content={machineStatusHint(reachabilityOff ? 'UNKNOWN' : machine.status, machine.statusCheckedAt, reachabilityOff, now)}>
          <StatusBadge
            status={machine.status}
            checkedAt={machine.statusCheckedAt}
            verificationOff={reachabilityOff}
            nativeTitle={false}
            tabIndex={0}
            className={FOCUSABLE}
          />
        </Tooltip>
        {!machine.seenInLastSync && (
          <Tooltip content="Não apareceu na última sincronização com o AD: pode ter sido removida ou movida para fora da OU monitorada. Continua no sistema para preservar o histórico, mas não pode ser selecionada para implantação.">
            <MissingFromAdBadge tabIndex={0} className={FOCUSABLE} data-testid="panel-missing-badge" />
          </Tooltip>
        )}
      </div>

      <dl className="mt-6 space-y-3 text-body">
        <Row label="Sistema operacional">{machine.operatingSystem ?? <Muted>Não informado no AD</Muted>}</Row>
        <Row label="Setor">{machine.department ?? <Muted>Sem OU de setor</Muted>}</Row>
        <Row label="Confirmada no AD">
          {machine.lastSync ? (
            <Tooltip content={`Confirmada no AD em ${formatDateTime(machine.lastSync)}`} align="end">
              <span tabIndex={0} className={FOCUSABLE} data-testid="confirmed-at">
                {formatRelative(machine.lastSync, now)}
              </span>
            </Tooltip>
          ) : (
            <Muted>nunca</Muted>
          )}
        </Row>
      </dl>

      <InventorySection machine={machine} canCollect={canCollect} now={now} />
    </SidePanel>
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
