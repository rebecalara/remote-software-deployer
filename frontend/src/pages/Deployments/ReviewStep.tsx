import { useState, type ReactNode } from 'react';
import { AlertTriangleIcon, ChevronRightIcon } from '../../components/icons';
import { Sha256 } from '../../components/Sha256';
import { Tooltip, TooltipTarget } from '../../components/Tooltip';
import type { DeploymentAction } from '../../types/deployment';
import type { Machine } from '../../types/machine';
import type { Software } from '../../types/software';
import { formatBytes } from '../../utils/format';
import { MissingFromAdBadge, StatusBadge } from '../Machines/MachineBadges';
import { OutsideCatalogBadge, VendorBadge } from './deploymentUi';
import { REMOTE_DIR, commandText, uninstallCommandText } from './installCommand';
import type { UninstallTarget } from './uninstallTarget';
import { InfoTip, StepCard, TypeBadge } from './wizardParts';

interface ReviewProps {
  machines: Machine[];
  /** Instalação: o software do catálogo. */
  software: Software | null;
  action: DeploymentAction;
  /** Desinstalação: o que remover (MSI pelo ProductCode ou programa pelo comando do fabricante). */
  uninstallTarget: UninstallTarget | null;
  /** Produto fora do catálogo ou comando do fabricante: "Iniciar" só depois de marcar. */
  requireConfirm: boolean;
  confirmed: boolean;
  onConfirm: (value: boolean) => void;
  /** Erro do servidor ao iniciar (a seleção continua). */
  error: string | null;
}


/**
 * Passo 3 (último): o que vai rodar e onde. O botão "Iniciar" fica na barra de baixo.
 * Regra: dado na tela, explicação na dica; o comando e os passos ficam em "Detalhes técnicos".
 */
export function ReviewStep({ machines, software, action, uninstallTarget, requireConfirm, confirmed, onConfirm, error }: ReviewProps) {
  const uninstall = action === 'UNINSTALL';
  const target = uninstall ? uninstallTarget! : null;
  const vendor = target?.method === 'VENDOR';

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <MachineList machines={machines} />
        {target ? <UninstallCard machines={machines} target={target} /> : <SoftwareCard software={software!} />}
      </div>

      <WinRmWarning machines={machines} />

      {/* Um aviso só. O comando do fabricante pode reiniciar a máquina: a frase muda. */}
      <Notice
        testId="review-notice"
        info={
          vendor
            ? 'O comando é do fabricante do programa, não do sistema: pode reiniciar a máquina sem aviso. Se ele tentar abrir uma janela, ninguém a verá (roda sem área de trabalho) e ele será encerrado no tempo limite.'
            : 'Se o instalador pedir reinício, a máquina fica registrada com o aviso "reinício pendente".'
        }
      >
        {vendor
          ? 'Executa como administrador. O comando do fabricante pode reiniciar a máquina. Máquinas desligadas ficam registradas como falha.'
          : 'Executa como administrador. As máquinas nunca são reiniciadas. Máquinas desligadas ficam registradas como falha.'}
      </Notice>

      {requireConfirm && (
        <div className="flex items-start gap-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-body text-amber-900">
          <label className="flex flex-1 items-start gap-2">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => onConfirm(e.target.checked)}
              className="mt-1"
              data-testid="confirm-outside-catalog"
            />
            <span>
              {vendor
                ? 'Confirmo a execução do comando do fabricante nestas máquinas.'
                : 'Confirmo que este produto, que não está no catálogo, pode ser removido destas máquinas.'}
            </span>
          </label>
          <InfoTip
            label="Por que confirmar?"
            content={
              vendor
                ? 'Programas que não são MSI só são removidos pelo comando silencioso que eles mesmos declararam. O sistema confere o comando, mas não sabe o que o desinstalador faz.'
                : 'Confira se ele pode sair destas máquinas: antivírus, agentes de gerenciamento e bibliotecas usadas por outros programas costumam aparecer no inventário.'
            }
          />
        </div>
      )}

      <TechnicalDetails software={software} target={target} />

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 text-body text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function SoftwareCard({ software }: { software: Software }) {
  return (
    <StepCard title="Software selecionado">
      <dl className="space-y-3 px-4 py-4 text-body sm:px-6">
        <div className="flex items-center gap-3">
          <TypeBadge type={software.installType} />
          <span className="font-semibold text-slate-900">{software.name}</span>
          <span className="font-mono text-slate-600">{software.version}</span>
        </div>
        <Field label="Fabricante">{software.vendor ?? '—'}</Field>
        <Field label="Arquivo">{software.installer?.originalName ?? '—'}</Field>
        <Field label="Tamanho">{formatBytes(software.installer?.sizeBytes ?? null)}</Field>
        <Field label="SHA-256">{software.installer?.sha256 ? <Sha256 value={software.installer.sha256} /> : '—'}</Field>
      </dl>
    </StepCard>
  );
}

