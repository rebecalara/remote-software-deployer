// Navegação de páginas no mesmo visual do Histórico: "1–100 de 1000 · Anterior · Página 1 de 10 · Próxima".
export function ListPagination({
  page,
  totalPages,
  first,
  last,
  total,
  onPage,
  label = 'Paginação',
}: {
  page: number;
  totalPages: number;
  first: number;
  last: number;
  total: number;
  onPage: (page: number) => void;
  label?: string;
}) {
  if (totalPages <= 1) return null;
  const button =
    'rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-3 text-body text-slate-600" data-testid="list-pagination">
      <p data-testid="page-range">
        {first}–{last} de {total}
      </p>
      <div className="flex items-center gap-2">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className={button}>
          Anterior
        </button>
        <span>
          Página {page} de {totalPages}
        </span>
        <button type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)} className={button}>
          Próxima
        </button>
      </div>
    </nav>
  );
}
