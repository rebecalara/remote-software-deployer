import { LdapEntry } from '../ldap/ldap.service';

/** Dados de Machine que vêm do diretório. Status e IP não vêm do AD. */
export interface MappedComputer {
  hostname: string;
  operatingSystem: string | null;
  department: string | null;
}

export interface ComputerMapperOptions {
  /**
   * Atributo de onde ler o SO. No AD é `operatingSystem`; o schema `device` do
   * OpenLDAP local não tem esse atributo, então lá se usa `description`.
   */
  osAttribute: string;
}

/**
 * Converte uma entrada LDAP (AD `computer` ou OpenLDAP `device`) em dados de
 * Machine. Retorna null quando não dá para identificar o hostname.
 */
export function mapComputerEntry(
  entry: LdapEntry,
  options: ComputerMapperOptions,
): MappedComputer | null {
  const hostname = normalizeHostname(first(entry, 'cn') ?? first(entry, 'dnshostname'));
  if (!hostname) {
    return null;
  }

  return {
    hostname,
    operatingSystem: first(entry, options.osAttribute.toLowerCase()) ?? null,
    department: extractFirstOu(entry.dn),
  };
}

/**
 * Hostname é @unique no banco: normaliza para maiúsculas e sem domínio, senão a
 * mesma máquina vira duas (o AD usa `WS-001` no cn e `ws-001.dominio` no dNSHostName).
 */
export function normalizeHostname(raw: string | undefined): string | null {
  const hostname = raw?.trim().split('.')[0].toUpperCase();
  return hostname ? hostname : null;
}

/**
 * Setor = primeira OU do DN (`CN=WS-001,OU=SAUDE,OU=Computadores,DC=...` → `SAUDE`).
 * Suposição sobre a organização das OUs na Prefeitura — validar no AD real.
 */
export function extractFirstOu(dn: string): string | null {
  for (const rdn of splitDn(dn)) {
    const [attr, ...rest] = rdn.split('=');
    if (attr.trim().toLowerCase() === 'ou' && rest.length > 0) {
      const value = unescapeDnValue(rest.join('=').trim());
      return value || null;
    }
  }
  return null;
}

function first(entry: LdapEntry, attribute: string): string | undefined {
  const value = entry.attributes[attribute]?.[0]?.trim();
  return value ? value : undefined;
}

// Separa o DN nas vírgulas, respeitando vírgulas escapadas (`OU=Obras\, Viação`).
function splitDn(dn: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < dn.length; i++) {
    const char = dn[i];
    if (char === '\\' && i + 1 < dn.length) {
      current += char + dn[i + 1];
      i++;
    } else if (char === ',') {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

// RFC 4514 aceita dois formatos de escape, e o ldapjs v3 usa o hexadecimal ao
// serializar o DN: `\,` e `\2c` são a mesma vírgula. Caracteres não-ASCII vêm
// como bytes UTF-8 em hex (`ç` = `\c3\a7`), então sequências hex viram bytes
// e são decodificadas juntas.
function unescapeDnValue(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const hex = value.slice(i + 1, i + 3);
    if (value[i] === '\\' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (value[i] === '\\' && i + 1 < value.length) {
      bytes.push(...Buffer.from(value[i + 1], 'utf8'));
      i += 1;
    } else {
      bytes.push(...Buffer.from(value[i], 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
