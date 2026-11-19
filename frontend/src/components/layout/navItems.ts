import type { ComponentType } from 'react';
import type { UserRole } from '../../types/auth';
import {
  ActivityIcon,
  DashboardIcon,
  HistoryIcon,
  MonitorIcon,
  PackageIcon,
  PlusCircleIcon,
  type IconProps,
} from '../icons';

export interface NavItem {
  label: string;
  path: string;
  /** Título mostrado no cabeçalho quando a rota está ativa. */
  title: string;
  icon: ComponentType<IconProps>;
  /** false = fica fora do menu até o bloco existir. Virar true quando ele existir. */
  available: boolean;
  block?: string;
  /** Só estes perfis veem o item. Ausente = todos os perfis logados. */
  roles?: UserRole[];
}

// Lista única do menu: cada bloco novo só muda `available` aqui.
export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', path: '/dashboard', title: 'Dashboard', icon: DashboardIcon, available: true },
  { label: 'Máquinas', path: '/machines', title: 'Gerenciamento de Máquinas', icon: MonitorIcon, available: true },
  { label: 'Catálogo de Software', path: '/software', title: 'Catálogo de Software', icon: PackageIcon, available: true },
  { label: 'Nova Implantação', path: '/deployments/new', title: 'Nova Implantação', icon: PlusCircleIcon, available: true, roles: ['ADMIN', 'OPERATOR'] },
  { label: 'Monitoramento', path: '/monitoring', title: 'Monitoramento', icon: ActivityIcon, available: true },
  { label: 'Histórico', path: '/history', title: 'Histórico', icon: HistoryIcon, available: true },
];

export function titleForPath(pathname: string): string {
  const item = NAV_ITEMS.find((i) => pathname.startsWith(i.path));
  if (item) return item.title;
  // Fora do menu: /deployments/:id só redireciona para o Monitoramento ou o Histórico.
  if (pathname.startsWith('/deployments/')) return 'Implantação';
  return 'Remote Software Deployer';
}
