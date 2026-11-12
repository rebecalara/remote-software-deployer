import { BadRequestException } from '@nestjs/common';

// Validação do corpo de POST /deployments (função pura, sem banco). O 400 leva o
// campo com problema (`field`), como no catálogo, para a tela apontar onde errou.

export const MAX_TARGETS_PER_DEPLOYMENT = 50;
export const MAX_NAME_LENGTH = 120;

export interface DeploymentCreateInput {
  softwareId: string;
  /** Sem repetição, na ordem em que vieram. */
  machineIds: string[];
  /** null = o servidor gera ("7-Zip 26.06 — 5 máquinas"). */
  name: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ALLOWED_FIELDS = new Set(['softwareId', 'machineIds', 'name']);

export function validateDeploymentCreate(body: unknown): DeploymentCreateInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('body', 'O corpo da requisição deve ser um objeto JSON.');
  }
  const data = body as Record<string, unknown>;
  const unknown = Object.keys(data).find((key) => !ALLOWED_FIELDS.has(key));
  if (unknown) throw invalid(unknown, `Campo não permitido: ${unknown}.`);

  if (typeof data.softwareId !== 'string' || !UUID.test(data.softwareId)) {
    throw invalid('softwareId', 'Selecione um software válido.');
  }

  if (!Array.isArray(data.machineIds) || data.machineIds.length === 0) {
    throw invalid('machineIds', 'Selecione ao menos uma máquina.');
  }
  if (data.machineIds.some((id) => typeof id !== 'string' || !UUID.test(id))) {
    throw invalid('machineIds', 'A lista de máquinas contém um identificador inválido.');
  }
  const machineIds = [...new Set((data.machineIds as string[]).map((id) => id.toLowerCase()))];
  if (machineIds.length > MAX_TARGETS_PER_DEPLOYMENT) {
    throw invalid('machineIds', `Selecione no máximo ${MAX_TARGETS_PER_DEPLOYMENT} máquinas por implantação.`);
  }

  let name: string | null = null;
  if (data.name !== undefined && data.name !== null) {
    if (typeof data.name !== 'string') throw invalid('name', 'O nome deve ser um texto.');
    const trimmed = data.name.trim();
    if (CONTROL_CHARS.test(trimmed)) throw invalid('name', 'O nome contém caracteres inválidos.');
    if (trimmed.length > MAX_NAME_LENGTH) {
      throw invalid('name', `O nome deve ter no máximo ${MAX_NAME_LENGTH} caracteres.`);
    }
    name = trimmed || null;
  }

  return { softwareId: data.softwareId.toLowerCase(), machineIds, name };
}

function invalid(field: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', message, field });
}
