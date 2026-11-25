import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { LogOutIcon, MenuIcon, XIcon } from '../icons';
import { NAV_ITEMS } from './navItems';
import { RsdMark } from '../brand/RsdMark';
import { RsdWordmark } from '../brand/RsdWordmark';

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Só em telas estreitas: o menu vira gaveta e precisa de botão de fechar. */
  onCloseMobile?: () => void;
  onLogout: () => void;
}


function SectionTitle({ collapsed, className = '', children }: { collapsed: boolean; className?: string; children: string }) {
  // Recolhido: só um divisor, para manter a separação entre os grupos.
  if (collapsed) return <div className={`mx-2 mb-2 border-t border-white/5 ${className}`} aria-hidden="true" />;
  return (
    <p className={`mb-2 px-3 text-meta font-semibold tracking-wider text-slate-500 uppercase ${className}`}>{children}</p>
  );
}

export function Sidebar({ collapsed, onToggleCollapsed, onCloseMobile, onLogout }: SidebarProps) {
  const { user } = useAuth();
  // Item com `roles` só aparece para esses perfis (ex.: "Nova Implantação" não aparece
  // para VIEWER — a página só mostraria o aviso de que ele não pode implantar).
  const availableItems = NAV_ITEMS.filter(
    (item) => item.available && (!item.roles || (user !== null && item.roles.includes(user.role))),
  );
  const itemBase =
    'flex items-center gap-3 rounded-lg px-3 py-2.5 text-body font-medium transition-colors';

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-300">
      {/* Logo (link para o Dashboard; anima ao passar o mouse) + botão de recolher (☰).
          Aberto: logo alinhada à esquerda com os ícones do menu (24 px), ☰ à direita.
          Recolhido (72 px): só o símbolo, com o ☰ embaixo. */}
      <div
        className={`flex border-b border-white/5 py-5 ${
          collapsed ? 'flex-col items-center gap-3 px-2' : 'items-center gap-3 pr-4 pl-6'
        }`}
      >
        <Link
          to="/dashboard"
          onClick={onCloseMobile}
          aria-label="Remote Software Deployer — ir para o Dashboard"
          title="Ir para o Dashboard"
          className="group flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          <RsdMark tone="dark" animateOnHover className="h-8 w-8 shrink-0" />
          {!collapsed && <RsdWordmark tone="dark" className="text-page" />}
        </Link>
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
