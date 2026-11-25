import { BadRequestException } from '@nestjs/common';

// Validação do corpo de POST /deployments (função pura, sem banco). O 400 leva o
// campo com problema (`field`), como no catálogo, para a tela apontar onde errou.

/** Máquinas por implantação: padrão de DEPLOYMENT_MAX_MACHINES. */
export const DEFAULT_MAX_MACHINES = 50;
/**
 * Teto de DEPLOYMENT_MAX_MACHINES. Acima disso, um pedido só vira uma fila longa demais para
 * acompanhar numa tela (e a lista do resumo do inventário cresce junto).
 */
export const MAX_MACHINES_CEILING = 500;
export const MAX_NAME_LENGTH = 120;

/**
 * DEPLOYMENT_MAX_MACHINES do .env: inteiro de 1 a 500, só dígitos. Ausente ou vazio → 50;
 * inválido → 50 com aviso; acima do teto → 500 com aviso (mesmo padrão das outras variáveis).
 */
export function parseMaxMachines(raw: string | undefined, warn?: (msg: string) => void): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_MACHINES;
  const text = raw.trim();
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    warn?.(`DEPLOYMENT_MAX_MACHINES inválido ("${raw}"); usando ${DEFAULT_MAX_MACHINES}.`);
    return DEFAULT_MAX_MACHINES;
  }
  if (value > MAX_MACHINES_CEILING) {
    warn?.(`DEPLOYMENT_MAX_MACHINES=${value} acima do teto; usando ${MAX_MACHINES_CEILING}.`);
    return MAX_MACHINES_CEILING;
  }
  return value;
}

export type DeploymentActionValue = 'INSTALL' | 'UNINSTALL';

export interface DeploymentCreateInput {
  /** Ausente = INSTALL. Desinstalar só existe para MSI (conferido no service). */
  action: DeploymentActionValue;
  /** Software do catálogo. Na desinstalação, exatamente um entre softwareId e productCode. */
  softwareId: string | null;
  /**
   * Só desinstalação: ProductCode de um MSI do inventário guardado das máquinas (pode não
   * estar no catálogo). O service confere que ele aparece no inventário de pelo menos uma
   * das máquinas e tira de lá o nome, a versão e o fabricante — nunca do navegador.
   */
  productCode: string | null;
  /**
   * Só desinstalação de programa que NÃO é MSI (comando do fabricante): o id calculado
   * pelo servidor no resumo do inventário. O comando nunca vem do navegador.
   */
  programId: string | null;
  /** Sem repetição, na ordem em que vieram. */
  machineIds: string[];
  /** null = o servidor gera ("7-Zip 26.06 — 5 máquinas"). */
  name: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ALLOWED_FIELDS = new Set(['action', 'softwareId', 'productCode', 'programId', 'machineIds', 'name']);
const PROGRAM_ID = /^[0-9a-f]{64}$/;
/** ProductCode do Windows Installer: GUID entre chaves. */
const PRODUCT_CODE = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i;
/** Filtro do Histórico: implantações de produtos fora do catálogo (softwareId nulo). */
export const OUTSIDE_CATALOG = 'none';

export function validateDeploymentCreate(body: unknown, maxMachines = DEFAULT_MAX_MACHINES): DeploymentCreateInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('body', 'O corpo da requisição deve ser um objeto JSON.');
  }
  const data = body as Record<string, unknown>;
  const unknown = Object.keys(data).find((key) => !ALLOWED_FIELDS.has(key));
  if (unknown) throw invalid(unknown, `Campo não permitido: ${unknown}.`);

  let action: DeploymentActionValue = 'INSTALL';
  if (data.action !== undefined) {
    if (data.action !== 'INSTALL' && data.action !== 'UNINSTALL') {
      throw invalid('action', 'Ação inválida: use INSTALL ou UNINSTALL.');
    }
    action = data.action;
  }

  let softwareId: string | null = null;
  let productCode: string | null = null;
  let programId: string | null = null;
  const present = (v: unknown) => v !== undefined && v !== null;
  if (present(data.programId)) {
    if (action !== 'UNINSTALL') throw invalid('programId', 'programId só vale para desinstalar.');
    if (typeof data.programId !== 'string' || !PROGRAM_ID.test(data.programId)) throw invalid('programId', 'Programa inválido.');
    if (present(data.softwareId) || present(data.productCode)) {
      throw invalid('programId', 'Informe só um: o software do catálogo, o ProductCode ou o programa.');
    }
    programId = data.programId;
  } else if (data.productCode !== undefined && data.productCode !== null) {
    if (action !== 'UNINSTALL') throw invalid('productCode', 'ProductCode só vale para desinstalar.');
    if (typeof data.productCode !== 'string' || !PRODUCT_CODE.test(data.productCode)) {
      throw invalid('productCode', 'ProductCode inválido.');
    }
    if (data.softwareId !== undefined && data.softwareId !== null) {
      throw invalid('productCode', 'Informe o software do catálogo ou o ProductCode, não os dois.');
    }
    productCode = data.productCode.toUpperCase();
  } else {
    if (typeof data.softwareId !== 'string' || !UUID.test(data.softwareId)) {
      throw invalid('softwareId', 'Selecione um software válido.');
    }
    softwareId = data.softwareId.toLowerCase();
  }

  if (!Array.isArray(data.machineIds) || data.machineIds.length === 0) {
    throw invalid('machineIds', 'Selecione ao menos uma máquina.');
  }
  if (data.machineIds.some((id) => typeof id !== 'string' || !UUID.test(id))) {
    throw invalid('machineIds', 'A lista de máquinas contém um identificador inválido.');
  }
  const machineIds = [...new Set((data.machineIds as string[]).map((id) => id.toLowerCase()))];
  if (machineIds.length > maxMachines) {
    throw invalid('machineIds', `Selecione no máximo ${maxMachines} máquinas por implantação.`);
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

  return { action, softwareId, productCode, programId, machineIds, name };
}

