import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ListPagination } from './ListPagination';

describe('ListPagination — "1–100 de 250 · Anterior · Página 1 de 3 · Próxima"', () => {
  it('com uma página só, não aparece', () => {
    const { container } = render(<ListPagination page={1} totalPages={1} first={1} last={16} total={16} onPage={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('mostra o intervalo e a página atual', () => {
    render(<ListPagination page={2} totalPages={3} first={101} last={200} total={250} onPage={() => {}} label="Páginas de máquinas" />);
    expect(screen.getByRole('navigation', { name: 'Páginas de máquinas' })).toBeInTheDocument();
    expect(screen.getByTestId('page-range')).toHaveTextContent('101–200 de 250');
    expect(screen.getByText('Página 2 de 3')).toBeInTheDocument();
  });

  it('na primeira página, "Anterior" desativado; "Próxima" avança', async () => {
    const onPage = vi.fn();
    render(<ListPagination page={1} totalPages={3} first={1} last={100} total={250} onPage={onPage} />);
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Próxima' }));
    expect(onPage).toHaveBeenCalledWith(2);
  });

  it('na última página, "Próxima" desativado; "Anterior" volta', async () => {
    const onPage = vi.fn();
    render(<ListPagination page={3} totalPages={3} first={201} last={250} total={250} onPage={onPage} />);
    expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Anterior' }));
    expect(onPage).toHaveBeenCalledWith(2);
  });
});
