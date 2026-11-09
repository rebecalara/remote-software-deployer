import { NavLink } from 'react-router-dom';
import { LogOutIcon, MenuIcon, XIcon } from '../icons';
import { NAV_ITEMS } from './navItems';

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Só em telas estreitas: o menu vira gaveta e precisa de botão de fechar. */
  onCloseMobile?: () => void;
  onLogout: () => void;
}

const availableItems = NAV_ITEMS.filter((item) => item.available);
const upcomingItems = NAV_ITEMS.filter((item) => !item.available);

function SectionTitle({ collapsed, className = '', children }: { collapsed: boolean; className?: string; children: string }) {
  // Recolhido: só um divisor, para manter a separação entre os grupos.
  if (collapsed) return <div className={`mx-2 mb-2 border-t border-white/5 ${className}`} aria-hidden="true" />;
  return (
    <p className={`mb-2 px-3 text-[11px] font-semibold tracking-wider text-slate-500 uppercase ${className}`}>{children}</p>
  );
}

export function Sidebar({ collapsed, onToggleCollapsed, onCloseMobile, onLogout }: SidebarProps) {
  const itemBase =
    'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors';

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-300">
      {/* Identidade + botão de recolher (☰). Recolhido, os 72px não comportam logo e
          botão lado a lado: fica só o ☰, que é o que permite expandir de volta. */}
      <div className={`flex items-center gap-3 border-b border-white/5 py-5 ${collapsed ? 'justify-center px-2' : 'px-5'}`}>
        {!collapsed && (
          <>
            {/* Fundo branco: a logo é azul-marinho com fundo transparente e sumiria no slate-950 */}
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white p-0.5">
              <img
                src="/Logotipo_Prefeitura.png"
                alt="Prefeitura Municipal de Joinville"
                className="h-full w-full object-contain"
              />
            </div>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold text-white">Remote Software</p>
              <p className="truncate text-xs text-slate-400">Deployer</p>
            </div>
          </>
        )}
        {!onCloseMobile && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
            title={collapsed ? 'Expandir menu' : 'Recolher menu'}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-white/10 hover:text-white ${collapsed ? '' : 'ml-auto'}`}
          >
            <MenuIcon className="h-5 w-5" />
          </button>
        )}
        {onCloseMobile && (
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Fechar menu"
            className="ml-auto rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <XIcon className="h-5 w-5" />
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="border-b border-white/5 px-5 py-4">
          <p className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">Organização</p>
          <p className="mt-1 text-sm font-medium text-slate-200">Prefeitura de Joinville</p>
        </div>
      )}

      {/* Navegação */}
      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Menu principal">
        <SectionTitle collapsed={collapsed}>Menu principal</SectionTitle>
        <ul className="space-y-1">
          {availableItems.map(({ label, path, icon: Icon }) => (
            <li key={path}>
              <NavLink
                to={path}
                onClick={onCloseMobile}
                title={collapsed ? label : undefined}
                className={({ isActive }) =>
                  `${itemBase} ${collapsed ? 'justify-center' : ''} ${
                    isActive ? 'bg-blue-600 text-white' : 'hover:bg-white/5 hover:text-white'
                  }`
                }
              >
                <Icon className="h-5 w-5 shrink-0" />
                {!collapsed && <span className="truncate">{label}</span>}
              </NavLink>
            </li>
          ))}
        </ul>

        {/* Itens dos próximos blocos: mesma ordem do mockup, agrupados em vez de um
            selo por item (o selo na mesma linha cortava "Catálogo de Software"). */}
        {upcomingItems.length > 0 && (
          <>
            <SectionTitle collapsed={collapsed} className="mt-6">Em breve</SectionTitle>
            <ul className="space-y-1">
              {upcomingItems.map(({ label, path, icon: Icon, block }) => (
                <li key={path}>
                  <span
                    aria-disabled="true"
                    title={`${label} — disponível no ${block}`}
                    className={`${itemBase} cursor-not-allowed text-slate-600 ${collapsed ? 'justify-center' : ''}`}
                  >
                    <Icon className="h-5 w-5 shrink-0" />
                    {!collapsed && <span className="truncate">{label}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>

      {/* Rodapé */}
      <div className="border-t border-white/5 px-3 py-3">
        <button
          type="button"
          onClick={onLogout}
          title={collapsed ? 'Sair' : undefined}
          className={`${itemBase} w-full hover:bg-white/5 hover:text-white ${collapsed ? 'justify-center' : ''}`}
        >
          <LogOutIcon className="h-5 w-5 shrink-0" />
          {!collapsed && <span>Sair</span>}
        </button>
      </div>
    </div>
  );
}
