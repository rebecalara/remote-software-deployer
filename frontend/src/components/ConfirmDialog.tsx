import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Janela de confirmação do sistema (no lugar do confirm() do navegador): título, texto e
 * dois botões. Esc e clique fora = cancelar. O foco começa no botão de cancelar — a opção
 * segura —, para um Enter distraído não confirmar uma ação destrutiva.
 */
export function ConfirmDialog(props: {
  title: string;
  confirmLabel: string;
  cancelLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(props.onCancel);
  onCancelRef.current = props.onCancel;

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    // Fundo escuro: só um atalho de mouse para cancelar (o teclado usa Esc e os botões), por
    // isso role="presentation". Cancela só com o clique NO PRÓPRIO fundo, não dentro da janela.
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-text"
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
      >
        <h2 id="confirm-title" className="text-section font-semibold text-slate-900">
          {props.title}
        </h2>
        <p id="confirm-text" className="mt-2 text-body text-slate-600">
          {props.children}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={props.onCancel}
            className="rounded-lg bg-slate-100 px-4 py-2 text-body font-medium text-slate-700 outline-none hover:bg-slate-200 focus-visible:ring-2 focus-visible:ring-blue-500/50"
          >
            {props.cancelLabel ?? 'Cancelar'}
          </button>
          <button
            type="button"
            onClick={props.onConfirm}
            className="rounded-lg bg-red-600 px-4 py-2 text-body font-semibold text-white outline-none hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500/50"
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
