import { Logger } from '@nestjs/common';
import { AddressInfo, isIP } from 'node:net';

// Endereço em que o servidor HTTP escuta (HOST e PORT). Ver DECISIONS.md.
//
// O padrão é 127.0.0.1: em produção, o Caddy fica na frente fazendo o HTTPS, e o
// backend não deve ser alcançável direto pela rede (sem TLS). Dentro de contêiner, HOST
// precisa ser 0.0.0.0 — 127.0.0.1 ali é o próprio contêiner, e o proxy de fora não
// alcançaria o backend.

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3000;
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

/** Nome de host (RFC 1123): rótulos com letras, dígitos e hífen, sem hífen nas pontas. */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export interface ListenAddress {
  host: string;
  port: number;
}

/** Lê PORT: inteiro de 1 a 65535. Ausente usa o padrão; inválido usa o padrão com aviso. */
export function parsePort(raw: string | undefined, logger?: Logger): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const text = raw.trim();
  // Só dígitos: Number() aceitaria "1e3", "0x10" e "+3000".
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    logger?.warn(`PORT inválido ("${raw}"): precisa ser um inteiro de ${MIN_PORT} a ${MAX_PORT}; usando ${DEFAULT_PORT}.`);
    return DEFAULT_PORT;
  }
  return value;
}

/**
 * Lê HOST: endereço IP (v4 ou v6) ou nome de host. Ausente usa o padrão; inválido (ex.:
 * "http://0.0.0.0" ou "127.0.0.1:3000") usa o padrão com aviso — melhor escutar só na
 * máquina local do que num endereço que ninguém pediu.
 */
export function parseHost(raw: string | undefined, logger?: Logger): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_HOST;
  const text = raw.trim();
  if (isIP(text) === 0 && !HOSTNAME.test(text)) {
    logger?.warn(`HOST inválido ("${raw}"): precisa ser um endereço IP ou nome de host; usando ${DEFAULT_HOST}.`);
    return DEFAULT_HOST;
  }
  return text;
}

/** HOST e PORT do ambiente. */
export function loadListenAddress(env: NodeJS.ProcessEnv = process.env, logger?: Logger): ListenAddress {
  return { host: parseHost(env.HOST, logger), port: parsePort(env.PORT, logger) };
}

/** Endereço real em que o servidor escuta (o de server.address()), para o log. */
export function formatListenAddress(address: AddressInfo | string | null): string {
  if (address === null) return '(endereço desconhecido)';
  if (typeof address === 'string') return address;
  const host = address.family === 'IPv6' || isIP(address.address) === 6 ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}
