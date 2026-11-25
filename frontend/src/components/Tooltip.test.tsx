import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Tooltip } from './Tooltip';

describe('Tooltip — dica acessível (mouse, teclado e leitor de tela)', () => {
  it('fechada não ocupa espaço; abre ao passar o mouse e fecha ao sair', async () => {
    const user = userEvent.setup();
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
    const user = userEvent.setup();
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
