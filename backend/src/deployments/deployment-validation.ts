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

// ---------- GET /deployments (Histórico, Bloco 6) ----------

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const MAX_MACHINE_FILTER_LENGTH = 64;

const DEPLOYMENT_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
type DeploymentStatusValue = (typeof DEPLOYMENT_STATUSES)[number];

export interface DeploymentListQuery {
  page: number;
  pageSize: number;
  status: DeploymentStatusValue | null;
  softwareId: string | null;
  /** Parte do nome da máquina (sem diferenciar maiúsculas). */
  machine: string | null;
  /** Criada a partir de (inclusive). */
  from: Date | null;
  /** Criada antes de (exclusive). */
  to: Date | null;
}

/**
 * Filtros e paginação da lista. Parâmetro ausente ou vazio = sem filtro; valor
 * inválido = 400 com o campo (um filtro ignorado em silêncio mostraria uma lista que
 * parece filtrada e não está). As datas vêm como instante ISO 8601: o frontend converte
 * o dia escolhido no fuso de quem usa, e o backend não precisa adivinhar fuso.
 */
export function parseDeploymentListQuery(query: Record<string, unknown>): DeploymentListQuery {
  const text = (field: string): string | null => {
    const raw = query[field];
    if (raw === undefined) return null;
    if (typeof raw !== 'string') throw invalid(field, `Informe ${field} uma vez só.`);
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  };
  const positiveInt = (field: string, fallback: number, max: number, label: string): number => {
    const raw = text(field);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw invalid(field, `${label} deve ser um número inteiro entre 1 e ${max}.`);
    }
    return value;
  };
  const instant = (field: string, label: string): Date | null => {
    const raw = text(field);
    if (raw === null) return null;
    const date = new Date(raw);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || Number.isNaN(date.getTime())) {
      throw invalid(field, `${label} inválida.`);
    }
    return date;
  };

  const status = text('status');
  if (status !== null && !DEPLOYMENT_STATUSES.includes(status as DeploymentStatusValue)) {
    throw invalid('status', 'Status inválido.');
  }
  const softwareId = text('softwareId');
  if (softwareId !== null && !UUID.test(softwareId)) throw invalid('softwareId', 'Software inválido.');
  const machine = text('machine');
  if (machine !== null && (machine.length > MAX_MACHINE_FILTER_LENGTH || CONTROL_CHARS.test(machine))) {
    throw invalid('machine', `O nome da máquina deve ter no máximo ${MAX_MACHINE_FILTER_LENGTH} caracteres.`);
  }
  const from = instant('from', 'Data inicial');
  const to = instant('to', 'Data final');
  if (from && to && from >= to) throw invalid('to', 'A data final deve ser depois da inicial.');

  return {
    page: positiveInt('page', 1, 100_000, 'A página'),
    pageSize: positiveInt('pageSize', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, 'O tamanho da página'),
    status: status as DeploymentStatusValue | null,
    softwareId: softwareId?.toLowerCase() ?? null,
    machine,
    from,
    to,
  };
}
