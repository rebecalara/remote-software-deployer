import { fireEvent, render, screen } from '@testing-library/react';
import { setupUser } from '../test/user';
import { describe, expect, it, vi } from 'vitest';
import { Tooltip, TooltipTarget } from './Tooltip';

describe('TooltipTarget — gatilho nativo para texto ou selo com dica', () => {
  it('é um botão de verdade (type="button"), com foco pelo Tab', async () => {
    render(
      <Tooltip content="Data completa">
        <TooltipTarget>há 27 min</TooltipTarget>
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'há 27 min' });
    expect(trigger).toHaveAttribute('type', 'button');
    await setupUser().tab();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAccessibleDescription('Data completa');
  });

  it('dentro de um formulário, clicar ou apertar Enter nele não envia o formulário', async () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    const user = setupUser();
    render(
      <form onSubmit={onSubmit}>
        <Tooltip content="ProductCode {X}">
          <TooltipTarget>Sim (MSI)</TooltipTarget>
        </Tooltip>
      </form>,
    );
    await user.click(screen.getByRole('button', { name: 'Sim (MSI)' }));
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('os eventos da dica ficam no gatilho: o elemento em volta não tem evento nem foco', () => {
    render(
      <Tooltip content="Dica">
        <TooltipTarget>texto</TooltipTarget>
      </Tooltip>,
    );
    const wrapper = screen.getByRole('button', { name: 'texto' }).parentElement!;
    const props = Object.entries(wrapper).find(([k]) => k.startsWith('__reactProps$'))![1] as Record<string, unknown>;
    expect(Object.keys(props).filter((k) => k.startsWith('on'))).toEqual([]);
    expect(wrapper).not.toHaveAttribute('tabindex');
  });

  it('os eventos que o gatilho já tinha continuam funcionando', async () => {
    const onFocus = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <Tooltip content="Dica">
        <button type="button" onFocus={onFocus} onKeyDown={onKeyDown}>
          i
        </button>
      </Tooltip>,
    );
    const user = setupUser();
    await user.tab();
    await user.keyboard('a');
    expect(onFocus).toHaveBeenCalled();
    expect(onKeyDown).toHaveBeenCalled();
    expect(screen.getByRole('tooltip', { hidden: true })).not.toHaveClass('hidden');
  });
});

describe('Tooltip — dica acessível (mouse, teclado e leitor de tela)', () => {
  it('fechada não ocupa espaço; abre ao passar o mouse e fecha ao sair', async () => {
    const user = setupUser();
    render(
      <Tooltip content="Data completa: 19/11/2026 22:42">
        <span tabIndex={0}>há 27 min</span>
      </Tooltip>,
    );
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(tip).toHaveClass('hidden');
    await user.hover(screen.getByText('há 27 min'));
    expect(tip).not.toHaveClass('hidden');
    await user.unhover(screen.getByText('há 27 min'));
    expect(tip).toHaveClass('hidden');
  });

  it('abre ao receber foco pelo Tab e fecha com Esc', async () => {
    const user = setupUser();
    render(
      <Tooltip content="Consultar de novo">
        <button type="button">↻</button>
      </Tooltip>,
    );
    await user.tab();
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(tip).not.toHaveClass('hidden');
    await user.keyboard('{Escape}');
    expect(tip).toHaveClass('hidden');
  });

  it('Esc fecha só a dica: não chega ao painel por trás', () => {
    const panelEsc = vi.fn();
    render(
      <div onKeyDown={panelEsc}>
        <Tooltip content="Dica">
          <button type="button">i</button>
        </Tooltip>
      </div>,
    );
    const button = screen.getByRole('button');
    fireEvent.focus(button);
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(panelEsc).not.toHaveBeenCalled();
    // Com a dica já fechada, o Esc segue (o segundo Esc fecha o painel).
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(panelEsc).toHaveBeenCalledTimes(1);
  });

  it('é a DESCRIÇÃO do elemento (aria-describedby)', () => {
    render(
      <Tooltip content="Máquinas cuja porta do WinRM respondeu">
        <span tabIndex={0}>Acessíveis</span>
      </Tooltip>,
    );
    expect(screen.getByText('Acessíveis')).toHaveAccessibleDescription('Máquinas cuja porta do WinRM respondeu');
  });

  it('em botão só com ícone, é o NOME do botão (aria-labelledby), sem repetir como descrição', () => {
    render(
      <Tooltip content="Atualizar agora" asLabel>
        <button type="button">↻</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Atualizar agora' });
    expect(button).not.toHaveAttribute('aria-describedby');
  });
});
