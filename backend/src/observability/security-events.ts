import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { resolveClientIp } from '../auth/client-ip';
import { isAllowedLdapUsername } from '../ldap/ldap-security';

/**
 * Eventos de segurança (P1-1) em log estruturado. Cada evento é uma linha [Security] no console
 * e, com o New Relic ligado, um log com atributos separados (AppLogger), consultável por NRQL:
 *   FROM Log WHERE security.event = 'auth.login' AND security.result = 'failure'
 *
 * Nunca entram: senha, token (nem parte dele) ou corpo da requisição.
 * SECURITY_EVENTS_INCLUDE_PII=false (LGPD): user.name vira um hash curto (SHA-256 com o
 * JWT_SECRET como sal, 12 caracteres) e client.ip vira o prefixo de rede (/24 no IPv4, /48 no
 * IPv6). Padrão: true (demo).
 */

export type SecurityEventName =
  | 'auth.login'
  | 'auth.token'
  | 'authz.forbidden'
  | 'deployment.created'
  | 'deployment.cancelled'
  | 'deployment.finished'
  | 'catalog.software.created'
  | 'catalog.software.updated'
  | 'catalog.software.deactivated'
  | 'catalog.software.activated'
  | 'catalog.software.installer_uploaded'
  | 'catalog.software.deleted';

export type SecurityEventResult = 'success' | 'failure' | 'unavailable' | 'rate_limited' | 'denied' | 'expired' | 'invalid';

/** Resultados que vão como WARN; o resto, INFO. */
const WARN_RESULTS: ReadonlySet<SecurityEventResult> = new Set(['failure', 'unavailable', 'rate_limited', 'denied', 'expired', 'invalid']);

export type SecurityDetail = string | number | boolean | null | undefined;

export interface SecurityEvent {
  event: SecurityEventName;
  result: SecurityEventResult;
  user?: string | null;
  role?: string | null;
  ip?: string | null;
  /** Atributos extras, já com o nome final (ex.: "deployment.id"). */
  details?: Record<string, SecurityDetail>;
}

/** Usuário digitado no login que não passa na regra de nomes (pode ser uma senha digitada no lugar errado). */
export const INVALID_USERNAME = '<inválido>';
const MAX_DETAIL_LENGTH = 200;

const logger = new Logger('Security');

export function includePii(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SECURITY_EVENTS_INCLUDE_PII ?? '').trim().toLowerCase() !== 'false';
}

export function pseudonymizeUser(username: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${username}`).digest('hex').slice(0, 12);
}

/** "203.0.113.57" -> "203.0.113.0/24"; IPv6 -> /48; outro texto (ex.: "desconhecido") fica igual. */
export function truncateIp(ip: string): string {
  if (isIP(ip) === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(ip) === 6) {
    const [head, tail = ''] = ip.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const full = [...headParts, ...Array<string>(8 - headParts.length - tailParts.length).fill('0'), ...tailParts];
    return `${full.slice(0, 3).map((p) => p.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/48`;
  }
  return ip;
}

/**
 * O usuário digitado no login, em minúsculas, só se passar na mesma regra de nomes do login
 * (é comum alguém digitar a senha no campo de usuário). Fora da regra: "<inválido>".
 */
export function typedUsername(raw: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof raw !== 'string') return INVALID_USERNAME;
  const username = raw.trim().toLowerCase();
  return username && isAllowedLdapUsername(username, env.LDAP_BIND_DN_TEMPLATE ?? '') ? username : INVALID_USERNAME;
}

/** O mínimo da requisição do Express para achar o IP do cliente (mesma regra do limite de login). */
export interface RequestWithClient {
  socket?: { remoteAddress?: string };
  headers?: object;
}

export function requestIp(req: RequestWithClient | undefined): string {
  const forwarded = (req?.headers as Record<string, string | string[] | undefined> | undefined)?.['x-forwarded-for'];
  return resolveClientIp(req?.socket?.remoteAddress, forwarded);
}

export function buildSecurityAttributes(e: SecurityEvent, env: NodeJS.ProcessEnv = process.env): Record<string, string | number | boolean> {
  const pii = includePii(env);
  const attrs: Record<string, string | number | boolean> = {
    'security.event': e.event,
    'security.result': e.result,
    'security.pii': pii,
  };
  if (e.user) {
    attrs['user.name'] = pii || e.user === INVALID_USERNAME ? e.user : pseudonymizeUser(e.user, env.JWT_SECRET ?? '');
  }
  if (e.role) attrs['user.role'] = e.role;
  if (e.ip) attrs['client.ip'] = pii ? e.ip : truncateIp(e.ip);
  for (const [k, v] of Object.entries(e.details ?? {})) {
    if (v === undefined || v === null) continue;
    attrs[k] = typeof v === 'string' ? v.slice(0, MAX_DETAIL_LENGTH) : v;
  }
  return attrs;
}

/**
 * Registra o evento. Nunca lança: um evento que falha não pode derrubar o login, a rota nem a
 * implantação. Aceita uma função que monta o evento, para a montagem também ficar protegida.
 */
export function recordSecurityEvent(input: SecurityEvent | (() => SecurityEvent), env: NodeJS.ProcessEnv = process.env): void {
  try {
    const e = typeof input === 'function' ? input() : input;
    const attributes = buildSecurityAttributes(e, env);
    const message = { message: `${e.event} ${e.result}`, attributes };
    if (WARN_RESULTS.has(e.result)) logger.warn(message);
    else logger.log(message);
  } catch {
    // sem efeito colateral: o evento é só registro
  }
}
