import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePagedList } from './usePagedList';

const machines = (n: number) => Array.from({ length: n }, (_, i) => `PC-${i + 1}`);

describe('usePagedList — páginas de 100 na própria tela (Máquinas e Nova Implantação)', () => {
  it('só a página atual é desenhada', () => {
    const { result } = renderHook(() => usePagedList(machines(250), 100, ''));
    expect(result.current).toMatchObject({ page: 1, totalPages: 3, first: 1, last: 100, total: 250 });
    expect(result.current.pageItems).toHaveLength(100);
  });

  it('última página fica com o resto', () => {
    const { result } = renderHook(() => usePagedList(machines(250), 100, ''));
    act(() => result.current.setPage(3));
    expect(result.current).toMatchObject({ page: 3, first: 201, last: 250 });
    expect(result.current.pageItems[0]).toBe('PC-201');
  });

  it('mudou o filtro (resetKey): volta para a página 1', () => {
    const { result, rerender } = renderHook(({ key }) => usePagedList(machines(250), 100, key), { initialProps: { key: '' } });
    act(() => result.current.setPage(2));
    expect(result.current.page).toBe(2);
    rerender({ key: 'pc-1' });
    expect(result.current.page).toBe(1);
  });

  it('a lista encolheu (sincronização): a página nunca passa da última', () => {
    const { result, rerender } = renderHook(({ items }) => usePagedList(items, 100, 'x'), { initialProps: { items: machines(250) } });
    act(() => result.current.setPage(3));
    rerender({ items: machines(120) });
    expect(result.current).toMatchObject({ page: 2, totalPages: 2, first: 101, last: 120 });
  });

  it('lista vazia: "0–0 de 0" e uma página', () => {
    const { result } = renderHook(() => usePagedList([], 100, ''));
    expect(result.current).toMatchObject({ page: 1, totalPages: 1, first: 0, last: 0, total: 0 });
  });
});
