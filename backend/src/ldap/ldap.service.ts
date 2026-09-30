import { Injectable, Logger } from '@nestjs/common';
import * as ldap from 'ldapjs';

export class LdapAuthenticationError extends Error {}

export class LdapConnectionError extends Error {}

const CONNECT_TIMEOUT_MS = 5000;

// O AD corta buscas não paginadas em 1000 resultados (MaxPageSize) sem dar erro.
const SEARCH_PAGE_SIZE = 500;

const DEFAULT_COMPUTER_FILTER = '(objectClass=computer)';

// Atributos do AD (computer) e do OpenLDAP local (device) — o mapper decide o que usar.
const COMPUTER_ATTRIBUTES = ['cn', 'dNSHostName', 'operatingSystem', 'description'];

/** Entrada de busca já normalizada: nomes de atributo sempre em minúsculas. */
export interface LdapEntry {
  dn: string;
  attributes: Record<string, string[]>;
}

@Injectable()
export class LdapService {
  private readonly logger = new Logger(LdapService.name);

  buildBindDn(username: string): string {
    const template = process.env.LDAP_BIND_DN_TEMPLATE;
    if (!template) {
      throw new Error('LDAP_BIND_DN_TEMPLATE não configurado no ambiente.');
    }
    return template.replace('{{username}}', username);
  }

  async bind(username: string, password: string): Promise<void> {
    const bindDn = this.buildBindDn(username);
    const client = this.createClient();

    try {
      await this.bindClient(client, bindDn, password);
    } finally {
      client.unbind();
    }
  }

  /**
   * Lista os computadores do domínio usando a conta de serviço de leitura
   * (LDAP_SEARCH_BIND_DN / LDAP_SEARCH_BIND_PASSWORD), com busca paginada.
   */
  async searchComputers(): Promise<LdapEntry[]> {
    const bindDn = requireEnv('LDAP_SEARCH_BIND_DN');
    const password = requireEnv('LDAP_SEARCH_BIND_PASSWORD');
    const baseDn = requireEnv('LDAP_COMPUTER_BASE_DN');
    const filter = process.env.LDAP_COMPUTER_FILTER || DEFAULT_COMPUTER_FILTER;

    const client = this.createClient();
    try {
      await this.bindClient(client, bindDn, password);
      const entries = await this.pagedSearch(client, baseDn, filter);
      this.logger.log(`Busca de computadores no LDAP retornou ${entries.length} entradas.`);
      return entries;
    } finally {
      client.unbind();
    }
  }

  private createClient(): ldap.Client {
    const url = process.env.LDAP_URL;
    if (!url) {
      throw new Error('LDAP_URL não configurado no ambiente.');
    }
    return ldap.createClient({
      url,
      connectTimeout: CONNECT_TIMEOUT_MS,
      timeout: CONNECT_TIMEOUT_MS,
    });
  }

  private bindClient(client: ldap.Client, bindDn: string, password: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      client.on('error', (err: Error) => {
        reject(new LdapConnectionError(err.message));
      });

      client.bind(bindDn, password, (err) => {
        if (!err) {
          resolve();
          return;
        }

        if (err.name === 'InvalidCredentialsError') {
          reject(new LdapAuthenticationError(err.message));
          return;
        }

        reject(new LdapConnectionError(err.message));
      });
    });
  }

  private pagedSearch(client: ldap.Client, baseDn: string, filter: string): Promise<LdapEntry[]> {
    return new Promise<LdapEntry[]>((resolve, reject) => {
      const options = {
        scope: 'sub',
        filter,
        attributes: COMPUTER_ATTRIBUTES,
        paged: { pageSize: SEARCH_PAGE_SIZE },
      };

      client.search(baseDn, options, (err, res) => {
        if (err) {
          reject(new LdapConnectionError(err.message));
          return;
        }

        const entries: LdapEntry[] = [];
        res.on('searchEntry', (entry) => entries.push(toLdapEntry(entry.pojo)));
        res.on('error', (searchErr: Error) => reject(new LdapConnectionError(searchErr.message)));
        // Com paginação automática, 'end' só dispara depois da última página.
        res.on('end', (result) => {
          if (result && result.status !== 0) {
            reject(new LdapConnectionError(`Busca LDAP terminou com status ${result.status}.`));
            return;
          }
          resolve(entries);
        });
      });
    });
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} não configurado no ambiente.`);
  }
  return value;
}

// ldapjs v3: o antigo `entry.object` não existe mais; os dados vêm em `entry.pojo`.
// O AD devolve nomes de atributo com capitalização variável (dNSHostName, dnshostname),
// então as chaves são normalizadas para minúsculas.
function toLdapEntry(pojo: {
  objectName: string;
  attributes: { type: string; values: unknown[] }[];
}): LdapEntry {
  const attributes: Record<string, string[]> = {};
  for (const { type, values } of pojo.attributes) {
    attributes[type.toLowerCase()] = values.map(String);
  }
  return { dn: pojo.objectName, attributes };
}
