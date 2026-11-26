import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { XIcon } from './icons';

/**
 * Painel lateral à direita (Detalhes da máquina, cadastro do Catálogo): cabeçalho com título
 * e X, conteúdo que rola e rodapé opcional fixo. Em telas largas (≥ 1280 px) é uma coluna ao
 * lado do conteúdo da página; nas menores, fica sobreposto com fundo escuro.
 *
 * Montado uma vez só (a posição muda pelo matchMedia): duas cópias montadas ao mesmo tempo
 * ficavam com estado diferente (ver DECISIONS.md, RF08). Precisa ser filho direto do
 * contêiner flex da página.
 *
 * Esc, X e clique no fundo chamam onClose — que é um PEDIDO: quem usa decide (ex.: o
 * Catálogo pergunta antes de descartar alterações). Com uma janela de confirmação aberta, o
 * Esc é dela.
 */
export function SidePanel({
  title,
  ariaLabel,
  onClose,
  closeLabel = 'Fechar',
  closeDisabled = false,
  footer,
  testId,
  children,
}: {
  title: ReactNode;
  /** Nome do painel para leitor de tela; sem ele, o título. */
  ariaLabel?: string;
  onClose: () => void;
  closeLabel?: string;
  closeDisabled?: boolean;
  footer?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const wide = useMediaQuery('(min-width: 1280px)');
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role=alertdialog]')) return;
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const panel = (
    <aside
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : titleId}
      data-testid={testId}
      className="flex h-full w-full flex-col bg-white xl:w-[26rem] xl:rounded-xl xl:border xl:border-slate-200 xl:shadow-sm"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <h2 id={titleId} className="text-section font-semibold text-slate-900">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          disabled={closeDisabled}
          aria-label={closeLabel}
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
      {footer && <div className="border-t border-slate-100 px-5 py-4">{footer}</div>}
    </aside>
  );

  return wide ? (
    <div className="shrink-0 py-6 pr-6">
      <div className="sticky top-6 h-[calc(100vh-7rem)]">{panel}</div>
    </div>
  ) : (
    <div className="fixed inset-0 z-30">
      {/* Fundo escuro: atalho de mouse para fechar (o teclado usa Esc e o X). */}
      <div role="presentation" className="absolute inset-0 bg-slate-950/40" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 w-full max-w-md shadow-xl">{panel}</div>
    </div>
  );
}
