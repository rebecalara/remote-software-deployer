/**
 * Mascaramento de segredos no que vai para o New Relic (logs e atributos). Duas camadas:
 *  1. valores exatos dos segredos do ambiente (JWT_SECRET, senhas, chave do New Relic, senha do
 *     DATABASE_URL), lidos uma vez na subida;
 *  2. padrões: URL de banco com senha, "Bearer ...", JWT, license_key= em URL e campos
 *     password/senha/token/secret.
 * Nada daqui é logado nem devolvido sem mascarar.
 */

export const REDACTED = '[REDACTED]';

/** Variáveis do .env que são segredo (o DATABASE_URL entra só pela senha dele). */
export const SECRET_ENV_KEYS = ['JWT_SECRET', 'LDAP_SEARCH_BIND_PASSWORD', 'WINRM_PASSWORD', 'NEW_RELIC_LICENSE_KEY'] as const;

// Valor muito curto não é mascarado: trocaria letras comuns em qualquer mensagem.
const MIN_SECRET_LENGTH = 4;

const SECRET_FIELD = /^(password|senha|token|secret|authorization|cookie)$/i;

const PATTERNS: [RegExp, string][] = [
  [/(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s]+@/gi, `$1${REDACTED}@`],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  [/(license_key=)[^&\s"'#]+/gi, `$1${REDACTED}`],
  [/\b((?:password|senha|token|secret)["']?\s*[:=]\s*["']?)[^"'\s,&;}]+/gi, `$1${REDACTED}`],
];

/** Os valores secretos do ambiente (e a senha do DATABASE_URL, crua e decodificada). */
export function secretValuesFromEnv(env: NodeJS.ProcessEnv): string[] {
  const values = SECRET_ENV_KEYS.map((k) => (env[k] ?? '').trim());
  const db = /^postgres(?:ql)?:\/\/[^:/@]+:([^@]+)@/i.exec((env.DATABASE_URL ?? '').trim());
  if (db) {
    values.push(db[1]);
    try {
      values.push(decodeURIComponent(db[1]));
    } catch {
      // senha com % inválido: fica só a forma crua
    }
  }
  return [...new Set(values.filter((v) => v.length >= MIN_SECRET_LENGTH))].sort((a, b) => b.length - a.length);
}

export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: string[]) {
    this.secrets = [...new Set(secrets.filter((s) => s && s.length >= MIN_SECRET_LENGTH))].sort((a, b) => b.length - a.length);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Redactor {
    return new Redactor(secretValuesFromEnv(env));
  }

  text(input: string): string {
    let out = input;
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED);
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
  }

  /** Mascara strings em qualquer profundidade; campos com nome de segredo viram [REDACTED]. */
  value(input: unknown, depth = 0): unknown {
    if (typeof input === 'string') return this.text(input);
    if (input === null || typeof input !== 'object' || depth > 8) return input;
    if (input instanceof Error) return this.text(`${input.name}: ${input.message}`);
    if (Array.isArray(input)) return input.map((v) => this.value(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SECRET_FIELD.test(k) ? REDACTED : this.value(v, depth + 1);
    }
    return out;
  }
}
