import type { UserRole } from '../types/auth';

const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Administrador',
  OPERATOR: 'Operador',
  VIEWER: 'Visualizador',
};

export function roleLabel(role: UserRole): string {
  return ROLE_LABELS[role] ?? role;
}

/** "Rebeca Lara" → "RL"; sem nome, usa as 2 primeiras letras do username. */
export function initials(displayName: string | undefined, username: string | undefined): string {
  const parts = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (username ?? '?').slice(0, 2).toUpperCase();
}

const relativeFormatter = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

/** "há 5 minutos", "em 42 minutos", "agora" — para passado e futuro. */
export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const diffSeconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 45) return 'agora';
  if (abs < 3600) return relativeFormatter.format(Math.round(diffSeconds / 60), 'minute');
  if (abs < 86400) return relativeFormatter.format(Math.round(diffSeconds / 3600), 'hour');
  return relativeFormatter.format(Math.round(diffSeconds / 86400), 'day');
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** 1659704 → "1,6 MB". Base 1024, como o Windows Explorer. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[unit]}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR');
}
