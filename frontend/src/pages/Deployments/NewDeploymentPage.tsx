import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CheckCircleIcon, ChevronLeftIcon, ChevronRightIcon, PlayIcon } from '../../components/icons';
import { useAuth } from '../../context/AuthContext';
import { useNow } from '../../hooks/useNow';
import { ApiError, SessionExpiredError } from '../../services/apiClient';
import { createDeployment } from '../../services/deploymentService';
import { collectInventory, getInventorySummary } from '../../services/inventoryService';
import { listMachines } from '../../services/machineService';
import { listSoftware } from '../../services/softwareService';
import { MAX_TARGETS_PER_DEPLOYMENT, type Deployment, type DeploymentAction } from '../../types/deployment';
import type { Machine } from '../../types/machine';
import type { InventorySummary } from '../../types/inventory';
import type { Software } from '../../types/software';
import { deploymentTarget } from './deploymentUi';
import { MachineStep } from './MachineStep';
import { ConfirmStep, ReviewStep } from './ReviewStep';
import { SoftwareStep, unavailableReason } from './SoftwareStep';
import { UninstallChoices, type ConsultProgress } from './UninstallChoices';
import { fromInventory, machinesToConsult, type UninstallTarget } from './uninstallTarget';
import { Stepper, plural } from './wizardParts';

/** A tela de Máquinas abre esta com as máquinas já marcadas (state da navegação). */
export interface NewDeploymentLocationState {
  machineIds?: string[];
  /** RF08: atalho "Desinstalar" do inventário — software e ação já escolhidos. */
  softwareId?: string;
  /** Atalho "Desinstalar" do inventário: o MSI pelo ProductCode (pode estar fora do catálogo). */
  productCode?: string;
  action?: DeploymentAction;
  /** Abre no passo 3 (Revisar); a confirmação continua no passo 4. */
  startAtReview?: boolean;
}

const MACHINES = 0;
const SOFTWARE = 1;
const REVIEW = 2;
const EXECUTE = 3;

/** "Consultar agora": consultas ao mesmo tempo (o limite do servidor) e espera no 429. */
const CONSULT_PARALLEL = 5;
const RETRY_429_MS = 2_000;
const MAX_429_RETRIES = 30;
const NO_CONSULT: ConsultProgress = { running: false, done: 0, total: 0, failures: [] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado.';
}

