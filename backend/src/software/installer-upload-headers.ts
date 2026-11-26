import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';

// Cabeçalhos do PUT /software/:id/installer, conferidos ANTES de ler o corpo — um
// envio que vai ser recusado não deve transferir centenas de MB à toa.
//
// Corpo binário (application/octet-stream), sem multipart: o nome original vem no
// cabeçalho X-File-Name, codificado com encodeURIComponent (cabeçalho HTTP não
// carrega acentos com segurança). Ver DECISIONS.md.

const MAX_ORIGINAL_NAME = 255;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Valida os cabeçalhos e devolve o nome original do arquivo (só para exibição). */
export function parseInstallerUploadHeaders(headers: IncomingHttpHeaders, maxBytes: number): string {
  const contentType = (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/octet-stream') {
    throw new UnsupportedMediaTypeException(
      'Envie o instalador como corpo binário (Content-Type: application/octet-stream).',
    );
  }

  // Sem Content-Length (envio em partes), o limite ainda é aplicado durante a
  // gravação; com ele, dá para recusar antes de receber qualquer byte.
  const rawLength = headers['content-length'];
  if (rawLength !== undefined) {
    const length = Number(rawLength);
    if (!Number.isInteger(length) || length < 0) {
      throw new BadRequestException('Content-Length inválido.');
    }
    if (length === 0) throw new BadRequestException('O arquivo enviado está vazio.');
    if (length > maxBytes) {
      throw new PayloadTooLargeException(
        `O instalador excede o tamanho máximo de ${Math.round(maxBytes / 1024 / 1024)} MB.`,
      );
    }
  }

  return parseOriginalName(headers['x-file-name']);
}

function parseOriginalName(raw: string | string[] | undefined): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new BadRequestException('Cabeçalho X-File-Name obrigatório (nome original do arquivo).');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new BadRequestException('X-File-Name mal codificado: use encodeURIComponent.');
  }
  // Só o nome, nunca o caminho de quem enviou (ex.: C:\Users\fulano\Downloads\…).
  const name = decoded.split(/[\\/]/).pop()!.trim();
  if (name === '' || CONTROL_CHARS.test(name)) {
    throw new BadRequestException('Nome de arquivo inválido em X-File-Name.');
  }
  if (name.length > MAX_ORIGINAL_NAME) {
    throw new BadRequestException(`Nome de arquivo com mais de ${MAX_ORIGINAL_NAME} caracteres.`);
  }
  return name;
}
