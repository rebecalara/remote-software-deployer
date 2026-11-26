// Para onde ir depois do login. Só um caminho interno do próprio sistema é aceito: o
// endereço de volta não pode levar para fora (open redirect).

export const DEFAULT_AFTER_LOGIN = '/dashboard';

/**
 * Devolve `value` se for um caminho interno seguro; senão, o Dashboard. Seguro = texto que
 * começa com "/", sem "//" (seria endereço de outro site: "//site.com"), sem "\" (o
 * navegador trata "/\site.com" como "//site.com") e sem caracteres de controle. A própria
 * tela de login não serve de volta.
 */
export function safeRedirectPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return DEFAULT_AFTER_LOGIN;
  if (!value.startsWith('/')) return DEFAULT_AFTER_LOGIN;
  if (value.includes('//') || value.includes('\\')) return DEFAULT_AFTER_LOGIN;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return DEFAULT_AFTER_LOGIN;
  const path = value.split(/[?#]/)[0];
  if (path === '/login' || path.startsWith('/login/')) return DEFAULT_AFTER_LOGIN;
  return value;
}
