import { render, screen } from '@testing-library/react';
import { setupUser } from '../test/user';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

function renderDialog() {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog title="Descartar alterações?" confirmLabel="Descartar" cancelLabel="Continuar editando" onCancel={onCancel} onConfirm={onConfirm}>
      As alterações não salvas serão perdidas.
    </ConfirmDialog>,
  );
  return { onCancel, onConfirm, user: setupUser() };
}

describe('ConfirmDialog — janela de confirmação do sistema', () => {
  it('é um alertdialog com título e texto lidos pelo leitor de tela', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog', { name: 'Descartar alterações?' });
    expect(dialog).toHaveAccessibleDescription('As alterações não salvas serão perdidas.');
  });

  it('o foco começa no botão seguro: um Enter distraído não descarta nada', async () => {
    const { onCancel, onConfirm, user } = renderDialog();
    expect(screen.getByRole('button', { name: 'Continuar editando' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Esc cancela', async () => {
    const { onCancel, user } = renderDialog();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('clique fora cancela; clique dentro da janela não', async () => {
    const { onCancel, user } = renderDialog();
    await user.click(screen.getByText('As alterações não salvas serão perdidas.'));
    expect(onCancel).not.toHaveBeenCalled();
    await user.click(screen.getByRole('alertdialog').parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('o fundo escuro não tem papel interativo (role="presentation"); clicar na margem da janela não cancela', async () => {
    const { onCancel, user } = renderDialog();
    const backdrop = screen.getByRole('alertdialog').parentElement!;
    expect(backdrop).toHaveAttribute('role', 'presentation');
    await user.click(screen.getByRole('alertdialog')); // a própria janela, fora dos textos
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('o botão de confirmar executa a ação', async () => {
    const { onConfirm, user } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
