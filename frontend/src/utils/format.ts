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

/**
 * Tempo relativo, ÚNICO formatador do sistema: "agora", "há 33 min", "há 3 h", "há 1 dia",
 * "há 4 dias" (no futuro, "em 15 min"). Minutos e horas abreviados, dias por extenso.
 * Arredonda para baixo: "há 59 min" até completar 1 h.
 */
export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const diff = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return 'agora';
  let text: string;
  if (abs < 3600) text = `${Math.max(1, Math.floor(abs / 60))} min`;
  else if (abs < 86400) text = `${Math.floor(abs / 3600)} h`;
  else {
    const days = Math.floor(abs / 86400);
    text = `${days} ${days === 1 ? 'dia' : 'dias'}`;
  }
  return diff < 0 ? `há ${text}` : `em ${text}`;
}

/** Data e hora no padrão do sistema, sem vírgula: "19/11/2026 22:42". */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
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
