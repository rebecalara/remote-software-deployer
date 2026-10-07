import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { initials, roleLabel } from '../../utils/format';
import { MenuIcon } from '../icons';
import { Sidebar } from './Sidebar';
import { titleForPath } from './navItems';

// Preferência de tela (não é dado sensível): localStorage, com try/catch
// porque pode estar bloqueado (modo privado, política do navegador).
const COLLAPSED_KEY = 'rsd.sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function AppLayout() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // sem persistência — segue funcionando na sessão atual
    }
  }, [collapsed]);

  // Trocar de página fecha a gaveta no mobile.
  useEffect(() => setMobileOpen(false), [pathname]);

  const title = titleForPath(pathname);

  return (
    <div className="flex h-screen overflow-hidden bg-slate-100">
      {/* Menu fixo (≥ 1024px) */}
      <aside className={`hidden shrink-0 transition-[width] duration-200 lg:block ${collapsed ? 'w-[72px]' : 'w-64'}`}>
        <Sidebar collapsed={collapsed} onToggleCollapsed={() => setCollapsed((c) => !c)} onLogout={logout} />
      </aside>

      {/* Gaveta (< 1024px) */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-slate-950/50" onClick={() => setMobileOpen(false)} />
          <aside className="relative h-full w-64 shadow-xl">
            <Sidebar
              collapsed={false}
              onToggleCollapsed={() => undefined}
              onCloseMobile={() => setMobileOpen(false)}
              onLogout={logout}
            />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Abrir menu"
            className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden"
          >
            <MenuIcon className="h-5 w-5" />
          </button>

          <h1 className="truncate text-lg font-semibold text-slate-900">{title}</h1>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-sm font-semibold text-slate-900">{user?.displayName || user?.username}</p>
              <p className="text-xs text-slate-500">{user ? roleLabel(user.role) : ''}</p>
            </div>
            <div
              className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white"
              aria-hidden="true"
            >
              {initials(user?.displayName, user?.username)}
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
