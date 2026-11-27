import { render, screen } from '@testing-library/react';
import { setupUser } from '../../test/user';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../ConfirmDialog';
import { AuthProvider } from '../../context/AuthContext';
import { storeSession } from '../../test/tokens';
import { AppLayout } from './AppLayout';

function renderLayout(page = <p>conteúdo do Histórico</p>) {
  storeSession();
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/history']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/history" element={page} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

/** Página com uma janela de confirmação aberta por cima de tudo. */
function PageWithDialog({ onCancel }: { onCancel: () => void }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <ConfirmDialog
      title="Descartar alterações?"
      confirmLabel="Descartar"
      onCancel={() => {
        onCancel();
        setOpen(false);
      }}
      onConfirm={() => {}}
    >
      texto
    </ConfirmDialog>
  ) : null;
}

describe('AppLayout — cabeçalho e gaveta do menu (celular)', () => {
  it('título da página é o nome no menu; usuário e perfil no cabeçalho', () => {
    renderLayout();
    expect(screen.getByRole('heading', { level: 1, name: 'Histórico' })).toBeInTheDocument();
    expect(screen.getByText('Test User')).toBeInTheDocument();
    expect(screen.getByText('Administrador')).toBeInTheDocument();
    expect(screen.getByText('conteúdo do Histórico')).toBeInTheDocument();
  });

  it('"Abrir menu" abre a gaveta; o fundo escuro (role="presentation") fecha ao clicar', async () => {
    const user = setupUser();
    renderLayout();
    await user.click(screen.getByRole('button', { name: 'Abrir menu' }));
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument();
    const backdrop = screen.getByTestId('drawer-backdrop');
    expect(backdrop).toHaveAttribute('role', 'presentation');
    await user.click(backdrop);
    expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
  });

  it('Esc fecha a gaveta', async () => {
    const user = setupUser();
    renderLayout();
    await user.click(screen.getByRole('button', { name: 'Abrir menu' }));
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
  });

  it('com uma janela de confirmação aberta por cima, o Esc é dela: a gaveta continua aberta', async () => {
    const onCancel = vi.fn();
    const user = setupUser();
    renderLayout(<PageWithDialog onCancel={onCancel} />);
    // Abre a gaveta "por baixo" da janela (o clique no botão atravessaria o fundo da janela).
    screen.getByRole('button', { name: 'Abrir menu', hidden: true }).click();
    await screen.findByRole('dialog', { name: 'Menu' });

    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1); // a janela fechou
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument(); // a gaveta não

    await user.keyboard('{Escape}'); // sem janela: agora fecha a gaveta
    expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
  });

  it('Esc com a gaveta fechada não faz nada', async () => {
    renderLayout();
    await setupUser().keyboard('{Escape}');
    expect(screen.getByText('conteúdo do Histórico')).toBeInTheDocument();
  });

  it('pelo teclado, a gaveta fecha pelo botão "Fechar menu"', async () => {
    const user = setupUser();
    renderLayout();
    await user.click(screen.getByRole('button', { name: 'Abrir menu' }));
    await user.click(screen.getByRole('button', { name: 'Fechar menu' }));
    expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
  });
});
