import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CheckCircleIcon, ChevronLeftIcon, ChevronRightIcon, PlayIcon } from '../../components/icons';
import { useAuth } from '../../context/AuthContext';
import { useNow } from '../../hooks/useNow';
import { SessionExpiredError } from '../../services/apiClient';
import { createDeployment } from '../../services/deploymentService';
import { listMachines } from '../../services/machineService';
import { listSoftware } from '../../services/softwareService';
import { MAX_TARGETS_PER_DEPLOYMENT, type Deployment } from '../../types/deployment';
import type { Machine } from '../../types/machine';
import type { Software } from '../../types/software';
import { MachineStep } from './MachineStep';
import { ConfirmStep, ReviewStep } from './ReviewStep';
import { SoftwareStep } from './SoftwareStep';
import { Stepper, plural } from './wizardParts';

/** A tela de Máquinas abre esta com as máquinas já marcadas (state da navegação). */
export interface NewDeploymentLocationState {
  machineIds?: string[];
}

const MACHINES = 0;
const SOFTWARE = 1;
const REVIEW = 2;
const EXECUTE = 3;

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

  const [step, setStep] = useState(MACHINES);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set((location.state as NewDeploymentLocationState | null)?.machineIds ?? []),
  );
  const [softwareId, setSoftwareId] = useState<string | null>(null);
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
      setSoftware(await listSoftware());
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

  const canAdvance =
    step === MACHINES
      ? selected.size > 0 && !overLimit
      : step === SOFTWARE
        ? chosen !== null && chosen.installer !== null
        : true;

  async function start() {
    if (!chosen || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      setCreated(await createDeployment({ softwareId: chosen.id, machineIds: selectedMachines.map((m) => m.id) }));
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
    summary = chosen ? (
      <span className="font-semibold text-slate-900">
        {chosen.name} <span className="font-mono font-normal">{chosen.version}</span>
        <span className="font-normal text-slate-500"> · {plural(selected.size, 'máquina', 'máquinas')}</span>
      </span>
    ) : (
      <span className="font-semibold text-slate-900">Nenhum software selecionado</span>
    );
  } else {
    summary = (
      <span className="font-semibold text-slate-900">
        {chosen?.name} <span className="font-mono font-normal">{chosen?.version}</span> →{' '}
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
            selectedId={softwareId}
            onSelect={setSoftwareId}
          />
        )}
        {step === REVIEW && chosen && <ReviewStep machines={selectedMachines} software={chosen} />}
        {step === EXECUTE && chosen && (
          <ConfirmStep machineCount={selectedMachines.length} software={chosen} error={submitError} />
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
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <PlayIcon className="h-4 w-4" />
              {submitting ? 'Iniciando…' : 'Iniciar implantação'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SuccessView({ deployment, onRestart }: { deployment: Deployment; onRestart: () => void }) {
  const count = deployment.targets.length;
  return (
    <section className="mx-auto max-w-lg rounded-xl border border-slate-200 bg-white px-6 py-10 text-center shadow-sm">
      <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
        <CheckCircleIcon className="h-8 w-8" />
      </span>
      <h2 className="mt-4 text-xl font-semibold text-slate-900">Implantação iniciada</h2>
      <p className="mt-1 text-sm text-slate-500">
        A instalação foi enfileirada para <strong>{plural(count, 'máquina', 'máquinas')}</strong> e segue em segundo
        plano.
      </p>
      <p className="mt-5 flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        <CheckCircleIcon className="h-4 w-4 shrink-0 text-emerald-600" />
        {deployment.software.name} <span className="font-mono">{deployment.software.version}</span> →{' '}
        {plural(count, 'máquina', 'máquinas')}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link
          to={`/deployments/${deployment.id}`}
          className="rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-800"
        >
          Ver acompanhamento
        </Link>
        <button
          type="button"
          onClick={onRestart}
          className="rounded-lg px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          Nova instalação
        </button>
      </div>
    </section>
  );
}
