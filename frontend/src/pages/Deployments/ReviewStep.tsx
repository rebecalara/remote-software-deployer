import type { ReactNode } from 'react';
import { AlertTriangleIcon, InfoIcon, PlayIcon, PowerIcon, ShieldIcon } from '../../components/icons';
import type { Machine } from '../../types/machine';
import type { Software } from '../../types/software';
import { formatBytes } from '../../utils/format';
import { MissingFromAdBadge, StatusBadge } from '../Machines/MachineBadges';
import { REMOTE_DIR, commandText } from './installCommand';
import { StepCard, TypeBadge, plural } from './wizardParts';

interface ReviewProps {
  machines: Machine[];
  software: Software;
}

/** Passo 3: o que vai rodar, onde e como — com o comando exato. */
export function ReviewStep({ machines, software }: ReviewProps) {
  const size = software.installer?.sizeBytes ?? null;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <StepCard title={`Máquinas selecionadas (${machines.length})`}>
          <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
            {machines.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:px-6">
                <span className="font-mono text-[13px] font-semibold text-slate-900">{m.hostname}</span>
                <span className="text-xs text-slate-500">{m.department ?? 'Sem setor'}</span>
                <span className="ml-auto flex gap-1.5">
                  <StatusBadge status={m.status} />
                  {!m.seenInLastSync && <MissingFromAdBadge />}
                </span>
              </li>
            ))}
          </ul>
        </StepCard>

        <StepCard title="Software selecionado">
          <dl className="space-y-3 px-4 py-4 text-sm sm:px-6">
            <div className="flex items-center gap-3">
              <TypeBadge type={software.installType} />
              <span className="font-semibold text-slate-900">{software.name}</span>
              <span className="font-mono text-slate-600">{software.version}</span>
            </div>
            <Field label="Fabricante">{software.vendor ?? '—'}</Field>
            <Field label="Arquivo">{software.installer?.originalName ?? '—'}</Field>
            <Field label="Tamanho do instalador">{formatBytes(size)}</Field>
            <Field label="SHA-256">
              <span className="font-mono text-xs break-all text-slate-700">{software.installer?.sha256 ?? '—'}</span>
            </Field>
          </dl>
        </StepCard>
      </div>

      <StepCard title="Como a instalação vai rodar em cada máquina">
        <div className="space-y-4 px-4 py-4 text-sm sm:px-6">
          <div>
            <p className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">Comando executado</p>
            <pre
              data-testid="install-command"
              className="overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 font-mono text-[13px] whitespace-pre-wrap break-all text-slate-100"
            >
              {commandText(software)}
            </pre>
            <p className="mt-1.5 text-xs text-slate-500">
              <span className="font-mono">{REMOTE_DIR}</span> é uma pasta temporária criada em cada máquina, e{' '}
              <span className="font-mono">&lt;instalador&gt;</span> é a cópia do arquivo guardado pelo sistema.
              {software.installType === 'MSI' && ' REBOOT=ReallySuppress vai sempre por último.'}
            </p>
          </div>

          <ol className="list-decimal space-y-1 pl-5 text-slate-600">
            <li>Copia o instalador ({formatBytes(size)}) para a máquina, pelo compartilhamento administrativo.</li>
            <li>Confere o SHA-256 da cópia na própria máquina; se não bater, não executa.</li>
            {software.installType === 'MSI' && <li>Se o produto já estiver instalado na máquina, não executa de novo.</li>}
            <li>Executa o comando acima e registra o código de saída.</li>
            <li>Apaga a pasta temporária.</li>
          </ol>

          <div className="space-y-2">
            <Notice tone="amber" icon={<ShieldIcon className="h-4 w-4" />}>
              O instalador é <strong>executado como administrador</strong> nas máquinas selecionadas.
            </Notice>
            <Notice tone="blue" icon={<PowerIcon className="h-4 w-4" />}>
              O sistema <strong>nunca reinicia as máquinas</strong>. Se o instalador pedir reinício, a instalação é
              registrada com o aviso "reinício pendente".
            </Notice>
          </div>

          <p className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2.5 text-blue-900">
            <InfoIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>Resumo:</strong> {software.name} {software.version} será instalado em{' '}
              {plural(machines.length, 'máquina', 'máquinas')}. Cópia por máquina: {formatBytes(size)}
              {machines.length > 1 && size !== null && <> (total enviado pelo servidor: {formatBytes(size * machines.length)})</>}.
            </span>
          </p>
        </div>
      </StepCard>
    </div>
  );
}

interface ConfirmProps {
  machineCount: number;
  software: Software;
  error: string | null;
}

/** Passo 4: confirmação. O botão "Iniciar implantação" fica na barra fixa do rodapé. */
export function ConfirmStep({ machineCount, software, error }: ConfirmProps) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white px-4 py-8 shadow-sm sm:px-6">
      <div className="mx-auto max-w-lg text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-blue-50 text-blue-700">
          <PlayIcon className="h-7 w-7" />
        </span>
        <h2 className="mt-4 text-lg font-semibold text-slate-900">Confirmar implantação</h2>
        <p className="mt-1 text-sm text-slate-500">
          Você está prestes a iniciar a implantação remota. Esta ação instala o software selecionado nas máquinas de
          destino.
        </p>

        <dl className="mt-6 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-slate-50 text-left text-sm">
          <Row label="Máquinas de destino">{machineCount}</Row>
          <Row label="Software">
            {software.name} <span className="font-mono">{software.version}</span>
          </Row>
          <Row label="Instalações (uma por máquina)">{machineCount}</Row>
          <Row label="Início">Imediato, em segundo plano</Row>
        </dl>

        <div className="mt-4 text-left">
          <Notice tone="amber" icon={<AlertTriangleIcon className="h-4 w-4" />}>
            Esta ação inicia as instalações imediatamente, como administrador. Confira se as máquinas podem receber a
            instalação agora. Máquinas desligadas ou fora da rede ficam registradas como falha.
          </Notice>
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2.5 text-left text-sm text-red-700">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-800">{children}</dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <dt className="text-slate-600">{label}</dt>
      <dd className="font-semibold text-slate-900">{children}</dd>
    </div>
  );
}

function Notice({ tone, icon, children }: { tone: 'amber' | 'blue'; icon: ReactNode; children: ReactNode }) {
  const styles =
    tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-slate-200 bg-slate-50 text-slate-700';
  return (
    <p className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${styles}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{children}</span>
    </p>
  );
}
