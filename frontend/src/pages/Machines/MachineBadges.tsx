import { forwardRef, type HTMLAttributes } from 'react';
import type { MachineStatus } from '../../types/machine';
import { formatDateTime, formatRelative } from '../../utils/format';

// Resultado da verificação da porta do WinRM (5985), só teste de conexão. Nome honesto: a
// porta aceitar conexão não quer dizer que a máquina está "online" nem pronta para implantar.
// Cores (decisão da autora): verde só para "Respondendo"; "Sem resposta" e "Não verificado" em
// cinza neutro (máquina desligada não é erro); amarelo só para "Não encontrada no AD". Sem
// vermelho no status — vale para a tabela, o painel e a Nova Implantação (mesmo componente).
const STATUS_STYLES: Record<MachineStatus, { label: string; className: string; dot: string }> = {
  ONLINE: { label: 'Respondendo no WinRM', className: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  OFFLINE: { label: 'Sem resposta', className: 'border-slate-200 bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  UNKNOWN: { label: 'Não verificado', className: 'border-slate-200 bg-white text-slate-500', dot: 'bg-slate-300' },
};

export const MACHINE_STATUS_LABEL: Record<MachineStatus, string> = {
  ONLINE: STATUS_STYLES.ONLINE.label,
  OFFLINE: STATUS_STYLES.OFFLINE.label,
  UNKNOWN: STATUS_STYLES.UNKNOWN.label,
};

/** Texto da dica do selo: quando a porta foi verificada (ou por que não foi). */
export function machineStatusHint(status: MachineStatus, checkedAt: string | null, verificationOff: boolean, now?: number): string {
  if (verificationOff) return 'Verificação do WinRM desligada neste servidor';
  if (status === 'UNKNOWN' || !checkedAt) return 'A porta do WinRM (5985) ainda não foi verificada';
  return now === undefined
    ? `Porta do WinRM (5985) verificada em ${formatDateTime(checkedAt)}`
    : `Porta do WinRM (5985) verificada ${formatRelative(checkedAt, now)} (${formatDateTime(checkedAt)})`;
}

/**
 * checkedAt: data da verificação (aparece ao passar o mouse). verificationOff: modo
 * demonstração — tudo "Não verificado", mesmo que o banco tenha um resultado antigo.
 * nativeTitle false: o selo está dentro de um <Tooltip> acessível (não repete o title).
 */
export const StatusBadge = forwardRef<
  HTMLSpanElement,
  {
    status: MachineStatus;
    checkedAt?: string | null;
    verificationOff?: boolean;
    nativeTitle?: boolean;
  } & HTMLAttributes<HTMLSpanElement>
>(function StatusBadge({ status, checkedAt = null, verificationOff = false, nativeTitle = true, className = '', ...rest }, ref) {
  const effective: MachineStatus = verificationOff ? 'UNKNOWN' : status;
  const style = STATUS_STYLES[effective];
  return (
    <span
      ref={ref}
      title={nativeTitle ? machineStatusHint(effective, checkedAt, verificationOff) : undefined}
      data-testid="machine-status"
      data-status={effective}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-meta font-medium whitespace-nowrap ${style.className} ${className}`}
      {...rest}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden="true" />
      {style.label}
    </span>
  );
});

/** Máquina que não apareceu na sincronização mais recente (saiu do AD). */
export function MissingFromAdBadge(props: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...props}
      className={`inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-meta font-medium whitespace-nowrap text-amber-800 ${props.className ?? ''}`}
    >
      Não encontrada no AD
    </span>
  );
}
