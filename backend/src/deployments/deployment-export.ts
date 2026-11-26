import { DeploymentStatus } from '@prisma/client';
import { DeploymentDisplayStatus } from './deployment-outcome';

// Exportação do Histórico em CSV para o Excel em português: UTF-8 com BOM (senão o Excel lê
// os acentos como ANSI), separador ";" (a vírgula é o separador decimal), CRLF, datas
// "dd/mm/aaaa hh:mm" em America/Sao_Paulo. Funções puras: o service só junta os dados.

/** Linhas (máquinas) no máximo por arquivo; acima disso, 400. */
export const EXPORT_MAX_ROWS = 10_000;
export const EXPORT_TOO_MANY = 'Muitos resultados para exportar; refine os filtros.';
const TIME_ZONE = 'America/Sao_Paulo';
const BOM = '﻿';

export const EXPORT_COLUMNS = [
  'Software',
  'Versão',
  'Ação',
  'Fora do catálogo',
  'Status da implantação',
  'Máquina',
  'Resultado na máquina',
  'Código de saída',
  'Solicitada por',
  'Criada em',
  'Início',
  'Fim',
  'Duração',
] as const;

export type CsvValue = string | number | null;

/**
 * Uma célula. Texto que começa com = + - @ (ou tab / CR) ganha um apóstrofo na frente: o
 * Excel trataria como fórmula (nome de produto vem do inventário da máquina, que qualquer
 * instalador escreve). Número (código de saída) é gerado pelo sistema e fica como está. Aspas
 * quando há ";", aspas ou quebra de linha; aspas internas dobradas.
 */
export function csvCell(value: CsvValue): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  let text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[;"\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Cabeçalho + linhas, com BOM e CRLF (inclusive no fim). */
export function toCsv(rows: CsvValue[][]): string {
  const body = [EXPORT_COLUMNS as readonly string[], ...rows].map((row) => row.map(csvCell).join(';'));
  return `${BOM}${body.join('\r\n')}\r\n`;
}

const dateTimeParts = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function partsOf(date: Date): Record<string, string> {
  return Object.fromEntries(dateTimeParts.formatToParts(date).map((p) => [p.type, p.value]));
}

/** "19/11/2026 22:30" no horário de Brasília; vazio sem data. */
export function formatDateTimeSaoPaulo(date: Date | null): string {
  if (!date) return '';
  const p = partsOf(date);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** rsd-historico-AAAA-MM-DD.csv, com o dia de São Paulo. */
export function exportFileName(now: Date): string {
  const p = partsOf(now);
  return `rsd-historico-${p.year}-${p.month}-${p.day}.csv`;
}

/** "4 s", "1 min 5 s", "1 h 2 min" — o mesmo formato das telas. */
export function formatDurationText(start: Date | null, end: Date | null): string {
  if (!start || !end) return '';
  const total = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return s > 0 ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}

export const DEPLOYMENT_STATUS_LABEL: Record<DeploymentDisplayStatus, string> = {
  PENDING: 'Aguardando',
  RUNNING: 'Em andamento',
  SUCCEEDED: 'Concluído',
  PARTIAL: 'Parcial',
  FAILED: 'Falhou',
  CANCELLED: 'Cancelado',
};

/**
 * Resultado de uma máquina, com os mesmos rótulos finais da tela (frontend targetPhase.ts):
 * "Já estava instalado" / "Não estava instalado" vêm do último passo registrado.
 */
export function targetResultLabel(t: { status: DeploymentStatus | string; exitCode: number | null; lastMessage: string | null }): string {
  const message = t.lastMessage ?? '';
  switch (t.status) {
    case 'PENDING':
      return 'Aguardando';
    case 'RUNNING':
      return 'Em andamento';
    case 'SUCCEEDED':
      if (message.startsWith('Já instalado')) return 'Já estava instalado';
      if (message.startsWith('Não estava instalado')) return 'Não estava instalado';
      if (t.exitCode === 3010 || t.exitCode === 1641) return 'Concluído, reinício pendente';
      return 'Concluído';
    case 'FAILED':
      return 'Falhou';
    case 'CANCELLED':
      return 'Cancelado';
    default:
      return String(t.status);
  }
}
