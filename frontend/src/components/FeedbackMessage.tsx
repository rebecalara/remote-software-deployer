import { useEffect, useRef, useState } from 'react';
import { XIcon } from './icons';

export type Feedback = { kind: 'success' | 'info' | 'error'; text: string };

/** Quanto tempo uma mensagem de sucesso (ou informativa) fica na tela. */
export const FEEDBACK_AUTO_DISMISS_MS = 4000;

const STYLE: Record<Feedback['kind'], string> = {
  success: 'bg-emerald-50 text-emerald-800',
  info: 'bg-slate-100 text-slate-700',
  error: 'bg-red-50 text-red-700',
};

/**
 * Mensagem de resultado de uma ação (salvo, reativado, sincronizado, falhou…), com X para
 * fechar. Sucesso e informação somem sozinhos em ~4 s; erro fica até a pessoa fechar ou a
 * próxima ação. Enquanto o mouse ou o foco do teclado estão sobre a mensagem, a contagem
 * para — quem está lendo não perde o texto no meio.
 */
export function FeedbackMessage({
  feedback,
  onDismiss,
  className = '',
}: {
  feedback: Feedback;
  onDismiss: () => void;
  className?: string;
}) {
  const [paused, setPaused] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (feedback.kind === 'error' || paused) return;
    const id = window.setTimeout(() => dismissRef.current(), FEEDBACK_AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [feedback, paused]);

  return (
    <div
      role={feedback.kind === 'error' ? 'alert' : 'status'}
      data-kind={feedback.kind}
      data-testid="feedback"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={`flex items-start gap-2 rounded-lg px-3 py-2 text-body ${STYLE[feedback.kind]} ${className}`}
    >
      <p className="min-w-0 flex-1">{feedback.text}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Fechar mensagem"
        className="-mr-1 shrink-0 rounded-md p-0.5 opacity-70 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-current"
      >
        <XIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
