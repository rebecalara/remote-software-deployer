/**
 * Nome do sistema no estilo terminal: ">rsd_". O ">" e o "_" ficam na cor da marca.
 * O tamanho vem do className (use só os tokens da escala tipográfica do index.css).
 * O leitor de tela lê "RSD", não os símbolos.
 */
interface RsdWordmarkProps {
  tone?: 'light' | 'dark';
  className?: string;
  /** Faz o "_" piscar (só no login; com "reduzir movimento", fica visível e parado). */
  blink?: boolean;
}

export function RsdWordmark({ tone = 'light', className = 'text-section', blink = false }: RsdWordmarkProps) {
  const accent = tone === 'dark' ? 'text-blue-400' : 'text-blue-600';
  const body = tone === 'dark' ? 'text-slate-50' : 'text-slate-900';
  return (
    <span className={`font-brand font-medium tracking-tight ${body} ${className}`}>
      <span className="sr-only">RSD</span>
      <span aria-hidden="true">
        <span className={accent}>&gt;</span>
        rsd
        <span className={`${accent} ${blink ? 'animate-rsd-blink motion-reduce:animate-none' : ''}`} data-testid={blink ? 'brand-cursor' : undefined}>
          _
        </span>
      </span>
    </span>
  );
}
