import { isIP } from 'node:net';

// IP do cliente para o limite de tentativas de login (DECISIONS.md).
//
// Em produção o Caddy fica na frente e repassa a requisição de 127.0.0.1; o IP real do
// cliente vem no X-Forwarded-For. Esse cabeçalho só é confiável quando quem conectou foi
// o próprio Caddy: vindo de qualquer outro endereço, o cliente escreve o que quiser nele.
//
// Não usa o `trust proxy` do Express de propósito: valeria para a aplicação inteira, e
// aqui a regra fica explícita e testável num lugar só.

/** Único endereço tratado como proxy confiável: o Caddy na mesma máquina. */
export const TRUSTED_PROXY = '127.0.0.1';
export const UNKNOWN_CLIENT = 'desconhecido';

/** "::ffff:1.2.3.4" (IPv4 mapeado em IPv6, como o Node às vezes informa) → "1.2.3.4". */
function normalize(ip: string): string {
  const trimmed = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped ? mapped[1] : trimmed;
}

/**
 * Socket de 127.0.0.1 (o Caddy) → o ÚLTIMO endereço do X-Forwarded-For, que é o que o
 * Caddy viu (um anterior teria vindo do próprio cliente). Cabeçalho ausente ou inválido →
 * o endereço do socket. Socket de qualquer outro endereço → ele mesmo, ignorando o
 * cabeçalho.
 */
export function resolveClientIp(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined): string {
  if (!remoteAddress) return UNKNOWN_CLIENT;
  const remote = normalize(remoteAddress);
  if (remote !== TRUSTED_PROXY || forwardedFor === undefined) return remote;

  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor).split(',');
  const last = normalize(chain[chain.length - 1] ?? '');
  return isIP(last) !== 0 ? last : remote;
}
