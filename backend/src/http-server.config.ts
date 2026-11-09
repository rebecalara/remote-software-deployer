import { Logger } from '@nestjs/common';

// Tempo máximo para o servidor HTTP receber uma requisição inteira (cabeçalhos +
// corpo). O padrão do Node 22 é 5 min — pouco para enviar um instalador de 500 MB
// numa rede lenta (exigiria ~13 Mbit/s do começo ao fim). Ver DECISIONS.md.
//
// Vale para todas as rotas: é uma configuração do servidor, não de uma rota. O
// headersTimeout (60 s, padrão do Node) não é alterado — os cabeçalhos continuam
// tendo de chegar rápido; só o corpo ganha mais tempo.

export const DEFAULT_REQUEST_TIMEOUT_MINUTES = 30; // ~500 MB a ~2,4 Mbit/s
export const MIN_REQUEST_TIMEOUT_MINUTES = 1;
export const MAX_REQUEST_TIMEOUT_MINUTES = 120;

/**
 * Lê HTTP_REQUEST_TIMEOUT_MINUTES. Não aceita 0: no Node, 0 desliga o limite e uma
 * conexão que envia o corpo devagar de propósito ficaria aberta indefinidamente.
 */
export function parseRequestTimeoutMinutes(raw: string | undefined, logger?: Logger): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_REQUEST_TIMEOUT_MINUTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_REQUEST_TIMEOUT_MINUTES) {
    logger?.warn(
      `HTTP_REQUEST_TIMEOUT_MINUTES inválido ("${raw}"); usando ${DEFAULT_REQUEST_TIMEOUT_MINUTES}.`,
    );
    return DEFAULT_REQUEST_TIMEOUT_MINUTES;
  }
  if (value > MAX_REQUEST_TIMEOUT_MINUTES) {
    logger?.warn(
      `HTTP_REQUEST_TIMEOUT_MINUTES=${value} acima do teto; usando ${MAX_REQUEST_TIMEOUT_MINUTES}.`,
    );
    return MAX_REQUEST_TIMEOUT_MINUTES;
  }
  return value;
}

/** Aplica o limite ao servidor HTTP e devolve o valor efetivo em milissegundos. */
export function configureRequestTimeout(server: { requestTimeout: number }, logger?: Logger): number {
  const ms = parseRequestTimeoutMinutes(process.env.HTTP_REQUEST_TIMEOUT_MINUTES, logger) * 60_000;
  server.requestTimeout = ms;
  return ms;
}
