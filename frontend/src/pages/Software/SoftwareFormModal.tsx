import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { AlertTriangleIcon, UploadIcon, XIcon } from '../../components/icons';
import { ApiError, SessionExpiredError, UploadCancelledError } from '../../services/apiClient';
import { createSoftware, updateSoftware, uploadInstaller } from '../../services/softwareService';
import type { InstallType, InstallerLimits, Software, SoftwareUpdateInput } from '../../types/software';
import { formatBytes, formatDateTime } from '../../utils/format';
import { ARGS_PRESETS, argIndexFromField, argsToText, textToArgs } from './installArgsPresets';

interface SoftwareFormModalProps {
  /** null = cadastro novo. */
  software: Software | null;
  limits: InstallerLimits | null;
  /** false (VIEWER) = só leitura, sem salvar. */
  canWrite: boolean;
  onClose: () => void;
  /** Salvo por completo: a página recarrega a lista e fecha a janela. */
  onSaved: (software: Software, message: string) => void;
  /** Algo foi salvo, mas a janela continua aberta (ex.: cadastro feito, envio falhou). */
  onChanged: () => void;
}

type FieldErrors = Partial<Record<'name' | 'version' | 'vendor' | 'installType' | 'installArgs' | 'file', string>>;

const EXTENSION: Record<InstallType, string> = { MSI: '.msi', EXE: '.exe' };