export function NewDeploymentPage() {
  const { user } = useAuth();
  const canDeploy = user?.role === 'ADMIN' || user?.role === 'OPERATOR';
  const location = useLocation();
  const navigate = useNavigate();
  const now = useNow();
  const top = useRef<HTMLDivElement>(null);

  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [machinesError, setMachinesError] = useState<string | null>(null);
  const [software, setSoftware] = useState<Software[] | null>(null);
  const [softwareError, setSoftwareError] = useState<string | null>(null);

  const initial = location.state as NewDeploymentLocationState | null;
  const preset = Boolean(initial?.startAtReview && (initial.softwareId || initial.productCode) && initial.machineIds?.length);
  const presetProductCode = initial?.startAtReview ? (initial.productCode ?? null) : null;
  const [step, setStep] = useState(preset ? REVIEW : MACHINES);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial?.machineIds ?? []));
  const [action, setAction] = useState<DeploymentAction>(initial?.action ?? 'INSTALL');
  const [softwareId, setSoftwareId] = useState<string | null>(initial?.softwareId ?? null);
  // Desinstalação: o que remover (do inventário ou do catálogo) e o inventário das máquinas.
  const [uninstallTarget, setUninstallTarget] = useState<UninstallTarget | null>(null);
  const [inventorySummary, setInventorySummary] = useState<InventorySummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [consult, setConsult] = useState<ConsultProgress>(NO_CONSULT);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<Deployment | null>(null);

  const loadMachines = useCallback(async () => {
    try {
      const result = await listMachines();
      setMachines(result.machines);
      setMachinesError(null);
      // A seleção (inclusive a que veio da tela de Máquinas) só guarda máquinas que
      // existem e estão no AD.
      const selectable = new Set(result.machines.filter((m) => m.seenInLastSync).map((m) => m.id));
      setSelected((prev) => new Set([...prev].filter((id) => selectable.has(id))));
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setMachinesError(messageOf(err));
    }
  }, []);

  const loadSoftware = useCallback(async () => {
    try {
      // Inclui os desativados: a desinstalação aceita (o passo 2 os esconde ao instalar).
      setSoftware(await listSoftware(true));
      setSoftwareError(null);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setSoftwareError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    if (!canDeploy) return;
    void loadMachines();
    void loadSoftware();
  }, [canDeploy, loadMachines, loadSoftware]);

  // Trocar de passo volta ao topo (a barra do rodapé continua fixa).
  useEffect(() => {
    top.current?.scrollIntoView({ block: 'start' });
  }, [step, created]);

  const selectedMachines = useMemo(
    () => (machines ?? []).filter((m) => selected.has(m.id)).sort((a, b) => a.hostname.localeCompare(b.hostname)),
    [machines, selected],
  );
  const chosen = software?.find((s) => s.id === softwareId) ?? null;
  const overLimit = selected.size > MAX_TARGETS_PER_DEPLOYMENT;
  const uninstall = action === 'UNINSTALL';
  const selectedKey = [...selected].sort().join(',');

  const loadSummary = useCallback(async () => {
    const ids = selectedKey ? selectedKey.split(',') : [];
    if (ids.length === 0) return;
    try {
      setInventorySummary(await getInventorySummary(ids));
      setSummaryError(null);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setSummaryError(messageOf(err));
    }
  }, [selectedKey]);

  // Desinstalar: a lista vem do inventário das máquinas selecionadas (recarrega se mudarem).
  useEffect(() => {
    if (!uninstall || (step !== SOFTWARE && !presetProductCode)) return;
    setInventorySummary(null);
    void loadSummary();
  }, [uninstall, step === SOFTWARE, loadSummary, presetProductCode]);

  /** Consulta ao vivo as máquinas sem inventário ou com inventário antigo, até 5 de cada vez. */
  async function consultNow() {
    const queue = machinesToConsult(inventorySummary);
    if (queue.length === 0 || consult.running) return;
    const failures: ConsultProgress['failures'] = [];
    const total = queue.length;
    let done = 0;
    setConsult({ running: true, done, total, failures });
    const worker = async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        for (let attempt = 0; ; attempt++) {
          try {
            await collectInventory(m.id);
            break;
          } catch (err) {
            if (err instanceof SessionExpiredError) return;
            // 429: o servidor já tem 5 consultas em andamento (de qualquer pessoa) — espera.
            if (err instanceof ApiError && err.status === 429 && attempt < MAX_429_RETRIES) {
              await sleep(RETRY_429_MS);
              continue;
            }
            failures.push({ hostname: m.hostname, message: messageOf(err) });
            break;
          }
        }
        done += 1;
        setConsult({ running: true, done, total, failures: [...failures] });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONSULT_PARALLEL, total) }, worker));
    setConsult({ running: false, done, total, failures: [...failures] });
    await loadSummary();
  }

  // Atalho do inventário (abre na revisão): quando as listas chegam, confere se a máquina
  // e o software (ou o MSI do inventário) ainda valem; se não, volta ao passo da escolha.
  const presetChecked = useRef(!preset);
  useEffect(() => {
    if (presetChecked.current || machines === null || software === null) return;
    if (presetProductCode && inventorySummary === null && summaryError === null) return; // espera o inventário
    presetChecked.current = true;
    if (selected.size === 0) {
      setStep(MACHINES);
    } else if (presetProductCode) {
      const group = inventorySummary?.products.find((p) => p.kind === 'MSI' && p.productCode === presetProductCode);
      if (group) setUninstallTarget(fromInventory(group));
      else setStep(SOFTWARE);
    } else if (!chosen || unavailableReason(chosen, action) !== null || (action === 'INSTALL' && !chosen.active)) {
      setSoftwareId(null);
      setStep(SOFTWARE);
    }
  }, [machines, software, selected, chosen, action, presetProductCode, inventorySummary, summaryError]);

  // Desinstalação: o que aparece no rodapé e na revisão.
  const target = uninstall ? uninstallTarget : null;
  const targetName = uninstall
    ? target
      ? `${target.name}${target.version ? ` ${target.version}` : ''}`
      : null
    : chosen
      ? `${chosen.name} ${chosen.version}`
      : null;

  const canAdvance =
    step === MACHINES
      ? selected.size > 0 && !overLimit
      : step === SOFTWARE
        ? uninstall
          ? uninstallTarget !== null
          : chosen !== null && unavailableReason(chosen, action) === null && chosen.active
        : true;

  function changeAction(next: DeploymentAction) {
    setAction(next);
    setUninstallTarget(null);
    setConfirmed(false);
    // O software escolhido pode não valer para a outra ação (ex.: EXE ao desinstalar).
    if (chosen && (unavailableReason(chosen, next) !== null || (next === 'INSTALL' && !chosen.active))) setSoftwareId(null);
  }

  async function start() {
    if (submitting || (uninstall ? !target : !chosen)) return;
    if (target && !target.inCatalog && !confirmed) return;
    setSubmitting(true);
    setSubmitError(null);
    const machineIds = selectedMachines.map((m) => m.id);
    try {
      setCreated(
        await createDeployment(
          uninstall
            ? { action, productCode: target!.productCode, machineIds }
            : { action, softwareId: chosen!.id, machineIds },
        ),
      );
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setSubmitError(messageOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  function restart() {
    setCreated(null);
    setSelected(new Set());
    setSoftwareId(null);
    setUninstallTarget(null);
    setConfirmed(false);
    setConsult(NO_CONSULT);
    setAction('INSTALL');
    setSubmitError(null);
    setStep(MACHINES);
    navigate(location.pathname, { replace: true, state: null });
  }

  if (!canDeploy) {
    return (
      <div className="p-4 sm:p-6">
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center shadow-sm">
          <p className="text-sm font-medium text-slate-700">Somente Administradores e Operadores iniciam implantações.</p>
          <p className="mt-1 text-sm text-slate-500">Seu perfil permite consultar máquinas e o catálogo.</p>
        </div>
      </div>
    );
  }

  if (created) {
    return (
      <div ref={top} className="p-4 sm:p-6">
        <SuccessView deployment={created} onRestart={restart} />
      </div>
    );
  }

  // ---------- barra fixa do rodapé ----------

  let summary: ReactNode;
  if (step === MACHINES) {
    summary = (
      <>
        <span className="font-semibold text-slate-900">
          {selected.size === 0
            ? 'Nenhuma máquina selecionada'
            : `${plural(selected.size, 'máquina selecionada', 'máquinas selecionadas')}`}
        </span>
        {overLimit && (
          <span className="text-red-700">· máximo de {MAX_TARGETS_PER_DEPLOYMENT} por implantação</span>
        )}
        {selected.size > 0 && (
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-slate-500 hover:text-slate-700 hover:underline"
          >
            Limpar seleção
          </button>
        )}
      </>
    );
  } else if (step === SOFTWARE) {
    summary = targetName ? (
      <span className="font-semibold text-slate-900">
        {uninstall && 'Desinstalar '}
        {targetName}
        <span className="font-normal text-slate-500"> · {plural(selected.size, 'máquina', 'máquinas')}</span>
      </span>
    ) : (
      <span className="font-semibold text-slate-900">Nenhum software selecionado</span>
    );
  } else {
    summary = (
      <span className="font-semibold text-slate-900">
        {uninstall && 'Desinstalar '}
        {targetName} →{' '}
        {plural(selectedMachines.length, 'máquina', 'máquinas')}
      </span>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div ref={top} className="flex-1 space-y-4 p-4 sm:p-6">
        <Stepper current={step} />

        {step === MACHINES && (
          <MachineStep
            machines={machines}
            loadError={machinesError}
            onRetry={loadMachines}
            selected={selected}
            onChange={setSelected}
            now={now}
          />
        )}
        {step === SOFTWARE && (
          <SoftwareStep
            software={software}
            loadError={softwareError}
            onRetry={loadSoftware}
            action={action}
            onActionChange={changeAction}
            selectedId={softwareId}
            onSelect={setSoftwareId}
            uninstallContent={
              <UninstallChoices
                summary={inventorySummary}
                loadError={summaryError}
                onRetry={loadSummary}
                consult={consult}
                onConsultNow={consultNow}
                selectedKey={uninstallTarget?.key ?? null}
                onSelect={(t) => {
                  setUninstallTarget(t);
                  setConfirmed(false);
                }}
              />
            }
          />
        )}
        {step === REVIEW && (machines === null || software === null) && (
          <p className="rounded-xl border border-slate-200 bg-white px-6 py-10 text-center text-sm text-slate-500 shadow-sm">
            Carregando…
          </p>
        )}
        {step === REVIEW && machines !== null && (uninstall ? target : chosen) && (
          <ReviewStep machines={selectedMachines} software={chosen} action={action} uninstallTarget={target} />
        )}
        {step === EXECUTE && (uninstall ? target : chosen) && (
          <ConfirmStep
            machineCount={selectedMachines.length}
            targetName={targetName ?? ''}
            action={action}
            error={submitError}
            requireConfirm={target !== null && !target.inCatalog}
            confirmed={confirmed}
            onConfirm={setConfirmed}
          />
        )}
      </div>

      {/* Fixa no rodapé em todos os passos: sempre visível, mesmo com centenas de máquinas na lista. */}
      <div
        data-testid="wizard-footer"
        className="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-slate-200 bg-white px-4 py-3 text-sm shadow-[0_-4px_12px_-6px_rgba(15,23,42,0.15)] sm:px-6"
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">{summary}</div>
        <div className="ml-auto flex items-center gap-2">
          {step === MACHINES ? (
            <Link
              to="/machines"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50"
            >
              <ChevronLeftIcon className="h-4 w-4" />
              Cancelar
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSubmitError(null);
                setStep(step - 1);
              }}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              <ChevronLeftIcon className="h-4 w-4" />
              Voltar
            </button>
          )}
          {step < EXECUTE ? (
            <button
              type="button"
              onClick={() => setStep(step + 1)}
              disabled={!canAdvance}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Próximo
              <ChevronRightIcon className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={start}
              disabled={submitting || (target !== null && !target.inCatalog && !confirmed)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <PlayIcon className="h-4 w-4" />
              {submitting ? 'Iniciando…' : action === 'UNINSTALL' ? 'Iniciar desinstalação' : 'Iniciar implantação'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SuccessView({ deployment, onRestart }: { deployment: Deployment; onRestart: () => void }) {
  const count = deployment.targets.length;
  const uninstall = deployment.action === 'UNINSTALL';
  return (
    <section className="mx-auto max-w-lg rounded-xl border border-slate-200 bg-white px-6 py-10 text-center shadow-sm">
      <h2 className="text-xl font-semibold text-slate-900">{uninstall ? 'Desinstalação iniciada' : 'Implantação iniciada'}</h2>
      <p className="mt-1 text-sm text-slate-500">
        A {uninstall ? 'desinstalação' : 'instalação'} foi enfileirada para{' '}
        <strong>{plural(count, 'máquina', 'máquinas')}</strong> e segue em segundo plano.
      </p>
      <p className="mt-5 flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        <CheckCircleIcon className="h-4 w-4 shrink-0 text-emerald-600" />
        {deploymentTarget(deployment).name} <span className="font-mono">{deploymentTarget(deployment).version}</span> →{' '}
        {plural(count, 'máquina', 'máquinas')}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link
          to={`/monitoring?open=${deployment.id}`}
          className="rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-800"
        >
          Ver acompanhamento
        </Link>
        <button
          type="button"
          onClick={onRestart}
          className="rounded-lg px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          Nova implantação
        </button>
      </div>
    </section>
  );
}
