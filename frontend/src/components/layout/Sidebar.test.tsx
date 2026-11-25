import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../context/AuthContext';
import { storeSession, TEST_USER } from '../../test/tokens';
import type { UserRole } from '../../types/auth';
import { Sidebar } from './Sidebar';
import { titleForPath } from './navItems';

function renderMenu(role: UserRole, props: Partial<Parameters<typeof Sidebar>[0]> = {}, path = '/history') {
  storeSession(3600, { ...TEST_USER, role });
  const handlers = { onToggleCollapsed: vi.fn(), onLogout: vi.fn() };
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar collapsed={false} {...handlers} {...props} />
      </MemoryRouter>
    </AuthProvider>,
  );
  return handlers;
}
const menuItems = () =>
  within(screen.getByRole('navigation', { name: 'Menu principal' }))
    .getAllByRole('link')
    .map((a) => a.textContent);

describe('Sidebar — menu por perfil', () => {
  it.each(['ADMIN', 'OPERATOR'] as const)('%s vê os seis itens, na ordem do mockup', (role) => {
    renderMenu(role);
    expect(menuItems()).toEqual(['Dashboard', 'Máquinas', 'Catálogo de Software', 'Nova Implantação', 'Monitoramento', 'Histórico']);
  });

  it('VIEWER não vê "Nova Implantação" (só leria o aviso de que não pode implantar)', () => {
    renderMenu('VIEWER');
    expect(menuItems()).not.toContain('Nova Implantação');
    expect(menuItems()).toHaveLength(5);
  });

  it('marca a página atual', () => {
    renderMenu('ADMIN', {}, '/history');
    expect(screen.getByRole('link', { name: 'Histórico' })).toHaveAttribute('aria-current', 'page');
  });

  it('recolhido: só os ícones, com o nome no title; botão "Expandir menu"', async () => {
    const { onToggleCollapsed } = renderMenu('ADMIN', { collapsed: true });
    expect(screen.queryByText('Histórico')).not.toBeInTheDocument();
    expect(screen.getByTitle('Histórico')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Expandir menu' }));
    expect(onToggleCollapsed).toHaveBeenCalled();
  });

  it('no celular (gaveta) tem "Fechar menu" no lugar do ☰', async () => {
    const onCloseMobile = vi.fn();
    renderMenu('ADMIN', { onCloseMobile });
    expect(screen.queryByRole('button', { name: 'Recolher menu' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fechar menu' }));
    expect(onCloseMobile).toHaveBeenCalled();
  });

  it('"Sair"', async () => {
    const { onLogout } = renderMenu('ADMIN');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sair' }));
    expect(onLogout).toHaveBeenCalled();
  });
});

describe('titleForPath — o título da página é o nome no menu', () => {
  it.each([
    ['/machines', 'Máquinas'],
    ['/deployments/new', 'Nova Implantação'],
    ['/history', 'Histórico'],
    ['/deployments/abc', 'Implantação'],
    ['/qualquer', 'Remote Software Deployer'],
  ])('%s → %s', (path, title) => {
    expect(titleForPath(path)).toBe(title);
  });
});
