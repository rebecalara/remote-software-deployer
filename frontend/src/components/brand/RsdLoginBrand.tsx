import { MARK_STATES, type MarkState } from './RsdMark';
import { RsdWordmark } from './RsdWordmark';

/**
 * Marca animada do painel escuro do login: o servidor (azul) "acende" as máquinas uma a
 * uma — na fila (cinza) → instalando (âmbar) → ok (verde) — enquanto a barra enche e o
 * cursor pisca. Animações em index.css (rsd-deploy, rsd-fill, rsd-blink).
 *
 * Com "reduzir movimento" ligado no sistema (motion-reduce), nada anima: a grade fica
 * parada no mesmo estado do RsdMark, a barra cheia e o cursor visível, sem piscar.
 */
const DELAYS = ['0s', '0.6s', '0.3s', '0.9s', '1.5s', '0.6s', '1.2s', '1.8s'];

// Cor parada de cada estado com "reduzir movimento" (fundo escuro). O cinza é a cor base.
const STILL: Record<Exclude<MarkState, 'server'>, string> = {
  ok: 'motion-reduce:bg-emerald-500',
  installing: 'motion-reduce:bg-amber-500',
  queued: '',
};

export function RsdLoginBrand() {
  const machines = MARK_STATES.slice(1) as Array<Exclude<MarkState, 'server'>>;
  return (
    <div className="flex flex-col items-center gap-8">
      <div className="grid grid-cols-3 gap-3 xl:gap-3.5" aria-hidden="true" data-testid="login-grid">
        <div className="h-14 w-14 rounded-xl bg-blue-500 xl:h-16 xl:w-16" />
        {machines.map((state, i) => (
          <div
            key={i}
            className={`h-14 w-14 rounded-xl bg-slate-700 animate-rsd-deploy motion-reduce:animate-none ${STILL[state]} xl:h-16 xl:w-16`}
            style={{ animationDelay: DELAYS[i] }}
          />
        ))}
      </div>

      <h2 className="leading-none">
        <RsdWordmark tone="dark" blink className="text-brand xl:text-brand-xl" />
      </h2>

      <div className="h-1.5 w-60 overflow-hidden rounded-full bg-slate-800" aria-hidden="true">
        <div className="h-full w-full origin-left rounded-full bg-blue-500 animate-rsd-fill motion-reduce:animate-none" data-testid="login-bar" />
      </div>

      <p className="text-meta tracking-[0.2em] text-slate-400 uppercase">Remote Software Deployer</p>
    </div>
  );
}