function UninstallCard({ machines, target }: { machines: Machine[]; target: UninstallTarget }) {
  const vendor = target.method === 'VENDOR';
  const others = machines.length - target.machinesWith;
  return (
    <StepCard title="Software a desinstalar">
      <dl className="space-y-3 px-4 py-4 text-body sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          {!vendor && <TypeBadge type="MSI" />}
          <span className="font-semibold text-slate-900">{target.name}</span>
          {target.version && <span className="font-mono text-slate-600">{target.version}</span>}
          {vendor ? <VendorBadge /> : !target.inCatalog && <OutsideCatalogBadge />}
        </div>
        <Field label="Fabricante">{target.publisher ?? '—'}</Field>
        <Field label="Método">
          <span data-testid="confirm-method">{vendor ? 'Comando do fabricante' : 'Windows Installer (MSI)'}</span>
        </Field>
        {!vendor && (
          <Field label="ProductCode">
            <span className="font-mono text-meta break-all text-slate-700">{target.productCode}</span>
          </Field>
        )}
        <Field label="No catálogo">
          {target.catalogActive === null ? (
            'Não cadastrado'
          ) : target.catalogActive ? (
            'Ativo'
          ) : (
            <Tooltip content="Desativado no catálogo: a desinstalação continua permitida.">
              <TooltipTarget>Desativado</TooltipTarget>
            </Tooltip>
          )}
        </Field>
        <Field label="Nas máquinas">
          <Tooltip
            content={
              others > 0
                ? `Segundo o inventário guardado. ${others === 1 ? 'A outra máquina deve terminar' : `As outras ${others} devem terminar`} como "não estava instalado".`
                : 'Segundo o inventário guardado de cada máquina.'
            }
          >
            <TooltipTarget data-testid="coverage">
              {target.machinesWith} de {machines.length}
            </TooltipTarget>
          </Tooltip>
        </Field>
      </dl>
    </StepCard>
  );
}

function MachineList({ machines }: { machines: Machine[] }) {
  return (
    <StepCard title={`Máquinas selecionadas (${machines.length})`}>
      <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
        {machines.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:px-6">
            <span className="font-mono text-body font-semibold text-slate-900">{m.hostname}</span>
            <span className="text-meta text-slate-500">{m.department ?? 'Sem setor'}</span>
            <span className="ml-auto flex gap-1.5">
              <StatusBadge status={m.status} />
              {!m.seenInLastSync && <MissingFromAdBadge />}
            </span>
          </li>
        ))}
      </ul>
    </StepCard>
  );
}

/** Aviso amarelo (não bloqueia): máquinas "Sem resposta" ou "Não verificado" na última verificação. */
function WinRmWarning({ machines }: { machines: Machine[] }) {
  const silent = machines.filter((m) => m.status !== 'ONLINE').length;
  if (silent === 0) return null;
  const text =
    machines.length === 1
      ? 'A máquina não respondeu no WinRM na última verificação.'
      : `${silent} das ${machines.length} máquinas não responderam no WinRM na última verificação.`;
  return (
    <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-body text-amber-900" data-testid="winrm-warning">
      <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{text}</span>
    </p>
  );
}

