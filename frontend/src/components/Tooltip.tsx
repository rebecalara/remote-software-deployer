import { cloneElement, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

// Dica acessível: abre ao passar o mouse E ao receber foco pelo teclado, fecha com Esc, e o
// texto fica ligado ao elemento por aria-describedby (o leitor de tela lê junto). O title
// nativo do navegador não serve: só aparece com o mouse e cada leitor de tela trata de um
// jeito. O elemento filho precisa receber foco (botão, link, ou tabIndex={0}).
//
// Fechada, a dica fica fora do layout (display: none) — senão alargaria o container e criaria
// rolagem horizontal; o leitor de tela continua lendo o texto pelo aria-describedby. Aberta,
// é posicionada em relação à janela (position: fixed), presa dentro da tela: um painel com
// rolagem (overflow) não a corta.

const MARGIN = 8;

export function Tooltip({
  content,
  children,
  align = 'start',
  asLabel = false,
}: {
  content: ReactNode;
  children: ReactElement<{ 'aria-describedby'?: string; 'aria-labelledby'?: string }>;
  /** Lado preferido para alinhar a dica ao elemento (ela sempre fica dentro da tela). */
  align?: 'start' | 'end';
  /**
   * true em botão só com ícone: a dica é o NOME do botão (aria-labelledby), não uma
   * descrição a mais — senão o leitor de tela leria o mesmo texto duas vezes.
   */
  asLabel?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) {
      setPos(null);
      return;
    }
    const a = anchor.current.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    const preferred = align === 'end' ? a.right - t.width : a.left;
    const left = Math.min(Math.max(preferred, MARGIN), window.innerWidth - t.width - MARGIN);
    // Embaixo; se não couber, em cima.
    const below = a.bottom + 4;
    const top = below + t.height > window.innerHeight - MARGIN ? a.top - t.height - 4 : below;
    setPos({ top, left });
  }, [open, align, content]);

  return (
    <span
      ref={anchor}
      className="inline-flex max-w-full"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation(); // Esc fecha a dica, não o painel inteiro
          setOpen(false);
        }
      }}
    >
      {cloneElement(children, asLabel ? { 'aria-labelledby': id } : { 'aria-describedby': id })}
      <span
        ref={tip}
        id={id}
        role="tooltip"
        style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0 }}
        className={`pointer-events-none fixed z-50 w-max max-w-[18rem] rounded-md bg-slate-900 px-2 py-1 text-meta font-normal whitespace-normal text-white shadow-lg ${
          open ? (pos ? 'block' : 'invisible block') : 'hidden'
        }`}
      >
        {content}
      </span>
    </span>
  );
}