function invalid(field: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', message, field });
}

// ---------- GET /deployments (Histórico, Bloco 6) ----------

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const MAX_MACHINE_FILTER_LENGTH = 64;

// PARTIAL é calculado (FAILED com alguma máquina concluída), não existe no banco.
const DEPLOYMENT_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'PARTIAL'] as const;
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
  /**
   * Só as criadas pelo usuário logado. O id do usuário NUNCA vem da query: o
   * controller o tira do token e o passa ao service à parte.
   */
  mine: boolean;
  /** "active" = ainda não encerrada (finishedAt nulo); "finished" = encerrada. */
  state: 'active' | 'finished' | null;
  /** Encerrada a partir de (inclusive). Só faz sentido para as encerradas. */
  finishedFrom: Date | null;
  /** Instalação ou desinstalação. */
  action: DeploymentActionValue | null;
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
  if (softwareId !== null && softwareId !== OUTSIDE_CATALOG && !UUID.test(softwareId)) {
    throw invalid('softwareId', 'Software inválido.');
  }
  const machine = text('machine');
  if (machine !== null && (machine.length > MAX_MACHINE_FILTER_LENGTH || CONTROL_CHARS.test(machine))) {
    throw invalid('machine', `O nome da máquina deve ter no máximo ${MAX_MACHINE_FILTER_LENGTH} caracteres.`);
  }
  const from = instant('from', 'Data inicial');
  const to = instant('to', 'Data final');
  if (from && to && from >= to) throw invalid('to', 'A data final deve ser depois da inicial.');
  const state = text('state');
  if (state !== null && state !== 'active' && state !== 'finished') {
    throw invalid('state', 'Use state=active ou state=finished.');
  }
  const finishedFrom = instant('finishedFrom', 'Data de encerramento');
  if (finishedFrom && state === 'active') {
    throw invalid('finishedFrom', 'Implantações em andamento ainda não têm data de encerramento.');
  }
  const action = text('action');
  if (action !== null && action !== 'INSTALL' && action !== 'UNINSTALL') {
    throw invalid('action', 'Use action=INSTALL ou action=UNINSTALL.');
  }
  const mine = text('mine');
  if (mine !== null && mine !== 'true' && mine !== 'false') throw invalid('mine', 'Use mine=true ou mine=false.');

  return {
    page: positiveInt('page', 1, 100_000, 'A página'),
    pageSize: positiveInt('pageSize', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, 'O tamanho da página'),
    status: status as DeploymentStatusValue | null,
    softwareId: softwareId?.toLowerCase() ?? null,
    machine,
    from,
    to,
    mine: mine === 'true',
    state: state as 'active' | 'finished' | null,
    finishedFrom,
    action: action as DeploymentActionValue | null,
  };
}
