import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ActionBar } from '../../components/ActionBar';
import type { Feedback } from '../../components/FeedbackMessage';
import { ChevronLeftIcon, ChevronRightIcon, PlayIcon } from '../../components/icons';
import { useAuth } from '../../context/AuthContext';
import { useNow } from '../../hooks/useNow';
import { ApiError, SessionExpiredError } from '../../services/apiClient';
import { createDeployment, getDeploymentLimits } from '../../services/deploymentService';
import { collectInventory, getInventorySummary } from '../../services/inventoryService';
import { listMachines } from '../../services/machineService';
import { listSoftware } from '../../services/softwareService';
import type { DeploymentAction } from '../../types/deployment';
import type { Machine } from '../../types/machine';
import type { InventorySummary } from '../../types/inventory';
import type { Software } from '../../types/software';
import type { MonitoringLocationState } from '../Monitoring/MonitoringPage';
import { MachineStep } from './MachineStep';
import { ReviewStep } from './ReviewStep';
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
  /** Atalho "Desinstalar" do inventário: programa (não MSI) pelo comando do fabricante. */
  programId?: string;
  action?: DeploymentAction;
  /** Abre direto no passo Revisar (onde fica o "Iniciar"). */
  startAtReview?: boolean;
}

const MACHINES = 0;
const SOFTWARE = 1;
const REVIEW = 2;

/** "Consultar agora": consultas ao mesmo tempo (o limite do servidor) e espera no 429. */
const CONSULT_PARALLEL = 5;
const RETRY_429_MS = 2_000;
const MAX_429_RETRIES = 30;
const NO_CONSULT: ConsultProgress = { running: false, done: 0, total: 0, failures: [] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Confirmação obrigatória: produto fora do catálogo ou comando do fabricante. */
const needsConfirm = (t: UninstallTarget) => t.method === 'VENDOR' || !t.inCatalog;

const BUTTON_SECONDARY =
  'inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2 text-body font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60';
const BUTTON_PRIMARY =
  'inline-flex items-center gap-1.5 rounded-lg border border-transparent bg-blue-700 px-4 py-2 text-body font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado.';
}

