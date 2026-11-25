import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { AlertTriangleIcon, InfoIcon, UploadIcon } from '../../components/icons';
import { Sha256 } from '../../components/Sha256';
import { SidePanel } from '../../components/SidePanel';
import { Tooltip } from '../../components/Tooltip';
import { ApiError, SessionExpiredError, UploadCancelledError } from '../../services/apiClient';
import { createSoftware, updateSoftware, uploadInstaller } from '../../services/softwareService';
import type { InstallType, InstallerLimits, Software, SoftwareUpdateInput } from '../../types/software';
import { formatBytes, formatDateTime } from '../../utils/format';
import { ARGS_PRESETS, argIndexFromField, argsToText, textToArgs } from './installArgsPresets';

interface SoftwareFormPanelProps {
  /** null = cadastro novo. */
  software: Software | null;
  limits: InstallerLimits | null;
  /** false (VIEWER) = só leitura, sem salvar. */
  canWrite: boolean;
  /**
   * Pedido para fechar (X, Cancelar, Esc). Quem decide é a página: com alteração não salva,
   * ela pergunta antes, na janela de confirmação do sistema.
   */
  onClose: () => void;
  /** Salvo por completo: a página recarrega a lista e fecha o painel. */
  onSaved: (software: Software, message: string) => void;
  /** Algo foi salvo, mas o painel continua aberto (ex.: cadastro feito, envio falhou). */
  onChanged: () => void;
  /** Avisa a página se há alteração não salva / envio em andamento (fechar pelo fundo, trocar de linha). */
  onGuardChange?: (guard: { dirty: boolean; saving: boolean }) => void;
}

type FieldErrors = Partial<Record<'name' | 'version' | 'vendor' | 'installType' | 'installArgs' | 'file', string>>;

const EXTENSION: Record<InstallType, string> = { MSI: '.msi', EXE: '.exe' };
const TYPE_LABEL: Record<InstallType, string> = { EXE: 'EXE (executável)', MSI: 'MSI (Windows Installer)' };

const DEPLOYED_REASON =
  'Versão, tipo, argumentos e instalador ficam travados depois da primeira implantação, para o histórico continuar fiel. Para outra versão, cadastre um novo software.';
const MSI_ARGS_INFO =
  'O comando é fixo: msiexec.exe /i <instalador> /qn /norestart … REBOOT=ReallySuppress. Aqui só entram propriedades públicas do Windows Installer, no formato NOME=valor.';
const EXE_ARGS_INFO =
  'Passados ao instalador como parâmetros, nunca como linha de comando. Espaços só dentro de aspas, ex.: /DIR="C:\\Program Files\\App".';

const FOCUSABLE = 'rounded-md outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50';
const ICON_BUTTON =
  'rounded-md p-1 text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-blue-500/50';

/**
 * Cadastro e edição do catálogo num painel lateral, no padrão do "Detalhes da máquina":
 * cabeçalho e rodapé fixos, só o conteúdo rola. Regra: dado na tela, explicação na dica.
 */
