import type { ComponentType } from 'react';
import {
  ActivityIcon,
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
}

// Lista única do menu: cada bloco novo só muda `available` aqui.
export const NAV_ITEMS: NavItem[] = [
  { label: 'Máquinas', path: '/machines', title: 'Gerenciamento de Máquinas', icon: MonitorIcon, available: true },
  { label: 'Catálogo de Software', path: '/software', title: 'Catálogo de Software', icon: PackageIcon, available: true },
  { label: 'Nova Instalação', path: '/deployments/new', title: 'Nova Instalação', icon: PlusCircleIcon, available: true },
  { label: 'Monitoramento', path: '/monitoring', title: 'Monitoramento', icon: ActivityIcon, available: false, block: 'Bloco 5' },
  { label: 'Histórico', path: '/history', title: 'Histórico', icon: HistoryIcon, available: false, block: 'Bloco 6' },
];

export function titleForPath(pathname: string): string {
  return NAV_ITEMS.find((item) => pathname.startsWith(item.path))?.title ?? 'Remote Software Deployer';
}
