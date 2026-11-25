import { useEffect, useMemo, useState } from 'react';

/**
 * Paginação feita na própria tela, sobre uma lista que já está toda no navegador (ex.: as
 * máquinas). Desenhar 1000 linhas a cada tecla da busca travava a tela; com páginas de 100,
 * só a página visível é desenhada. Volta para a página 1 quando `resetKey` muda (filtros).
 */
export function usePagedList<T>(items: readonly T[], pageSize: number, resetKey: unknown) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));

  useEffect(() => setPage(1), [resetKey]);
  // A lista pode encolher (sincronização, filtro): a página nunca passa da última.
  const current = Math.min(page, totalPages);

  const pageItems = useMemo(() => items.slice((current - 1) * pageSize, current * pageSize), [items, current, pageSize]);
  return {
    page: current,
    setPage,
    totalPages,
    pageItems,
    first: items.length === 0 ? 0 : (current - 1) * pageSize + 1,
    last: Math.min(current * pageSize, items.length),
    total: items.length,
  };
}
