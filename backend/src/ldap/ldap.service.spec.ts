import { LdapService, LdapAuthenticationError, LdapConnectionError } from './ldap.service';

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
});