/**
 * Nova Implantação em 3 passos: Máquinas → Software → Revisar. O "Iniciar" fica no Revisar;
 * depois de iniciar, a tela vai direto ao Monitoramento com a implantação aberta.
 */
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
  const preset = Boolean(
    initial?.startAtReview && (initial.softwareId || initial.productCode || initial.programId) && initial.machineIds?.length,
  );
  const presetProductCode = initial?.startAtReview ? (initial.productCode ?? null) : null;
  const presetProgramId = initial?.startAtReview ? (initial.programId ?? null) : null;
  const presetFromInventory = presetProductCode ?? presetProgramId;
  const [step, setStep] = useState(preset ? REVIEW : MACHINES);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial?.machineIds ?? []));
  const [action, setAction] = useState<DeploymentAction>(initial?.action ?? 'INSTALL');
  const [softwareId, setSoftwareId] = useState<string | null>(initial?.softwareId ?? null);
  // Desinstalação: o que remover (do inventário) e o inventário das máquinas.
  const [uninstallTarget, setUninstallTarget] = useState<UninstallTarget | null>(null);
  const [inventorySummary, setInventorySummary] = useState<InventorySummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [consult, setConsult] = useState<ConsultProgress>(NO_CONSULT);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Trava contra clique duplo: o estado "submitting" só desativa o botão no próximo desenho
  // da tela, e um segundo clique rápido chegaria antes (mesmo padrão dos botões de Máquinas).
  const submittingRef = useRef(false);

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
      setSoftware(await listSoftware(true));
      setSoftwareError(null);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setSoftwareError(messageOf(err));
    }
  }, []);

  // Máquinas por implantação: vem do backend (DEPLOYMENT_MAX_MACHINES). Se a leitura falhar,
  // a tela não confere antes de enviar — o servidor confere de qualquer jeito (400).
  const [maxMachines, setMaxMachines] = useState<number | null>(null);

  useEffect(() => {
    if (!canDeploy) return;
    void loadMachines();
    void loadSoftware();
    getDeploymentLimits()
      .then((l) => setMaxMachines(l.maxMachines))
      .catch(() => setMaxMachines(null));
  }, [canDeploy, loadMachines, loadSoftware]);

  // Trocar de passo volta ao topo (a barra de baixo continua visível).
  useEffect(() => {
    top.current?.scrollIntoView({ block: 'start' });
  }, [step]);

  const selectedMachines = useMemo(
    () => (machines ?? []).filter((m) => selected.has(m.id)).sort((a, b) => a.hostname.localeCompare(b.hostname)),
    [machines, selected],
  );
  const chosen = software?.find((s) => s.id === softwareId) ?? null;
  const overLimit = maxMachines !== null && selected.size > maxMachines;
  const uninstall = action === 'UNINSTALL';
  const selectedKey = [...selected].sort((a, b) => a.localeCompare(b)).join(',');

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
    if (!uninstall || (step !== SOFTWARE && !presetFromInventory)) return;
    setInventorySummary(null);
    void loadSummary();
  }, [uninstall, step === SOFTWARE, loadSummary, presetFromInventory]);

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
    if (presetFromInventory && inventorySummary === null && summaryError === null) return; // espera o inventário
    presetChecked.current = true;
    if (selected.size === 0) {
      setStep(MACHINES);
    } else if (presetFromInventory) {
      const group = inventorySummary?.products.find((p) =>
        presetProductCode
          ? p.kind === 'MSI' && p.productCode === presetProductCode
          : p.uninstall.available && p.uninstall.programId === presetProgramId,
      );
      if (group) setUninstallTarget(fromInventory(group));
      else setStep(SOFTWARE);
    } else if (!chosen || unavailableReason(chosen, action) !== null || (action === 'INSTALL' && !chosen.active)) {
      setSoftwareId(null);
      setStep(SOFTWARE);
    }
  }, [machines, software, selected, chosen, action, presetFromInventory, presetProductCode, presetProgramId, inventorySummary, summaryError]);

  const target = uninstall ? uninstallTarget : null;
  const targetName = uninstall
    ? target
      ? `${target.name}${target.version ? ` ${target.version}` : ''}`
      : null
    : chosen
      ? `${chosen.name} ${chosen.version}`
      : null;
  const mustConfirm = target !== null && needsConfirm(target);

  const canAdvance =
    step === MACHINES
      ? selected.size > 0 && !overLimit
      : step === SOFTWARE
        ? uninstall
          ? uninstallTarget !== null
          : chosen !== null && unavailableReason(chosen, action) === null && chosen.active
        : false;
  const canStart = step === REVIEW && (uninstall ? target !== null : chosen !== null) && (!mustConfirm || confirmed);

  function changeAction(next: DeploymentAction) {
    setAction(next);
    setUninstallTarget(null);
    setConfirmed(false);
    if (chosen && (unavailableReason(chosen, next) !== null || (next === 'INSTALL' && !chosen.active))) setSoftwareId(null);
  }

  async function start() {
    if (submittingRef.current || !canStart) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    const machineIds = selectedMachines.map((m) => m.id);
    try {
      const created = await createDeployment(
        uninstall
          ? target!.method === 'VENDOR'
            ? { action, programId: target!.programId!, machineIds }
            : { action, productCode: target!.productCode!, machineIds }
          : { action, softwareId: chosen!.id, machineIds },
      );
      const feedback: Feedback = {
        kind: 'success',
        text: `${uninstall ? 'Desinstalação iniciada' : 'Implantação iniciada'}: ${targetName} → ${plural(
          created.targets.length,
          'máquina',
          'máquinas',
        )}.`,
      };
      // Direto para o acompanhamento, com a implantação aberta e a mensagem de sucesso.
      navigate(`/monitoring?open=${created.id}`, { state: { feedback } satisfies MonitoringLocationState });
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setSubmitError(messageOf(err));
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (!canDeploy) {
    return (
      <div className="p-4 sm:p-6">
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center shadow-sm">
          <p className="text-body font-medium text-slate-700">Somente Administradores e Operadores iniciam implantações.</p>
          <p className="mt-1 text-body text-slate-500">Seu perfil permite consultar máquinas e o catálogo.</p>
        </div>
      </div>
    );
  }

  // ---------- barra de baixo ----------

  let summary: ReactNode;
  if (step === MACHINES) {
    summary = (
      <>
        <span className="font-medium text-slate-900">
          {selected.size === 0
            ? 'Nenhuma máquina selecionada'
            : `${plural(selected.size, 'máquina selecionada', 'máquinas selecionadas')}`}
        </span>
        {overLimit && (
          <span className="text-red-700" data-testid="over-limit">
            · máximo de {maxMachines} por implantação
          </span>
        )}
        {selected.size > 0 && (
          <button type="button" onClick={() => setSelected(new Set())} className="text-slate-500 hover:text-slate-700 hover:underline">
            Limpar seleção
          </button>
        )}
      </>
    );
  } else {
    summary = targetName ? (
      <span className="font-medium text-slate-900">
        {uninstall && 'Desinstalar '}
        {targetName}
        <span className="font-normal text-slate-500"> → {plural(selected.size, 'máquina', 'máquinas')}</span>
      </span>
    ) : (
      <span className="font-medium text-slate-900">Nenhum software selecionado</span>
    );
  }

  const actions = (
    <>
      {step === MACHINES ? (
        <Link to="/machines" className={BUTTON_SECONDARY}>
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
          className={BUTTON_SECONDARY}
        >
          <ChevronLeftIcon className="h-4 w-4" />
          Voltar
        </button>
      )}
      {step < REVIEW ? (
        <button type="button" onClick={() => setStep(step + 1)} disabled={!canAdvance} className={BUTTON_PRIMARY}>
          Próximo
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      ) : (
        <button type="button" onClick={start} disabled={submitting || !canStart} className={BUTTON_PRIMARY}>
          <PlayIcon className="h-4 w-4" />
          {submitting ? 'Iniciando…' : uninstall ? 'Iniciar desinstalação' : 'Iniciar implantação'}
        </button>
      )}
    </>
  );

  return (
    <div ref={top} className="space-y-4 p-4 sm:p-6">
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
          renderUninstall={(search) => (
            <UninstallChoices
              summary={inventorySummary}
              search={search}
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
          )}
        />
      )}
      {step === REVIEW && (machines === null || software === null) && (
        <p className="rounded-xl border border-slate-200 bg-white px-6 py-10 text-center text-body text-slate-500 shadow-sm">
          Carregando…
        </p>
      )}
      {step === REVIEW && machines !== null && (uninstall ? target : chosen) && (
        <ReviewStep
          machines={selectedMachines}
          software={chosen}
          action={action}
          uninstallTarget={target}
          requireConfirm={mustConfirm}
          confirmed={confirmed}
          onConfirm={setConfirmed}
          error={submitError}
        />
      )}

      {/* Sempre visível no pé da lista, mesmo com centenas de máquinas (mesma barra de Máquinas). */}
      <ActionBar testId="wizard-footer" actions={actions}>
        {summary}
      </ActionBar>
    </div>
  );
}