export function SoftwareFormPanel({
  software,
  limits,
  canWrite,
  onClose,
  onSaved,
  onChanged,
  onGuardChange,
}: SoftwareFormPanelProps) {
  // Depois do cadastro (etapa 1), o painel passa a editar o registro criado — assim,
  // se o envio do arquivo (etapa 2) falhar, dá para tentar de novo sem recadastrar.
  const [current, setCurrent] = useState<Software | null>(software);
  const [name, setName] = useState(software?.name ?? '');
  const [version, setVersion] = useState(software?.version ?? '');
  const [vendor, setVendor] = useState(software?.vendor ?? '');
  const [installType, setInstallType] = useState<InstallType>(software?.installType ?? 'EXE');
  const [argsText, setArgsText] = useState(argsToText(software?.installArgs ?? []));
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const formId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const readOnly = !canWrite;
  // Travas do backend, mostradas na tela em vez de descobertas pelo erro.
  const deployed = (current?.deploymentCount ?? 0) > 0;
  const typeLocked = readOnly || deployed || current?.installer != null;
  const execLocked = readOnly || deployed;
  const storageOff = limits !== null && !limits.storageAvailable;
  const fileDisabled = execLocked || storageOff || limits === null;

  const title = readOnly ? 'Detalhes do software' : current ? 'Editar software' : 'Adicionar software';

  // Alteração não salva: comparada com o que está gravado (ou com o formulário vazio).
  const dirty =
    !readOnly &&
    (file !== null ||
      name !== (current?.name ?? '') ||
      version !== (current?.version ?? '') ||
      vendor !== (current?.vendor ?? '') ||
      installType !== (current?.installType ?? 'EXE') ||
      argsText !== argsToText(current?.installArgs ?? []));

  useEffect(() => {
    onGuardChange?.({ dirty, saving });
  }, [dirty, saving, onGuardChange]);

  // X, Cancelar, Esc e clique no fundo (SidePanel) chegam aqui. Durante o envio, só o
  // "Cancelar envio"; fora dele, a página decide (pergunta se houver alteração).
  const requestClose = () => {
    if (!saving) onClose();
  };

  /** Confere extensão e tamanho ANTES de enviar — arquivo recusado nunca sobe à toa. */
  function checkFile(candidate: File, type: InstallType): string | null {
    if (!candidate.name.toLowerCase().endsWith(EXTENSION[type])) {
      return typeLocked ? `Este software é ${type}: selecione um arquivo ${EXTENSION[type]}.` : 'Selecione um arquivo .msi ou .exe.';
    }
    if (limits && candidate.size > limits.maxSizeBytes) {
      return `O arquivo tem ${formatBytes(candidate.size)}; o máximo é ${formatBytes(limits.maxSizeBytes)}.`;
    }
    if (candidate.size === 0) return 'O arquivo está vazio.';
    return null;
  }

  function pickFile(candidate: File | undefined) {
    if (!candidate) return;
    // O arquivo vem primeiro: enquanto o tipo não está travado, ele segue a extensão escolhida.
    const lower = candidate.name.toLowerCase();
    const inferred: InstallType | null = lower.endsWith('.msi') ? 'MSI' : lower.endsWith('.exe') ? 'EXE' : null;
    let type = installType;
    if (!typeLocked && inferred && inferred !== installType) {
      type = inferred;
      setInstallType(inferred);
      setArgsText(argsToText(ARGS_PRESETS[inferred][0].args));
      setErrors((e) => ({ ...e, installArgs: undefined, installType: undefined }));
    }
    const problem = checkFile(candidate, type);
    setErrors((e) => ({ ...e, file: problem ?? undefined }));
    setFile(problem ? null : candidate);
  }

  function changeType(type: InstallType) {
    if (type === installType) return;
    setInstallType(type);
    // Argumentos de EXE não servem para MSI e vice-versa: recomeça pelo modelo padrão.
    setArgsText(argsToText(ARGS_PRESETS[type][0].args));
    setErrors((e) => ({ ...e, installArgs: undefined, installType: undefined }));
    if (file && !file.name.toLowerCase().endsWith(EXTENSION[type])) {
      setFile(null);
      setErrors((e) => ({ ...e, file: `O arquivo selecionado não é ${EXTENSION[type]}; selecione outro.` }));
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (!fileDisabled) pickFile(event.dataTransfer.files[0]);
  }

  /** Erro da API → campo certo (o 400 do catálogo informa o campo, ex.: installArgs[2]). */
  function showApiError(err: unknown, prefix = '') {
    if (err instanceof SessionExpiredError) return; // o AuthContext leva ao login
    const message = err instanceof Error ? err.message : 'Erro inesperado.';
    if (err instanceof ApiError && err.field) {
      const argIndex = argIndexFromField(err.field);
      if (argIndex !== null) {
        setErrors((e) => ({ ...e, installArgs: `Linha ${argIndex + 1}: ${message}` }));
        return;
      }
      if (['name', 'version', 'vendor', 'installType', 'installArgs'].includes(err.field)) {
        setErrors((e) => ({ ...e, [err.field as keyof FieldErrors]: message }));
        return;
      }
    }
    setFormError(prefix + message);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (readOnly || saving) return;
    setErrors({});
    setFormError(null);

    const local: FieldErrors = {};
    if (!name.trim()) local.name = 'Informe o nome do software.';
    if (!version.trim()) local.version = 'Informe a versão.';
    if (Object.keys(local).length > 0) return setErrors(local);

    setSaving(true);
    const args = textToArgs(argsText);
    let saved = current;

    // Etapa 1: os dados, em JSON.
    try {
      if (!saved) {
        saved = await createSoftware({ name, version, vendor: vendor.trim() || null, installType, installArgs: args });
      } else {
        const changes = diff(saved, { name, version, vendor: vendor.trim() || null, installType, installArgs: args });
        if (Object.keys(changes).length > 0) saved = await updateSoftware(saved.id, changes);
      }
    } catch (err) {
      showApiError(err);
      setSaving(false);
      return;
    }

    // Etapa 2: o instalador, com progresso e cancelamento.
    if (file) {
      const wasNew = current === null;
      setCurrent(saved);
      const controller = new AbortController();
      abortRef.current = controller;
      setProgress(0);
      try {
        saved = await uploadInstaller(saved.id, file, {
          onProgress: (p) => setProgress(p.percent),
          signal: controller.signal,
        });
      } catch (err) {
        setProgress(null);
        setSaving(false);
        onChanged();
        const what = wasNew ? 'O software foi cadastrado, mas ' : 'Os dados foram salvos, mas ';
        if (err instanceof UploadCancelledError) {
          setFormError(`${what}o envio do instalador foi cancelado. Você pode enviar de novo.`);
        } else {
          showApiError(err, `${what}o envio do instalador falhou: `);
        }
        return;
      } finally {
        abortRef.current = null;
      }
    }

    setSaving(false);
    onSaved(saved, current ? 'Software atualizado.' : 'Software adicionado ao catálogo.');
  }

  const args = textToArgs(argsText);

  const nameField = (
    <Field label="Nome do software" required={!readOnly} htmlFor="sw-name" error={errors.name}>
      {readOnly ? (
        <ReadValue>{name}</ReadValue>
      ) : (
        <input
          id="sw-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: 7-Zip"
          className={inputClass(errors.name)}
        />
      )}
    </Field>
  );

  const vendorField = (
    <Field label="Fabricante" htmlFor="sw-vendor" error={errors.vendor}>
      {readOnly ? (
        <ReadValue>{vendor || '—'}</ReadValue>
      ) : (
        <input
          id="sw-vendor"
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          placeholder="Ex.: Igor Pavlov"
          className={inputClass(errors.vendor)}
        />
      )}
    </Field>
  );

  // Rodapé fixo: progresso do envio, erro geral e os botões.
  const footer = (
    <div className="space-y-3">
      {progress !== null && (
        <div role="status" aria-live="polite" data-testid="upload-progress">
          <div className="flex items-center justify-between text-body text-blue-800">
            <span>Enviando instalador… {progress}%</span>
            <button type="button" onClick={() => abortRef.current?.abort()} className="font-medium hover:underline">
              Cancelar envio
            </button>
          </div>
          <div
            className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100"
            role="progressbar"
            aria-label="Envio do instalador"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {formError && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-body text-red-700">
          {formError}
        </p>
      )}

      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={requestClose}
          disabled={saving}
          className="rounded-lg bg-slate-100 px-4 py-2.5 text-body font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-50"
        >
          {readOnly ? 'Fechar' : 'Cancelar'}
        </button>
        {!readOnly && (
          // Sem alteração, não há o que salvar.
          <button
            type="submit"
            form={formId}
            disabled={saving || !dirty}
            className="rounded-lg bg-blue-700 px-5 py-2.5 text-body font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <SidePanel title={title} onClose={requestClose} closeDisabled={saving} footer={footer} testId="software-panel">
      <form id={formId} onSubmit={handleSubmit} noValidate className="space-y-5">
        {deployed && (
          <Notice testId="deployed-notice" info={DEPLOYED_REASON}>
            Já implantado: só nome e fabricante podem mudar.
          </Notice>
        )}

        {execLocked ? (
          // Já implantado (ou só leitura): primeiro o que pode mudar; o resto num bloco de leitura.
          <>
            {nameField}
            {vendorField}
            <InstallerDetails current={current} version={version} installType={installType} args={args} />
          </>
        ) : (
          <>
            {/* Arquivo de instalação primeiro: o tipo segue a extensão escolhida. */}
            <InstallerSection
              current={current}
              file={file}
              installType={installType}
              limits={limits}
              storageOff={storageOff}
              fileDisabled={fileDisabled}
              dragging={dragging}
              error={errors.file}
              onDragState={setDragging}
              onDrop={onDrop}
              onBrowse={() => fileInputRef.current?.click()}
              onRemove={() => setFile(null)}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept={typeLocked ? EXTENSION[installType] : '.msi,.exe'}
              className="hidden"
              data-testid="installer-input"
              onChange={(e) => {
                pickFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />

            {nameField}

            <Field label="Versão" required htmlFor="sw-version" error={errors.version}>
              <input
                id="sw-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="Ex.: 26.06"
                className={`${inputClass(errors.version)} font-mono`}
              />
            </Field>

            {vendorField}

            <Field
              label="Tipo do instalador"
              required={!typeLocked}
              error={errors.installType}
              info={typeLocked ? 'O tipo não muda depois que o instalador foi enviado.' : undefined}
            >
              {typeLocked ? (
                <ReadValue testId="type-value">{TYPE_LABEL[installType]}</ReadValue>
              ) : (
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Tipo do instalador">
                  {(['EXE', 'MSI'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      role="radio"
                      aria-checked={installType === type}
                      onClick={() => changeType(type)}
                      className={`rounded-lg border px-3 py-2 text-body font-medium transition-colors ${
                        installType === type
                          ? 'border-blue-600 bg-blue-50 text-blue-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {TYPE_LABEL[type]}
                    </button>
                  ))}
                </div>
              )}
            </Field>

            <Field
              label={installType === 'MSI' ? 'Propriedades do MSI' : 'Argumentos de instalação silenciosa'}
              htmlFor="sw-args"
              error={errors.installArgs}
              info={installType === 'MSI' ? MSI_ARGS_INFO : EXE_ARGS_INFO}
              hint={installType === 'MSI' ? 'Propriedades NOME=valor, uma por linha' : 'Um argumento por linha'}
            >
              <select
                aria-label="Modelo de argumentos"
                value=""
                onChange={(e) => {
                  const preset = ARGS_PRESETS[installType].find((p) => p.id === e.target.value);
                  if (preset) setArgsText(argsToText(preset.args));
                }}
                className="mb-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-body text-slate-600 outline-none focus:border-blue-500"
              >
                <option value="">Usar um modelo…</option>
                {ARGS_PRESETS[installType].map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                    {preset.args.length > 0 ? ` — ${preset.args.join(' ')}` : ''}
                  </option>
                ))}
              </select>
              <textarea
                id="sw-args"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder={installType === 'MSI' ? 'ALLUSERS=1' : '/S'}
                className={`${inputClass(errors.installArgs)} font-mono`}
              />
            </Field>
          </>
        )}

        {current && (
          <dl className="space-y-1 border-t border-slate-100 pt-4 text-meta text-slate-500">
            <div>
              <dt className="inline">Cadastrado por </dt>
              <dd className="inline font-medium text-slate-700">{who(current.createdBy)}</dd>
              <dd className="inline"> em {formatDateTime(current.createdAt)}</dd>
            </div>
            <div>
              <dt className="inline">Alterado por </dt>
              <dd className="inline font-medium text-slate-700">{who(current.updatedBy)}</dd>
              <dd className="inline"> em {formatDateTime(current.updatedAt)}</dd>
            </div>
          </dl>
        )}
      </form>
    </SidePanel>
  );
}

/** Bloco só leitura do software já implantado: o que define a execução e o arquivo. */
function InstallerDetails({
  current,
  version,
  installType,
  args,
}: {
  current: Software | null;
  version: string;
  installType: InstallType;
  args: string[];
}) {
  return (
    <section>
      <h3 className="mb-1.5 text-body font-medium text-slate-700">Detalhes do instalador</h3>
      <dl
        className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-body"
        data-testid="installer-details"
      >
        <InfoRow label="Versão">
          <span className="font-mono">{version}</span>
        </InfoRow>
        <InfoRow label="Tipo">{TYPE_LABEL[installType]}</InfoRow>
        <InfoRow label={installType === 'MSI' ? 'Propriedades' : 'Argumentos'}>
          {args.length > 0 ? (
            <ul className="font-mono break-all" data-testid="args-value">
              {args.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          ) : (
            <span data-testid="args-value">Nenhum</span>
          )}
        </InfoRow>
        {current?.installer ? (
          <InstallerFileRows current={current} />
        ) : (
          <InfoRow label="Arquivo">Nenhum instalador enviado</InfoRow>
        )}
      </dl>
    </section>
  );
}

/** Dados do arquivo enviado (nome, tamanho, SHA-256, data, desinstalação). */
function InstallerFileRows({ current }: { current: Software }) {
  const installer = current.installer;
  if (!installer) return null;
  return (
    <>
      <InfoRow label="Arquivo">
        <span className="break-all">{installer.originalName}</span>
      </InfoRow>
      <InfoRow label="Tamanho">{formatBytes(installer.sizeBytes)}</InfoRow>
      <InfoRow label="SHA-256">{installer.sha256 ? <Sha256 value={installer.sha256} /> : '—'}</InfoRow>
      <InfoRow label="Enviado em">{formatDateTime(installer.uploadedAt)}</InfoRow>
      {/* Desinstalação remota: só MSI, pelo ProductCode lido pelo servidor no envio. */}
      <InfoRow label="Desinstalação">
        {current.installType === 'MSI' && current.msiProductCode ? (
          <Tooltip content={`ProductCode ${current.msiProductCode}`}>
            <span tabIndex={0} className={FOCUSABLE} data-testid="product-code">
              Sim (MSI)
            </span>
          </Tooltip>
        ) : (
          <Tooltip
            content={
              current.installType === 'MSI'
                ? 'O ProductCode deste MSI não foi lido. Envie o instalador de novo.'
                : 'Só MSI: um EXE não traz um código de produto confiável.'
            }
          >
            <span tabIndex={0} className={FOCUSABLE} data-testid="product-code">
              Não
            </span>
          </Tooltip>
        )}
      </InfoRow>
    </>
  );
}

interface InstallerSectionProps {
  current: Software | null;
  file: File | null;
  installType: InstallType;
  limits: InstallerLimits | null;
  storageOff: boolean;
  fileDisabled: boolean;
  dragging: boolean;
  error?: string;
  onDragState: (dragging: boolean) => void;
  onDrop: (event: DragEvent) => void;
  onBrowse: () => void;
  onRemove: () => void;
}

function InstallerSection(props: InstallerSectionProps) {
  const { current, file, installType, limits, storageOff, fileDisabled, dragging, error } = props;
  const installer = current?.installer ?? null;
  const replacing = installer !== null;

  return (
    <div>
      <p className="mb-1.5 text-body font-medium text-slate-700">Arquivo de instalação</p>

      {installer && current && (
        <dl className="mb-3 space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-body">
          <InstallerFileRows current={current} />
        </dl>
      )}


      {storageOff && (
        <Notice info="A pasta de instaladores não está configurada no servidor. Os dados do software podem ser salvos normalmente.">
          Envio de instaladores desativado neste servidor.
        </Notice>
      )}

      {!fileDisabled &&
        (file ? (
          <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-body" data-testid="picked-file">
            <span className="min-w-0 truncate text-blue-900">
              {replacing ? 'Novo arquivo: ' : ''}
              <strong>{file.name}</strong> · {formatBytes(file.size)}
            </span>
            <button type="button" onClick={props.onRemove} className="ml-3 shrink-0 text-blue-700 hover:underline">
              Remover
            </button>
          </div>
        ) : (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              props.onDragState(true);
            }}
            onDragLeave={() => props.onDragState(false)}
            onDrop={props.onDrop}
            className={`flex flex-col items-center rounded-lg border-2 border-dashed px-4 py-5 text-center text-body transition-colors ${
              dragging ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white'
            }`}
          >
            <UploadIcon className="h-6 w-6 text-slate-400" />
            <p className="mt-2 text-slate-600">
              {replacing ? 'Trocar: arraste o novo arquivo' : 'Arraste o instalador'} (
              {replacing ? EXTENSION[installType] : '.msi ou .exe'}) ou{' '}
              <button type="button" onClick={props.onBrowse} className="font-medium text-blue-700 hover:underline">
                clique para selecionar
              </button>
            </p>
            {limits && <p className="mt-1 text-meta text-slate-400">Máximo {formatBytes(limits.maxSizeBytes)}</p>}
          </div>
        ))}

      {error && (
        <p role="alert" className="mt-1.5 text-body text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  required,
  htmlFor,
  error,
  hint,
  info,
  children,
}: {
  label: string;
  required?: boolean;
  htmlFor?: string;
  error?: string;
  hint?: string;
  /** Explicação: vai numa dica no (i) ao lado do rótulo. */
  info?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1">
        <label htmlFor={htmlFor} className="text-body font-medium text-slate-700">
          {label}
          {required && <span aria-hidden="true"> *</span>}
        </label>
        {info && (
          <Tooltip content={info}>
            <button type="button" aria-label={`Sobre: ${label}`} className={ICON_BUTTON}>
              <InfoIcon className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        )}
      </div>
      {children}
      {error ? (
        <p role="alert" className="mt-1.5 text-body text-red-600">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1.5 text-meta text-slate-500">{hint}</p>
      )}
    </div>
  );
}

/** Campo travado: texto de leitura, não caixa cinza. */
function ReadValue({ children, mono, testId }: { children: ReactNode; mono?: boolean; testId?: string }) {
  return (
    <p className={`text-body break-words text-slate-900 ${mono ? 'font-mono' : ''}`} data-testid={testId}>
      {children}
    </p>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-900">{children}</dd>
    </div>
  );
}

function Notice({ children, info, testId }: { children: ReactNode; info?: string; testId?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-body text-amber-800" data-testid={testId}>
      <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="flex-1">{children}</span>
      {info && (
        <Tooltip content={info} align="end">
          <button
            type="button"
            aria-label="Por quê?"
            className="rounded-md p-0.5 text-amber-700 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-500/50"
          >
            <InfoIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

function inputClass(error?: string): string {
  return `w-full rounded-lg border bg-white px-3 py-2.5 text-body text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 ${
    error ? 'border-red-300 focus:border-red-500 focus:ring-red-500/20' : 'border-slate-200 focus:border-blue-500 focus:ring-blue-500/20'
  }`;
}

function who(user: Software['createdBy']): string {
  return user ? user.displayName || user.username : '—';
}

/** Só os campos que mudaram — o PATCH não deve "alterar" o que ficou igual. */
function diff(
  saved: Software,
  next: { name: string; version: string; vendor: string | null; installType: InstallType; installArgs: string[] },
): SoftwareUpdateInput {
  const changes: SoftwareUpdateInput = {};
  if (next.name.trim() !== saved.name) changes.name = next.name;
  if (next.version.trim() !== saved.version) changes.version = next.version;
  if (next.vendor !== saved.vendor) changes.vendor = next.vendor;
  if (next.installType !== saved.installType) changes.installType = next.installType;
  if (JSON.stringify(next.installArgs) !== JSON.stringify(saved.installArgs)) changes.installArgs = next.installArgs;
  return changes;
}
