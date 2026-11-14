import type { ReactNode } from 'react';

// Peças visuais compartilhadas pelos passos da Nova Instalação.

export const STEPS: Array<{ label: string }> = [
  { label: 'Selecionar máquinas' },
  { label: 'Selecionar software' },
  { label: 'Revisar instalação' },
  { label: 'Executar' },
];

export function Stepper({ current }: { current: number }) {
  return (
    <nav aria-label="Passos da instalação" className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-6">
      <ol className="flex items-start">
        {STEPS.map((step, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li key={step.label} className={`flex items-start ${index < STEPS.length - 1 ? 'flex-1' : ''}`}>
              <div className="flex flex-col items-center gap-2 text-center">
                <span
                  aria-current={active ? 'step' : undefined}
                  className={`flex h-9 w-9 items-center justify-center rounded-full border-2 text-sm font-semibold ${
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
                  className={`hidden text-xs font-medium whitespace-nowrap sm:block ${
                    active ? 'text-blue-700' : done ? 'text-slate-700' : 'text-slate-400'
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {index < STEPS.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`mx-2 mt-[18px] h-0.5 flex-1 ${index < current ? 'bg-blue-700' : 'bg-slate-200'}`}
                />
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-center text-xs font-medium text-blue-700 sm:hidden">
        Passo {current + 1} de {STEPS.length}: {STEPS[current].label}
      </p>
    </nav>
  );
}

export function StepCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="border-b border-slate-100 px-4 py-4 sm:px-6">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}

export function EmptyState({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-16 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {detail && <p className="mt-1 text-sm text-slate-500">{detail}</p>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function TypeBadge({ type }: { type: 'MSI' | 'EXE' }) {
  return (
    <span
      className="inline-flex w-10 shrink-0 justify-center rounded border border-slate-200 bg-slate-50 py-0.5 font-mono text-[11px] font-semibold text-slate-600"
      title={type === 'MSI' ? 'Windows Installer (MSI)' : 'Executável (EXE)'}
    >
      {type}
    </span>
  );
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
