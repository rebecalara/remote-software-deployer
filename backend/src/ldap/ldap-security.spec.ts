import { Logger } from '@nestjs/common';
import { isAllowedLdapUsername, ldapUrlWarning } from './ldap-security';
import { LdapAuthenticationError, LdapService } from './ldap.service';

jest.mock('ldapjs');
import * as ldap from 'ldapjs';

// Bind LDAP: só caracteres seguros no nome (nada de , = * ( ) \ que mudariam o DN ou o
// filtro); e aviso claro quando as senhas iriam sem criptografia (ldap:// para fora da máquina).

const DN_TEMPLATE = 'uid={{username}},ou=people,dc=rsd,dc=local';
const UPN_SUFFIX_TEMPLATE = '{{username}}@prefeitura.exemplo';
const UPN_TYPED_TEMPLATE = '{{username}}';

describe('isAllowedLdapUsername', () => {
  it.each(['lrebeca', 'rebeca.lara', 'rebeca_lara', 'r-lara', 'Rebeca', 'user01', 'a'])('aceita %p', (u) => {
    expect(isAllowedLdapUsername(u, DN_TEMPLATE)).toBe(true);
    expect(isAllowedLdapUsername(u, UPN_SUFFIX_TEMPLATE)).toBe(true);
  });

  it.each([
    'rebeca,ou=admins',
    'admin)(uid=*',
    '*',
    'rebeca lara',
    'rebeca\\lara',
    'rebeca=x',
    'rebeca+x',
    'réb',
    'rebeca\n',
    '',
    'a'.repeat(65),
  ])('recusa %p', (u) => {
    expect(isAllowedLdapUsername(u, DN_TEMPLATE)).toBe(false);
  });

  it('"@" só quando a pessoa digita o UPN inteiro (template = {{username}})', () => {
    expect(isAllowedLdapUsername('rebeca@prefeitura.exemplo', UPN_TYPED_TEMPLATE)).toBe(true);
    // Com o domínio já no template, "@" geraria "x@dominio@dominio".
    expect(isAllowedLdapUsername('rebeca@prefeitura.exemplo', UPN_SUFFIX_TEMPLATE)).toBe(false);
    // Num DN, "@" não faz sentido.
    expect(isAllowedLdapUsername('rebeca@prefeitura.exemplo', DN_TEMPLATE)).toBe(false);
  });

  it.each(['rebeca@', '@prefeitura.exemplo', 'a@b@c.d', 'rebeca@dominio', 'rebeca@dom,inio.x'])(
    'UPN digitado malformado é recusado: %p',
    (u) => {
      expect(isAllowedLdapUsername(u, UPN_TYPED_TEMPLATE)).toBe(false);
    },
  );
});

describe('ldapUrlWarning', () => {
  it.each(['ldap://127.0.0.1:389', 'ldap://localhost:389', 'ldap://[::1]:389', 'ldaps://ad.prefeitura.exemplo:636', 'ldaps://10.0.0.5:636'])(
    'sem aviso: %p',
    (url) => {
      expect(ldapUrlWarning(url)).toBeNull();
    },
  );

  it.each(['ldap://ad.prefeitura.exemplo:389', 'ldap://10.0.0.5', 'LDAP://ad.prefeitura.exemplo'])('ldap:// para fora da máquina: aviso (%p)', (url) => {
    expect(ldapUrlWarning(url)).toMatch(/senhas trafegam sem criptografia; use ldaps:\/\//);
  });

  it('endereço inválido ou protocolo desconhecido também avisa', () => {
    expect(ldapUrlWarning('servidor:389')).toMatch(/LDAP_URL/);
    expect(ldapUrlWarning('http://ad:389')).toMatch(/LDAP_URL/);
  });

  it('sem LDAP_URL, nada a avisar aqui (o erro aparece ao usar)', () => {
    expect(ldapUrlWarning(undefined)).toBeNull();
  });
});

describe('LdapService', () => {
  const ORIGINAL_ENV = process.env;
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  it('na subida, registra o aviso quando LDAP_URL é ldap:// para outra máquina', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env = { ...ORIGINAL_ENV, LDAP_URL: 'ldap://ad.prefeitura.exemplo:389' };
    new LdapService();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/senhas trafegam sem criptografia; use ldaps:\/\//));
  });

  it('sem aviso para ldaps:// nem para o OpenLDAP local', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env = { ...ORIGINAL_ENV, LDAP_URL: 'ldaps://ad.prefeitura.exemplo:636' };
    new LdapService();
    process.env = { ...ORIGINAL_ENV, LDAP_URL: 'ldap://127.0.0.1:389' };
    new LdapService();
    expect(warn).not.toHaveBeenCalled();
  });

  it('nome com caractere fora da regra: LdapAuthenticationError SEM abrir conexão com o LDAP', async () => {
    process.env = { ...ORIGINAL_ENV, LDAP_URL: 'ldap://127.0.0.1:389', LDAP_BIND_DN_TEMPLATE: DN_TEMPLATE };
    const service = new LdapService();
    await expect(service.bind('admin,ou=people', 'senha')).rejects.toThrow(LdapAuthenticationError);
    await expect(service.bind('*)(uid=*', 'senha')).rejects.toThrow(LdapAuthenticationError);
    expect(ldap.createClient).not.toHaveBeenCalled();
  });

  it('a conexão exige TLS 1.2 ou mais e nunca desliga a verificação do certificado', async () => {
    process.env = { ...ORIGINAL_ENV, LDAP_URL: 'ldaps://ad.prefeitura.exemplo:636', LDAP_BIND_DN_TEMPLATE: UPN_SUFFIX_TEMPLATE };
    const client = { on: jest.fn(), bind: jest.fn((_dn, _pw, cb) => cb(undefined)), unbind: jest.fn() };
    (ldap.createClient as jest.Mock).mockReturnValue(client);
    await new LdapService().bind('lrebeca', 'senha');
    const options = (ldap.createClient as jest.Mock).mock.calls[0][0];
    expect(options.url).toBe('ldaps://ad.prefeitura.exemplo:636');
    expect(options.tlsOptions).toMatchObject({ minVersion: 'TLSv1.2' });
    expect(options.tlsOptions.rejectUnauthorized).not.toBe(false);
  });
});
