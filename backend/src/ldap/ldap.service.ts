import { Injectable, Logger } from '@nestjs/common';
import * as ldap from 'ldapjs';

export class LdapAuthenticationError extends Error {}

export class LdapConnectionError extends Error {}

const CONNECT_TIMEOUT_MS = 5000;

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
    const url = process.env.LDAP_URL;
    if (!url) {
      throw new Error('LDAP_URL não configurado no ambiente.');
    }

    const client = ldap.createClient({
      url,
      connectTimeout: CONNECT_TIMEOUT_MS,
      timeout: CONNECT_TIMEOUT_MS,
    });

    try {
      await new Promise<void>((resolve, reject) => {
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
    } finally {
      client.unbind();
    }
  }
}
