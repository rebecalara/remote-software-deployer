import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setMatchMedia } from '../test/setup';
import { ConfirmDialog } from './ConfirmDialog';
import { SidePanel } from './SidePanel';

describe('SidePanel — painel lateral (Detalhes da máquina, Catálogo)', () => {
  it('tem nome pelo título e fecha pelo X', async () => {
    const onClose = vi.fn();
    render(
      <SidePanel title="Detalhes da máquina" onClose={onClose} closeLabel="Fechar detalhes">
        conteúdo
      </SidePanel>,
    );
    expect(screen.getByRole('complementary', { name: 'Detalhes da máquina' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fechar detalhes' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc pede para fechar', async () => {
    const onClose = vi.fn();
    render(<SidePanel title="Painel" onClose={onClose}>x</SidePanel>);
    await userEvent.setup().keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('com uma confirmação aberta, o Esc é da confirmação: o painel não fecha', async () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    render(
      <>
        <SidePanel title="Novo software" onClose={onClose}>
          formulário
        </SidePanel>
        <ConfirmDialog title="Descartar alterações?" confirmLabel="Descartar" onCancel={onCancel} onConfirm={() => {}}>
          texto
        </ConfirmDialog>
      </>,
    );
    await userEvent.setup().keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('em tela estreita fica sobreposto: clique no fundo escuro pede para fechar', async () => {
    const onClose = vi.fn();
    const { container } = render(<SidePanel title="Painel" onClose={onClose}>x</SidePanel>);
    expect(container.firstElementChild).toHaveClass('fixed');
    // Sem papel interativo: é só um atalho de mouse (o teclado usa Esc e o X).
    expect(container.querySelector('.bg-slate-950\\/40')).toHaveAttribute('role', 'presentation');
    await userEvent.setup().click(container.querySelector('.bg-slate-950\\/40')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('em tela larga (≥ 1280 px) é uma coluna ao lado da página, sem fundo escuro', () => {
    setMatchMedia(true);
    const { container } = render(<SidePanel title="Painel" onClose={() => {}}>x</SidePanel>);
    expect(container.firstElementChild).not.toHaveClass('fixed');
    expect(container.querySelector('.bg-slate-950\\/40')).toBeNull();
  });

  it('rodapé opcional fica fora da área que rola; X desativado durante um envio', () => {
    render(
      <SidePanel title="Painel" onClose={() => {}} closeDisabled footer={<button type="button">Salvar</button>}>
        x
      </SidePanel>,
    );
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fechar' })).toBeDisabled();
  });
});
