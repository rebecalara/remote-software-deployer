// Regras de segurança do LDAP, em funções puras (testáveis sem servidor).

/** Parte "usuário": letras sem acento, dígitos, ponto, sublinhado e hífen; até 64. */
const USER_PART = '[A-Za-z0-9._-]{1,64}';
const PLAIN_USERNAME = new RegExp(`^${USER_PART}$`);
/** UPN digitado inteiro: usuario@dominio.tld (um "@" só, domínio com ao menos um ponto). */
const TYPED_UPN = new RegExp(`^${USER_PART}@[A-Za-z0-9-]{1,63}(\\.[A-Za-z0-9-]{1,63})+$`);

/**
 * O nome vai para dentro do DN/UPN do bind (template LDAP_BIND_DN_TEMPLATE). Fora da regra,
 * nada é enviado ao LDAP: "," "=" "*" "(" ")" "\" e espaços mudariam o DN ou abririam caminho
 * para injeção. "@" só quando o template é exatamente "{{username}}" — a pessoa digita o UPN
 * inteiro; com o domínio já no template ("{{username}}@dominio") ele viraria "x@dominio@dominio".
 */
export function isAllowedLdapUsername(username: string, template: string): boolean {
  if (PLAIN_USERNAME.test(username)) return true;
  return template.trim() === '{{username}}' && TYPED_UPN.test(username);
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Aviso para a subida: ldap:// para outra máquina manda as senhas do login sem criptografia.
 * O OpenLDAP local (127.0.0.1/localhost) não avisa. null = nada a avisar.
 */
export function ldapUrlWarning(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `LDAP_URL inválido ("${url}"): use ldaps://servidor:636.`;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'ldaps:') return null;
  if (protocol !== 'ldap:') return `LDAP_URL com protocolo desconhecido ("${parsed.protocol}"): use ldaps://servidor:636.`;
  if (LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return (
    `LDAP_URL usa ldap:// para ${parsed.hostname}: as senhas trafegam sem criptografia; use ldaps:// ` +
    `(porta 636), com a CA interna em NODE_EXTRA_CA_CERTS.`
  );
}
