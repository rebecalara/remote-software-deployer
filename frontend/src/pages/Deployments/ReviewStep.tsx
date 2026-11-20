import type { ReactNode } from 'react';
import { AlertTriangleIcon } from '../../components/icons';
import type { DeploymentAction } from '../../types/deployment';
import type { Machine } from '../../types/machine';
import type { Software } from '../../types/software';
import { formatBytes } from '../../utils/format';
import { MissingFromAdBadge, StatusBadge } from '../Machines/MachineBadges';
import { OutsideCatalogBadge, VendorBadge } from './deploymentUi';
import { REMOTE_DIR, commandText, uninstallCommandText } from './installCommand';
import type { UninstallTarget } from './uninstallTarget';
import { StepCard, TypeBadge, plural } from './wizardParts';

interface ReviewProps {
  machines: Machine[];
  /** Instalação: o software do catálogo. */
  software: Software | null;
  action: DeploymentAction;
  /** Desinstalação: o MSI escolhido (do inventário ou do catálogo). */
  uninstallTarget: UninstallTarget | null;
}

/** Passo 3: o que vai rodar, onde e como — com o comando exato. */
export function ReviewStep({ machines, software: maybeSoftware, action, uninstallTarget }: ReviewProps) {
  if (action === 'UNINSTALL') return <UninstallReview machines={machines} target={uninstallTarget!} />;
  const software = maybeSoftware!;
  const size = software.installer?.sizeBytes ?? null;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <MachineList machines={machines} />

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
            <Notice tone="amber">
              O instalador é <strong>executado como administrador</strong> nas máquinas selecionadas.
            </Notice>
            <Notice tone="blue">
              O sistema <strong>nunca reinicia as máquinas</strong>. Se o instalador pedir reinício, a instalação é
              registrada com o aviso "reinício pendente".
            </Notice>
          </div>

          <p className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2.5 text-blue-900">
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

function MachineList({ machines }: { machines: Machine[] }) {
  return (
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
  );
}

/** Revisão da desinstalação (só MSI): nada é copiado; só o ProductCode vai para a máquina. */
function UninstallReview({ machines, target }: { machines: Machine[]; target: UninstallTarget }) {
  const others = machines.length - target.machinesWith;
  const vendor = target.method === 'VENDOR';
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <MachineList machines={machines} />

        <StepCard title="Software a desinstalar">
          <dl className="space-y-3 px-4 py-4 text-sm sm:px-6">
            <div className="flex flex-wrap items-center gap-3">
              {vendor ? (
                <span className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500">Outro</span>
              ) : (
                <TypeBadge type="MSI" />
              )}
              <span className="font-semibold text-slate-900">{target.name}</span>
              {target.version && <span className="font-mono text-slate-600">{target.version}</span>}
              {vendor ? <VendorBadge /> : !target.inCatalog && <OutsideCatalogBadge />}
            </div>
            <Field label="Fabricante">{target.publisher ?? '—'}</Field>
            {!vendor && (
              <Field label="ProductCode">
                <span className="font-mono text-xs break-all text-slate-700">{target.productCode}</span>
              </Field>
            )}
            <Field label="No catálogo">
              {target.catalogActive === null
                ? 'Não cadastrado'
                : target.catalogActive
                  ? 'Ativo'
                  : 'Desativado (a desinstalação continua permitida)'}
            </Field>
            <Field label="Nas máquinas">
              <span data-testid="coverage">
                {`Segundo o inventário, ${target.machinesWith} de ${plural(machines.length, 'máquina', 'máquinas')}${
                      others === 1
                        ? '; a outra deve terminar como "não estava instalado"'
                        : others
                          ? `; as outras ${others} devem terminar como "não estava instalado"`
                          : ''
                    }.`}
              </span>
            </Field>
          </dl>
        </StepCard>
      </div>

      {vendor && (
        <Notice tone="amber" icon={<AlertTriangleIcon className="h-4 w-4" />}>
          <span data-testid="vendor-warning">
            <strong>Este comando é do fabricante do programa, não do sistema.</strong> Ele pode reiniciar a máquina sem
            aviso, e o sistema não tem como impedir. Se ele tentar abrir uma janela, ninguém a verá (roda sem área de
            trabalho) e ele será encerrado no tempo limite.
          </span>
        </Notice>
      )}

      {!vendor && !target.inCatalog && (
        <Notice tone="amber" icon={<AlertTriangleIcon className="h-4 w-4" />}>
          <span data-testid="outside-catalog-warning">
            Este produto não foi cadastrado no catálogo. Confira se ele pode ser removido destas máquinas (ex.: antivírus,
            agentes de gerenciamento, bibliotecas usadas por outros programas).
          </span>
        </Notice>
      )}

      <StepCard title="Como a desinstalação vai rodar em cada máquina">
        <div className="space-y-4 px-4 py-4 text-sm sm:px-6">
          <div>
            <p className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">Comando executado</p>
            <pre
              data-testid="install-command"
              className="overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 font-mono text-[13px] whitespace-pre-wrap break-all text-slate-100"
            >
              {vendor ? target.command : uninstallCommandText({ msiProductCode: target.productCode })}
            </pre>
            <p className="mt-1.5 text-xs text-slate-500">
              {vendor
                ? 'Comando silencioso declarado pelo próprio programa no registro (QuietUninstallString), lido no inventário guardado e conferido pelas regras do sistema.'
                : 'O ProductCode vem do software instalado lido das máquinas (inventário guardado). Nenhum argumento do catálogo é usado, e REBOOT=ReallySuppress vai sempre por último.'}
            </p>
          </div>

          {vendor ? (
            <ol className="list-decimal space-y-1 pl-5 text-slate-600">
              <li>Conecta à máquina pelo WinRM. Nada é copiado para a máquina.</li>
              <li>
                Relê o comando no registro da máquina: se o programa não estiver mais lá, registra "não estava
                instalado"; se o comando mudou desde a consulta, não executa nada.
              </li>
              <li>Confere o comando e o executável (Program Files, sem atalhos) e registra a assinatura digital.</li>
              <li>Executa o comando acima, com tempo limite.</li>
              <li>Sucesso = o programa saiu do registro da máquina (espera até 2 minutos), qualquer que seja o código de saída.</li>
            </ol>
          ) : (
            <ol className="list-decimal space-y-1 pl-5 text-slate-600">
              <li>Conecta à máquina pelo WinRM. Nada é copiado para a máquina.</li>
              <li>
                Confere se o produto (ProductCode) está instalado; se não estiver, não executa nada e registra "não estava
                instalado".
              </li>
              <li>Executa o comando acima e registra o código de saída.</li>
            </ol>
          )}

          <div className="space-y-2">
            <Notice tone="amber">
              O produto é <strong>removido</strong> das máquinas selecionadas, com o comando executado como administrador.
            </Notice>
            {!vendor && (
              <Notice tone="blue">
                O sistema <strong>nunca reinicia as máquinas</strong>. Se a desinstalação pedir reinício, ela é registrada
                com o aviso "reinício pendente".
              </Notice>
            )}
          </div>

          <p className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2.5 text-blue-900">
            <strong>Resumo:</strong> {target.name}
            {target.version ? ` ${target.version}` : ''} será desinstalado de{' '}
            {plural(machines.length, 'máquina', 'máquinas')}.
          </p>
        </div>
      </StepCard>
    </div>
  );
}

