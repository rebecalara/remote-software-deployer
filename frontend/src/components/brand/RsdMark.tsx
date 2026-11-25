/**
 * Símbolo do RSD: grade 3×3 de máquinas. O quadrado do canto (azul) é o servidor; as
 * outras cores são os mesmos estados da interface (verde = ok, âmbar = instalando,
 * cinza = na fila). Esta é a versão estática, "congelada no meio de uma implantação".
 * Com `animateOnHover`, as máquinas acendem em onda enquanto o mouse (ou o foco do
 * teclado) está sobre o elemento pai que tiver a classe `group` — usado na logo do menu,
 * e só sem "reduzir movimento" ligado no sistema.
 * Versão animada do login: RsdLoginBrand. Arquivos exportados: docs/brand/.
 */
type Tone = 'light' | 'dark';
export type MarkState = 'server' | 'ok' | 'installing' | 'queued';

/**
 * Estado de cada quadrado da grade (linha a linha). Fonte única: o login, com "reduzir
 * movimento" ligado, mostra a grade parada exatamente neste estado.
 */
export const MARK_STATES: readonly MarkState[] = [
  'server', 'ok', 'queued',
  'ok', 'installing', 'queued',
  'queued', 'queued', 'queued',
];

const COLORS: Record<Tone, Record<MarkState, string>> = {
  // fundo claro: blue-600, emerald-600, amber-500, slate-300
  light: { server: '#2563EB', ok: '#059669', installing: '#F59E0B', queued: '#CBD5E1' },
  // fundo escuro: blue-500, emerald-500, amber-500, slate-700
  dark: { server: '#3B82F6', ok: '#10B981', installing: '#F59E0B', queued: '#334155' },
};

// Atraso de cada máquina na onda (a 1ª é o servidor, que não anima)
const HOVER_DELAYS = ['0s', '0s', '0.3s', '0.15s', '0.45s', '0.75s', '0.3s', '0.6s', '0.9s'];

interface RsdMarkProps {
  tone?: Tone;
  className?: string;
  /** Sem título, o símbolo é decorativo (o nome do sistema já aparece ao lado). */
  title?: string;
  /** Anima ao passar o mouse / focar o elemento pai com a classe `group`. */
  animateOnHover?: boolean;
}

export function RsdMark({ tone = 'light', className = 'h-9 w-9', title, animateOnHover = false }: RsdMarkProps) {
  // motion-safe: com "reduzir movimento" ligado, a logo do menu fica parada.
  const hoverClass = 'motion-safe:group-hover:animate-rsd-deploy-fill motion-safe:group-focus-visible:animate-rsd-deploy-fill';
  return (
    <svg
      viewBox="0 0 96 96"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {MARK_STATES.map((state, i) => (
        <rect
          key={i}
          x={4 + (i % 3) * 31}
          y={4 + Math.floor(i / 3) * 31}
          width="26"
          height="26"
          rx="6"
          fill={COLORS[tone][state]}
          className={animateOnHover && i > 0 ? hoverClass : undefined}
          style={animateOnHover && i > 0 ? { animationDelay: HOVER_DELAYS[i] } : undefined}
        />
      ))}
    </svg>
  );
}
