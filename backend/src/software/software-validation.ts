import { InstallType } from '@prisma/client';

// Validação e normalização dos dados do catálogo de software (funções puras: sem
// banco, sem rota). O controller converte SoftwareValidationError em 400.
//
// IMPORTANTE sobre installArgs: esta validação é uma camada a mais, NÃO a proteção
// principal. A proteção principal é a regra registrada no DECISIONS.md para o
// Bloco 4: o comando-base é sempre do sistema (decidido pelo installType) e os
// tokens seguem SEMPRE como parâmetros de `Start-Process -FilePath … -ArgumentList …`
// — nunca em Invoke-Expression, cmd /c ou script montado como texto. Mesmo que um
// token malicioso passasse daqui, ele chegaria ao instalador como parâmetro, não
// seria interpretado como código. A lista de caracteres permitidos existe para
// recusar cedo o que não tem motivo legítimo para estar num argumento de instalador
// e para evitar armadilhas de parsing de linha de comando do Windows.

export class SoftwareValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'SoftwareValidationError';
  }
}

export interface SoftwareCreateInput {
  name: string;
  version: string;
  vendor: string | null;
  installType: InstallType;
  installArgs: string[];
}

export type SoftwareUpdateInput = Partial<SoftwareCreateInput>;

export const LIMITS = {
  name: 120,
  version: 50,
  vendor: 120,
  argCount: 32,
  argLength: 256,
} as const;

const INSTALL_TYPES: readonly InstallType[] = ['MSI', 'EXE'];
// Campos que o cliente pode enviar. Os demais (installerSha256, createdById, active…)
// são do servidor: chegar com eles é erro, não algo a ignorar em silêncio.
const ALLOWED_FIELDS = new Set(['name', 'version', 'vendor', 'installType', 'installArgs']);

// Fora de aspas: letras (inclusive acentuadas), dígitos e / - _ . : = \ , + @
const SAFE_OUTSIDE_QUOTES = /^[\p{L}\p{N}/\-_.:=\\,+@]$/u;
// Dentro de aspas, além disso: espaço e parênteses — para caminhos como
// "C:\Program Files (x86)\App".
const SAFE_INSIDE_QUOTES = /^[\p{L}\p{N}/\-_.:=\\,+@ ()]$/u;
// Propriedade pública do Windows Installer: NOME=valor.
const MSI_PROPERTY = /^[A-Za-z_][A-Za-z0-9_.]*=/;
// Caracteres de controle (quebra de linha, tab, NUL…), proibidos em qualquer texto.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Valida o corpo de POST /software. Todos os campos obrigatórios, exceto vendor e installArgs. */
export function validateSoftwareCreate(body: unknown): SoftwareCreateInput {
  const data = asObject(body);
  rejectUnknownFields(data);

  const installType = parseInstallType(data.installType);
  return {
    name: parseText(data.name, 'name', LIMITS.name, true) as string,
    version: parseText(data.version, 'version', LIMITS.version, true) as string,
    vendor: parseText(data.vendor, 'vendor', LIMITS.vendor, false),
    installType,
    installArgs: data.installArgs === undefined ? [] : validateInstallArgs(data.installArgs, installType),
  };
}

/**
 * Valida o corpo de PATCH /software/:id: só os campos enviados. Se installArgs vier
 * sem installType, quem chama precisa validar contra o tipo atual do registro
 * (validateInstallArgs com o installType salvo) — por isso installArgs não é
 * validado aqui nesse caso, apenas devolvido para essa segunda checagem.
 */
export function validateSoftwareUpdate(body: unknown): SoftwareUpdateInput {
  const data = asObject(body);
  rejectUnknownFields(data);
  if (Object.keys(data).length === 0) {
    throw new SoftwareValidationError('body', 'Nenhum campo para alterar.');
  }

  const result: SoftwareUpdateInput = {};
  if ('name' in data) result.name = parseText(data.name, 'name', LIMITS.name, true) as string;
  if ('version' in data) result.version = parseText(data.version, 'version', LIMITS.version, true) as string;
  if ('vendor' in data) result.vendor = parseText(data.vendor, 'vendor', LIMITS.vendor, false);
  if ('installType' in data) result.installType = parseInstallType(data.installType);
  if ('installArgs' in data) {
    result.installArgs = result.installType
      ? validateInstallArgs(data.installArgs, result.installType)
      : parseArgsShape(data.installArgs);
  }
  return result;
}

/**
 * Valida a lista de argumentos para o tipo de instalador.
 * - Cada token: só caracteres permitidos; espaço e parênteses apenas entre aspas
 *   duplas balanceadas; nada de `\"` (barra invertida antes de aspa).
 * - MSI: o comando-base `msiexec /i <arquivo> /qn /norestart` é fixo; os tokens só
 *   podem acrescentar propriedades `NOME=valor` — nunca outro switch (ex.: /x
 *   desinstalaria).
 */