/** "Detalhes técnicos", fechado por padrão: o comando exato e os passos em cada máquina. */
function TechnicalDetails({ software, target }: { software: Software | null; target: UninstallTarget | null }) {
  const [open, setOpen] = useState(false);
  const vendor = target?.method === 'VENDOR';
  const command = target
    ? vendor
      ? target.command
      : uninstallCommandText({ msiProductCode: target.productCode })
    : commandText(software!);
  const commandInfo = target
    ? vendor
      ? 'Comando silencioso declarado pelo próprio programa no registro (QuietUninstallString), lido no inventário guardado e conferido pelas regras do sistema.'
      : 'O ProductCode vem do inventário guardado das máquinas. Nenhum argumento do catálogo é usado, e REBOOT=ReallySuppress vai sempre por último.'
    : `${REMOTE_DIR} é uma pasta temporária criada em cada máquina, e <instalador> é a cópia do arquivo guardado pelo sistema.${
        software!.installType === 'MSI' ? ' REBOOT=ReallySuppress vai sempre por último.' : ''
      }`;

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm" data-testid="technical-details">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-section font-semibold text-slate-900 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/50 sm:px-6"
      >
        <ChevronRightIcon className={`h-4 w-4 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`} />
        Detalhes técnicos
      </button>
      {open && (
        <div className="space-y-4 border-t border-slate-100 px-4 py-4 text-body sm:px-6">
          <div>
            <div className="mb-1.5 flex items-center gap-1">
              <p className="text-meta font-semibold tracking-wide text-slate-500 uppercase">Comando executado</p>
              <InfoTip label="Sobre o comando" content={commandInfo} />
            </div>
            <pre
              data-testid="install-command"
              className="overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 font-mono text-body whitespace-pre-wrap break-all text-slate-100"
            >
              {command}
            </pre>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-slate-600">
            {!target && (
              <>
                <li>Copia o instalador ({formatBytes(software!.installer?.sizeBytes ?? null)}) para a máquina, pelo compartilhamento administrativo.</li>
                <li>Confere o SHA-256 da cópia na própria máquina; se não bater, não executa.</li>
                {software!.installType === 'MSI' && <li>Se o produto já estiver instalado na máquina, não executa de novo.</li>}
                <li>Executa o comando acima e registra o código de saída.</li>
                <li>Apaga a pasta temporária.</li>
              </>
            )}
            {target && !vendor && (
              <>
                <li>Conecta à máquina pelo WinRM. Nada é copiado para a máquina.</li>
                <li>Confere se o produto (ProductCode) está instalado; se não estiver, registra "não estava instalado".</li>
                <li>Executa o comando acima e registra o código de saída.</li>
              </>
            )}
            {vendor && (
              <>
                <li>Conecta à máquina pelo WinRM. Nada é copiado para a máquina.</li>
                <li>
                  Relê o comando no registro da máquina: se o programa não estiver mais lá, registra "não estava instalado";
                  se o comando mudou desde a consulta, não executa nada.
                </li>
                <li>Confere o comando e o executável (Program Files, sem atalhos) e registra a assinatura digital.</li>
                <li>Executa o comando acima, com tempo limite.</li>
                <li>Sucesso = o programa saiu do registro da máquina (espera até 2 minutos), qualquer que seja o código de saída.</li>
              </>
            )}
          </ol>
        </div>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-800">{children}</dd>
    </div>
  );
}

function Notice({ children, info, testId }: { children: ReactNode; info: string; testId?: string }) {
  return (
    <div className="flex items-start gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-body text-slate-700" data-testid={testId}>
      <span className="flex-1">{children}</span>
      <InfoTip label="Mais sobre este aviso" content={info} />
    </div>
  );
}