export function SoftwareFormModal({ software, limits, canWrite, onClose, onSaved, onChanged }: SoftwareFormModalProps) {
  // Depois do cadastro (etapa 1), a janela passa a editar o registro criado — assim,
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const readOnly = !canWrite;
  // Travas do backend, explicadas na tela em vez de descobertas pelo erro.
  const deployed = (current?.deploymentCount ?? 0) > 0;
  const typeLocked = readOnly || deployed || current?.installer != null;
  const execLocked = readOnly || deployed;
  const storageOff = limits !== null && !limits.storageAvailable;
  const fileDisabled = execLocked || storageOff || limits === null;

  const title = readOnly ? 'Detalhes do software' : current ? 'Editar software' : 'Adicionar novo software';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !saving && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  /** Confere extensão e tamanho ANTES de enviar — arquivo recusado nunca sobe à toa. */
  function checkFile(candidate: File, type: InstallType): string | null {
    if (!candidate.name.toLowerCase().endsWith(EXTENSION[type])) {
      return `Para o tipo ${type}, selecione um arquivo ${EXTENSION[type]}.`;
    }
    if (limits && candidate.size > limits.maxSizeBytes) {
      return `O arquivo tem ${formatBytes(candidate.size)}; o máximo é ${formatBytes(limits.maxSizeBytes)}.`;
    }
    if (candidate.size === 0) return 'O arquivo está vazio.';
    return null;
  }

  function pickFile(candidate: File | undefined) {
    if (!candidate) return;
    const problem = checkFile(candidate, installType);
    setErrors((e) => ({ ...e, file: problem ?? undefined }));
    setFile(problem ? null : candidate);
  }

  function changeType(type: InstallType) {
    setInstallType(type);
    // Argumentos de EXE não servem para MSI e vice-versa: recomeça pelo modelo padrão.
    setArgsText(argsToText(ARGS_PRESETS[type][0].args));
    setErrors((e) => ({ ...e, installArgs: undefined, installType: undefined }));
    if (file && checkFile(file, type)) {
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
    if (readOnly) return;
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

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4 sm:p-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="software-form-title"
        className="w-full max-w-2xl rounded-2xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <h2 id="software-form-title" className="text-lg font-semibold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Fechar"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-5 px-6 py-5">
          {deployed && (
            <Notice>
              Este software já foi implantado: versão, tipo, argumentos e instalador não podem mais mudar,
              para o histórico continuar fiel. Para outra versão, cadastre um novo software.
            </Notice>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome do software *" error={errors.name}>
              <input
                id="sw-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={readOnly}
                placeholder="Ex.: 7-Zip"
                className={inputClass(errors.name)}
              />
            </Field>
            <Field label="Versão *" error={errors.version}>
              <input
                id="sw-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                disabled={execLocked}
                placeholder="Ex.: 26.06"
                className={`${inputClass(errors.version)} font-mono`}
              />
            </Field>
          </div>

          <Field label="Fabricante" error={errors.vendor}>
            <input
              id="sw-vendor"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              disabled={readOnly}
              placeholder="Ex.: Igor Pavlov"
              className={inputClass(errors.vendor)}
            />
          </Field>

          <Field
            label="Tipo do instalador *"
            error={errors.installType}
            hint={
              typeLocked && !readOnly && !deployed
                ? 'O tipo não muda depois que o instalador foi enviado.'
                : 'Define o comando de instalação e o arquivo aceito.'
            }
          >
            <div className="flex gap-2" role="radiogroup" aria-label="Tipo do instalador">
              {(['EXE', 'MSI'] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={installType === type}
                  disabled={typeLocked}
                  onClick={() => changeType(type)}
                  className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                    installType === type
                      ? 'border-blue-600 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:hover:bg-white'
                  } ${typeLocked && installType !== type ? 'opacity-40' : ''}`}
                >
                  {type === 'EXE' ? 'EXE (executável)' : 'MSI (Windows Installer)'}
                </button>
              ))}
            </div>
          </Field>

          <Field
            label="Argumentos de instalação silenciosa"
            error={errors.installArgs}
            hint={
              installType === 'MSI'
                ? 'O comando msiexec /i … /qn /norestart é fixo; aqui só entram propriedades NOME=valor. Um por linha.'
                : 'Um argumento por linha. Espaços só dentro de aspas (ex.: /DIR="C:\\Program Files\\App").'
            }
          >
            {!execLocked && (
              <select
                aria-label="Modelo de argumentos"
                value=""
                onChange={(e) => {
                  const preset = ARGS_PRESETS[installType].find((p) => p.id === e.target.value);
                  if (preset) setArgsText(argsToText(preset.args));
                }}
                className="mb-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 outline-none focus:border-blue-500"
              >
                <option value="">Usar um modelo…</option>
                {ARGS_PRESETS[installType].map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                    {preset.args.length > 0 ? ` — ${preset.args.join(' ')}` : ''}
                  </option>
                ))}
              </select>
            )}
            <textarea
              id="sw-args"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              disabled={execLocked}
              rows={4}
              spellCheck={false}
              placeholder={installType === 'MSI' ? 'ALLUSERS=1' : '/S'}
              className={`${inputClass(errors.installArgs)} font-mono text-[13px]`}
            />
          </Field>

          <InstallerSection
            current={current}
            file={file}
            installType={installType}
            limits={limits}
            storageOff={storageOff}
            fileDisabled={fileDisabled}
            readOnly={readOnly}
            deployed={deployed}
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
            accept={EXTENSION[installType]}
            className="hidden"
            onChange={(e) => {
              pickFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />

          {progress !== null && (
            <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3" role="status" aria-live="polite">
              <div className="flex items-center justify-between text-sm text-blue-800">
                <span>Enviando instalador… {progress}%</span>
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="font-medium hover:underline"
                >
                  Cancelar envio
                </button>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100">
                <div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {formError && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {formError}
            </p>
          )}

          {current && (
            <dl className="grid gap-1 border-t border-slate-100 pt-4 text-xs text-slate-500 sm:grid-cols-2">
              <div>
                <dt className="inline">Cadastrado por </dt>
                <dd className="inline font-medium text-slate-700">{who(current.createdBy)}</dd>
                <dd className="inline"> em {formatDateTime(current.createdAt)}</dd>
              </div>
              <div>
                <dt className="inline">Alterado por último por </dt>
                <dd className="inline font-medium text-slate-700">{who(current.updatedBy)}</dd>
                <dd className="inline"> em {formatDateTime(current.updatedAt)}</dd>
              </div>
            </dl>
          )}

          <div className="flex justify-end gap-3 border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-50"
            >
              {readOnly ? 'Fechar' : 'Cancelar'}
            </button>
            {!readOnly && (
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? 'Salvando…' : current ? 'Salvar alterações' : 'Adicionar ao catálogo'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

interface InstallerSectionProps {
  current: Software | null;
  file: File | null;
  installType: InstallType;
  limits: InstallerLimits | null;
  storageOff: boolean;
  fileDisabled: boolean;
  readOnly: boolean;
  deployed: boolean;
  dragging: boolean;
  error?: string;
  onDragState: (dragging: boolean) => void;
  onDrop: (event: DragEvent) => void;
  onBrowse: () => void;
  onRemove: () => void;
}

function InstallerSection(props: InstallerSectionProps) {
  const { current, file, installType, limits, storageOff, fileDisabled, readOnly, deployed, dragging, error } = props;
  const installer = current?.installer ?? null;
  const replacing = installer !== null;

  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-slate-700">Arquivo de instalação</p>

      {installer && (
        <dl className="mb-3 space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
          <InfoRow label="Arquivo">{installer.originalName}</InfoRow>
          <InfoRow label="Tamanho">{formatBytes(installer.sizeBytes)}</InfoRow>
          <InfoRow label="SHA-256">
            <span className="font-mono text-xs break-all">{installer.sha256}</span>
          </InfoRow>
          <InfoRow label="Enviado em">{formatDateTime(installer.uploadedAt)}</InfoRow>
        </dl>
      )}

      {!installer && readOnly && <p className="text-sm text-slate-500">Nenhum instalador enviado.</p>}

      {storageOff && !readOnly && !deployed && (
        <Notice>
          O envio de instaladores está desativado no servidor (pasta de instaladores não configurada).
          Os dados do software podem ser salvos normalmente.
        </Notice>
      )}

      {!fileDisabled &&
        (file ? (
          <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm">
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
            className={`flex flex-col items-center rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition-colors ${
              dragging ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white'
            }`}
          >
            <UploadIcon className="h-6 w-6 text-slate-400" />
            <p className="mt-2 text-slate-600">
              {replacing ? 'Para trocar, arraste o novo instalador' : 'Arraste o instalador'} ({EXTENSION_LABEL[installType]}) ou{' '}
              <button type="button" onClick={props.onBrowse} className="font-medium text-blue-700 hover:underline">
                clique para selecionar
              </button>
            </p>
            {limits && <p className="mt-1 text-xs text-slate-400">Tamanho máximo: {formatBytes(limits.maxSizeBytes)}</p>}
          </div>
        ))}

      {error && (
        <p role="alert" className="mt-1.5 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

const EXTENSION_LABEL: Record<InstallType, string> = { MSI: '.msi', EXE: '.exe' };

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-slate-700">{label}</label>
      {children}
      {error ? (
        <p role="alert" className="mt-1.5 text-sm text-red-600">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1.5 text-xs text-slate-500">{hint}</p>
      )}
    </div>
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

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
      <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function inputClass(error?: string): string {
  return `w-full rounded-lg border bg-white px-3 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 disabled:bg-slate-50 disabled:text-slate-500 ${
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