export function validateInstallArgs(value: unknown, installType: InstallType): string[] {
  const args = parseArgsShape(value);
  args.forEach((token, index) => {
    const field = `installArgs[${index}]`;
    checkTokenCharacters(token, field);
    if (installType === 'MSI' && !MSI_PROPERTY.test(token)) {
      throw new SoftwareValidationError(
        field,
        `"${token}": em instaladores MSI só são aceitas propriedades no formato NOME=valor ` +
          '(o comando-base msiexec /i … /qn /norestart é fixo).',
      );
    }
  });
  return args;
}

/** Forma da lista (array de strings, limites), sem olhar o tipo de instalador. */
function parseArgsShape(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new SoftwareValidationError('installArgs', 'Os argumentos devem ser uma lista de textos.');
  }
  if (value.length > LIMITS.argCount) {
    throw new SoftwareValidationError('installArgs', `No máximo ${LIMITS.argCount} argumentos.`);
  }
  return value.map((item, index) => {
    const field = `installArgs[${index}]`;
    if (typeof item !== 'string') {
      throw new SoftwareValidationError(field, 'Cada argumento deve ser um texto.');
    }
    const token = item.trim();
    if (token === '') throw new SoftwareValidationError(field, 'Argumento vazio.');
    if (token.length > LIMITS.argLength) {
      throw new SoftwareValidationError(field, `Argumento com mais de ${LIMITS.argLength} caracteres.`);
    }
    return token;
  });
}

function checkTokenCharacters(token: string, field: string): void {
  let inQuotes = false;
  for (let i = 0; i < token.length; i++) {
    const char = token[i];
    if (char === '"') {
      // No parsing de linha de comando do Windows, \" vira aspa literal e desalinha
      // o resto dos argumentos (ex.: INSTALLDIR="C:\Pasta\" engole o próximo token).
      if (i > 0 && token[i - 1] === '\\') {
        throw new SoftwareValidationError(
          field,
          `"${token}": barra invertida imediatamente antes de aspa não é permitida ` +
            '(no Windows, \\" vira aspa literal). Remova a barra final do caminho.',
        );
      }
      inQuotes = !inQuotes;
      continue;
    }
    const allowed = inQuotes ? SAFE_INSIDE_QUOTES : SAFE_OUTSIDE_QUOTES;
    if (!allowed.test(char)) {
      const shown = CONTROL_CHARS.test(char) ? `código ${char.charCodeAt(0)}` : `"${char}"`;
      const hint = !inQuotes && (char === ' ' || char === '(' || char === ')')
        ? ' Espaço e parênteses só são aceitos dentro de aspas duplas.'
        : '';
      throw new SoftwareValidationError(field, `"${token}": caractere não permitido (${shown}).${hint}`);
    }
  }
  if (inQuotes) {
    throw new SoftwareValidationError(field, `"${token}": aspas duplas sem fechamento.`);
  }
}

function parseInstallType(value: unknown): InstallType {
  if (typeof value !== 'string') {
    throw new SoftwareValidationError('installType', 'Tipo de instalador obrigatório (MSI ou EXE).');
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === 'SCRIPT') {
    throw new SoftwareValidationError(
      'installType',
      'Instalação via script não é suportada: o sistema não executa scripts arbitrários.',
    );
  }
  if (!(INSTALL_TYPES as readonly string[]).includes(normalized)) {
    throw new SoftwareValidationError('installType', 'Tipo de instalador inválido: use MSI ou EXE.');
  }
  return normalized as InstallType;
}

/** trim + espaços internos colapsados; null para opcional vazio. */
function parseText(value: unknown, field: string, maxLength: number, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) throw new SoftwareValidationError(field, `Campo obrigatório: ${field}.`);
    return null;
  }
  if (typeof value !== 'string') {
    throw new SoftwareValidationError(field, `O campo ${field} deve ser um texto.`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw new SoftwareValidationError(field, `O campo ${field} contém caracteres de controle.`);
  }
  const text = value.trim().replace(/\s+/g, ' ');
  if (text === '') {
    if (required) throw new SoftwareValidationError(field, `Campo obrigatório: ${field}.`);
    return null;
  }
  if (text.length > maxLength) {
    throw new SoftwareValidationError(field, `O campo ${field} aceita no máximo ${maxLength} caracteres.`);
  }
  return text;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new SoftwareValidationError('body', 'Corpo da requisição inválido.');
  }
  return body as Record<string, unknown>;
}

function rejectUnknownFields(data: Record<string, unknown>): void {
  const unknown = Object.keys(data).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new SoftwareValidationError(unknown[0], `Campo não permitido: ${unknown.join(', ')}.`);
  }
}
