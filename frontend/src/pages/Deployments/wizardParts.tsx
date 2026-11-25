import type { ReactNode } from 'react';
import { InfoIcon } from '../../components/icons';
import { Tooltip } from '../../components/Tooltip';

// Peças visuais compartilhadas pelos passos da Nova Implantação.

export const STEPS: Array<{ label: string }> = [{ label: 'Máquinas' }, { label: 'Software' }, { label: 'Revisar' }];

/**
 * Indicador de passos. Cada passo ocupa uma coluna de largura igual (grade), com o número
 * no centro dela; a linha de ligação vai de um círculo ao outro. Assim o espaço entre os
 * passos é sempre o mesmo, qualquer que seja o tamanho do texto de cada um.
 */
export function Stepper({ current }: { current: number }) {
  return (
    <nav aria-label="Passos da implantação" className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-6">
      <ol className="grid" style={{ gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))` }}>
        {STEPS.map((step, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li key={step.label} className="relative flex flex-col items-center gap-2 text-center" data-testid="step">
              {index < STEPS.length - 1 && (
                // Do fim deste círculo (centro + 18 px + 8 px) ao começo do próximo.
                <span
                  aria-hidden="true"
                  className={`absolute top-[17px] right-[calc(-50%+26px)] left-[calc(50%+26px)] h-0.5 ${
                    index < current ? 'bg-blue-700' : 'bg-slate-200'
                  }`}
                />
              )}
              <span
                aria-current={active ? 'step' : undefined}
                className={`flex h-9 w-9 items-center justify-center rounded-full border-2 text-body font-semibold ${
                  done
                    ? 'border-blue-700 bg-blue-700 text-white'
                    : active
                      ? 'border-blue-700 bg-white text-blue-700'
                      : 'border-slate-200 bg-white text-slate-400'
                }`}
              >
                {index + 1}
              </span>
              <span
                className={`text-meta font-medium whitespace-nowrap ${
                  active ? 'text-blue-700' : done ? 'text-slate-700' : 'text-slate-400'
                }`}
              >
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function StepCard({
  title,
  info,
  actions,
  children,
}: {
  title: string;
  /** Explicação: numa dica no (i) ao lado do título. */
  info?: string;
  /** Algo à direita do título (ex.: o alternador Instalar / Desinstalar). */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-100 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-1">
          <h2 className="text-section font-semibold text-slate-900">{title}</h2>
          {info && <InfoTip label={`Sobre: ${title}`} content={info} />}
        </div>
        {actions && <div className="ml-auto">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** Botão (i) com a explicação numa dica. */
export function InfoTip({ label, content }: { label: string; content: ReactNode }) {
  return (
    <Tooltip content={content}>
      <button
        type="button"
        aria-label={label}
        className="rounded-md p-1 text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-blue-500/50"
      >
        <InfoIcon className="h-4 w-4" />
      </button>
    </Tooltip>
  );
}

export function EmptyState({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-16 text-center">
      <p className="text-body font-medium text-slate-700">{title}</p>
      {detail && <p className="mt-1 text-body text-slate-500">{detail}</p>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function TypeBadge({ type }: { type: 'MSI' | 'EXE' }) {
  return (
    <span
      className="inline-flex w-10 shrink-0 justify-center rounded border border-slate-200 bg-slate-50 py-0.5 font-mono text-meta font-semibold text-slate-600"
      title={type === 'MSI' ? 'Windows Installer (MSI)' : 'Executável (EXE)'}
    >
      {type}
    </span>
  );
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
