import type { ReactNode } from 'react';

/**
 * Barra de ações flutuante no pé da lista (seleção em Máquinas, rodapé da Nova Implantação):
 * cantos arredondados, sombra e presa a 1 rem do fundo enquanto a página rola. À esquerda o
 * resumo; à direita os botões.
 */
export function ActionBar({ children, actions, testId }: { children: ReactNode; actions: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-lg"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-body">{children}</div>
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </div>
  );
}
