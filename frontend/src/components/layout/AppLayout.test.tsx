import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AuthProvider } from '../../context/AuthContext';
import { storeSession } from '../../test/tokens';
import { AppLayout } from './AppLayout';

function renderLayout() {
  storeSession();
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/history']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/history" element={<p>conteúdo do Histórico</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
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
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole('button', { name: 'Abrir menu' }));
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument();
    const backdrop = screen.getByTestId('drawer-backdrop');
    expect(backdrop).toHaveAttribute('role', 'presentation');
    await user.click(backdrop);
    expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
  });

  it('pelo teclado, a gaveta fecha pelo botão "Fechar menu"', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole('button', { name: 'Abrir menu' }));
    await user.click(screen.getByRole('button', { name: 'Fechar menu' }));
    expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
  });
});
