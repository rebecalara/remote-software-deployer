import { LdapService, LdapAuthenticationError, LdapConnectionError } from './ldap.service';

import { EventEmitter } from 'events';

jest.mock('ldapjs');
import * as ldap from 'ldapjs';

describe('LdapService', () => {
  const ORIGINAL_ENV = process.env;
  let service: LdapService;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...ORIGINAL_ENV, LDAP_URL: 'ldap://fake:389' };
    service = new LdapService();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('buildBindDn', () => {
    it('monta UPN a partir do template do AD real', () => {
      process.env.LDAP_BIND_DN_TEMPLATE = '{{username}}@prefeitura.exemplo';
      expect(service.buildBindDn('lrebeca')).toBe('lrebeca@prefeitura.exemplo');
    });

    it('monta DN completo a partir do template do OpenLDAP local', () => {
      process.env.LDAP_BIND_DN_TEMPLATE =
        'uid={{username}},ou=people,dc=rsd,dc=local';
      expect(service.buildBindDn('lrebeca')).toBe(
        'uid=lrebeca,ou=people,dc=rsd,dc=local',
      );
    });

    it('lança erro se LDAP_BIND_DN_TEMPLATE não estiver configurado', () => {
      delete process.env.LDAP_BIND_DN_TEMPLATE;
      expect(() => service.buildBindDn('lrebeca')).toThrow(
        'LDAP_BIND_DN_TEMPLATE não configurado',
      );
    });
  });

  describe('bind', () => {
    function mockClient() {
      const fakeClient = {
        on: jest.fn(),
        bind: jest.fn(),
        unbind: jest.fn(),
      };
      (ldap.createClient as jest.Mock).mockReturnValue(fakeClient);
      return fakeClient;
    }

    beforeEach(() => {
      process.env.LDAP_BIND_DN_TEMPLATE = '{{username}}@prefeitura.exemplo';
    });

    it('resolve quando o bind é bem-sucedido', async () => {
      const client = mockClient();
      client.bind.mockImplementation((_dn, _pw, cb) => cb(undefined));

      await expect(service.bind('lrebeca', 'senha-correta')).resolves.toBeUndefined();
      expect(client.unbind).toHaveBeenCalled();
    });

    it('rejeita com LdapAuthenticationError em credencial inválida', async () => {
      const client = mockClient();
      const err = new Error('invalid credentials');
      err.name = 'InvalidCredentialsError';
      client.bind.mockImplementation((_dn, _pw, cb) => cb(err));

      await expect(service.bind('lrebeca', 'senha-errada')).rejects.toThrow(
        LdapAuthenticationError,
      );
      expect(client.unbind).toHaveBeenCalled();
    });

    it('rejeita com LdapConnectionError quando o servidor está inacessível', async () => {
      const client = mockClient();
      const err = new Error('connect ECONNREFUSED');
      err.name = 'ConnectionError';
      client.bind.mockImplementation((_dn, _pw, cb) => cb(err));

      await expect(service.bind('lrebeca', 'qualquer')).rejects.toThrow(
        LdapConnectionError,
      );
      expect(client.unbind).toHaveBeenCalled();
    });

    it('lança erro se LDAP_URL não estiver configurado', async () => {
      delete process.env.LDAP_URL;
      await expect(service.bind('lrebeca', 'senha')).rejects.toThrow(
        'LDAP_URL não configurado',
      );
    });
  });

  describe('searchComputers', () => {
    // Simula o objeto `res` do ldapjs: emite as entradas e depois 'end'.
    function mockSearchClient(
      entries: { objectName: string; attributes: { type: string; values: string[] }[] }[],
      endStatus = 0,
    ) {
      const fakeClient = {
        on: jest.fn(),
        bind: jest.fn((_dn, _pw, cb) => cb(undefined)),
        unbind: jest.fn(),
        search: jest.fn((_base, _opts, cb) => {
          const res = new EventEmitter();
          cb(undefined, res);
          for (const pojo of entries) res.emit('searchEntry', { pojo });
          res.emit('end', { status: endStatus });
        }),
      };
      (ldap.createClient as jest.Mock).mockReturnValue(fakeClient);
      return fakeClient;
    }

    beforeEach(() => {
      process.env.LDAP_SEARCH_BIND_DN = 'cn=svc-leitura,ou=servicos,dc=exemplo,dc=local';
      process.env.LDAP_SEARCH_BIND_PASSWORD = 'senha-da-conta-de-servico';
      process.env.LDAP_COMPUTER_BASE_DN = 'ou=computadores,dc=exemplo,dc=local';
      delete process.env.LDAP_COMPUTER_FILTER;
    });

    it('faz bind com a conta de serviço, não com o template de usuário', async () => {
      process.env.LDAP_BIND_DN_TEMPLATE = '{{username}}@prefeitura.exemplo';
      const client = mockSearchClient([]);

      await service.searchComputers();

      expect(client.bind).toHaveBeenCalledWith(
        'cn=svc-leitura,ou=servicos,dc=exemplo,dc=local',
        'senha-da-conta-de-servico',
        expect.any(Function),
      );
    });

    it('busca paginada na base configurada, com filtro padrão do AD', async () => {
      const client = mockSearchClient([]);

      await service.searchComputers();

      expect(client.search).toHaveBeenCalledWith(
        'ou=computadores,dc=exemplo,dc=local',
        expect.objectContaining({
          scope: 'sub',
          filter: '(objectClass=computer)',
          paged: { pageSize: 500 },
        }),
        expect.any(Function),
      );
    });

    it('usa LDAP_COMPUTER_FILTER quando configurado (ex.: OpenLDAP local)', async () => {
      process.env.LDAP_COMPUTER_FILTER = '(objectClass=device)';
      const client = mockSearchClient([]);

      await service.searchComputers();

      expect(client.search.mock.calls[0][1].filter).toBe('(objectClass=device)');
    });

    it('converte entradas do formato pojo do ldapjs v3, com atributos em minúsculas', async () => {
      mockSearchClient([
        {
          objectName: 'CN=WS-TESTE-001,OU=SETOR-A,DC=exemplo,DC=local',
          attributes: [
            { type: 'cn', values: ['WS-TESTE-001'] },
            { type: 'dNSHostName', values: ['ws-teste-001.exemplo.local'] },
            { type: 'operatingSystem', values: ['Windows 11 Pro'] },
          ],
        },
        {
          objectName: 'CN=WS-TESTE-002,OU=SETOR-B,DC=exemplo,DC=local',
          attributes: [{ type: 'cn', values: ['WS-TESTE-002'] }],
        },
      ]);

      const result = await service.searchComputers();

      expect(result).toEqual([
        {
          dn: 'CN=WS-TESTE-001,OU=SETOR-A,DC=exemplo,DC=local',
          attributes: {
            cn: ['WS-TESTE-001'],
            dnshostname: ['ws-teste-001.exemplo.local'],
            operatingsystem: ['Windows 11 Pro'],
          },
        },
        {
          dn: 'CN=WS-TESTE-002,OU=SETOR-B,DC=exemplo,DC=local',
          attributes: { cn: ['WS-TESTE-002'] },
        },
      ]);
    });

    it('rejeita com LdapAuthenticationError se a conta de serviço for recusada', async () => {
      const client = mockSearchClient([]);
      const err = new Error('invalid credentials');
      err.name = 'InvalidCredentialsError';
      client.bind.mockImplementation((_dn, _pw, cb) => cb(err));

      await expect(service.searchComputers()).rejects.toThrow(LdapAuthenticationError);
      expect(client.search).not.toHaveBeenCalled();
      expect(client.unbind).toHaveBeenCalled();
    });

    it('rejeita com LdapConnectionError quando a busca falha (ex.: base DN inexistente)', async () => {
      const client = mockSearchClient([]);
      client.search.mockImplementation((_base, _opts, cb) => {
        const res = new EventEmitter();
        cb(undefined, res);
        res.emit('error', new Error('No Such Object'));
      });

      await expect(service.searchComputers()).rejects.toThrow(LdapConnectionError);
      expect(client.unbind).toHaveBeenCalled();
    });

    it('rejeita quando a busca termina com status diferente de sucesso', async () => {
      mockSearchClient([], 4);
      await expect(service.searchComputers()).rejects.toThrow(LdapConnectionError);
    });

    it.each(['LDAP_SEARCH_BIND_DN', 'LDAP_SEARCH_BIND_PASSWORD', 'LDAP_COMPUTER_BASE_DN'])(
      'lança erro se %s não estiver configurado',
      async (name) => {
        mockSearchClient([]);
        delete process.env[name];
        await expect(service.searchComputers()).rejects.toThrow(`${name} não configurado`);
      },
    );
  });
});