interface ConfirmProps {
  machineCount: number;
  /** "7-Zip 26.06" — o software ou o produto. */
  targetName: string;
  action: DeploymentAction;
  error: string | null;
  /** Produto fora do catálogo: o botão só libera depois de marcar a confirmação. */
  requireConfirm: boolean;
  /** Comando do fabricante: o texto da confirmação fala do comando. */
  vendor?: boolean;
  confirmed: boolean;
  onConfirm: (value: boolean) => void;
}

/** Passo 4: confirmação. O botão "Iniciar …" fica na barra fixa do rodapé. */
export function ConfirmStep({ machineCount, targetName, action, error, requireConfirm, vendor, confirmed, onConfirm }: ConfirmProps) {
  const uninstall = action === 'UNINSTALL';
  return (
    <section className="rounded-xl border border-slate-200 bg-white px-4 py-8 shadow-sm sm:px-6">
      <div className="mx-auto max-w-lg text-center">
        <h2 className="text-lg font-semibold text-slate-900">{uninstall ? 'Confirmar desinstalação' : 'Confirmar implantação'}</h2>
        <p className="mt-1 text-sm text-slate-500">
          {uninstall
            ? 'Você está prestes a iniciar a desinstalação remota. Esta ação remove o software selecionado das máquinas de destino.'
            : 'Você está prestes a iniciar a implantação remota. Esta ação instala o software selecionado nas máquinas de destino.'}
        </p>

        <dl className="mt-6 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-slate-50 text-left text-sm">
          <Row label="Máquinas de destino">{machineCount}</Row>
          <Row label="Software">{targetName}</Row>
          <Row label={uninstall ? 'Desinstalações (uma por máquina)' : 'Instalações (uma por máquina)'}>{machineCount}</Row>
          <Row label="Início">Imediato, em segundo plano</Row>
        </dl>

        <div className="mt-4 text-left">
          <Notice tone="amber" icon={<AlertTriangleIcon className="h-4 w-4" />}>
            {uninstall
              ? 'Esta ação inicia as desinstalações imediatamente, como administrador. Confira se o produto pode ser removido das máquinas agora. Máquinas desligadas ou fora da rede ficam registradas como falha.'
              : 'Esta ação inicia as instalações imediatamente, como administrador. Confira se as máquinas podem receber a instalação agora. Máquinas desligadas ou fora da rede ficam registradas como falha.'}
          </Notice>
        </div>

        {requireConfirm && (
          <label className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-left text-sm text-amber-900">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => onConfirm(e.target.checked)}
              className="mt-0.5"
              data-testid="confirm-outside-catalog"
            />
            <span>
              {vendor ? (
                <>
                  <strong>Confirmo a execução do comando do fabricante</strong> nas máquinas selecionadas, ciente de que
                  ele pode reiniciar a máquina sem aviso.
                </>
              ) : (
                <>
                  <strong>Confirmo que este produto pode ser removido</strong> das máquinas selecionadas. Ele não está no
                  catálogo do sistema.
                </>
              )}
            </span>
          </label>
        )}

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

/** Aviso; `icon` só para sinal de alerta (o triângulo), nunca enfeite. */
function Notice({ tone, icon, children }: { tone: 'amber' | 'blue'; icon?: ReactNode; children: ReactNode }) {
  const styles =
    tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-slate-200 bg-slate-50 text-slate-700';
  return (
    <p className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${styles}`}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <span>{children}</span>
    </p>
  );
}
