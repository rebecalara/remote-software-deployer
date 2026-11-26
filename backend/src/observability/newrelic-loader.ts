/**
 * Decide se o agente New Relic é carregado e guarda a API dele para o resto do backend.
 *
 * Só carrega com NEW_RELIC_LICENSE_KEY preenchida (e NEW_RELIC_ENABLED diferente de "false"):
 * sem a chave — dev, CI, testes — o backend sobe normalmente, sem o agente, com um aviso.
 * Este módulo não importa nada do Nest nem do Express: ele roda ANTES deles (instrument.ts).
 */

/** O pedaço da API do agente que o backend usa. */
export interface NewRelicApi {
  recordLogEvent(event: Record<string, unknown>): void;
}

export interface NewRelicDecision {
  load: boolean;
  reason: string;
}

export const NEW_RELIC_APP_NAME = 'RSD (demo)';

export function decideNewRelic(env: NodeJS.ProcessEnv): NewRelicDecision {
  if ((env.NEW_RELIC_ENABLED ?? '').trim().toLowerCase() === 'false') {
    return { load: false, reason: 'New Relic desligado: NEW_RELIC_ENABLED=false.' };
  }
  if (!(env.NEW_RELIC_LICENSE_KEY ?? '').trim()) {
    return { load: false, reason: 'New Relic desligado: NEW_RELIC_LICENSE_KEY ausente.' };
  }
  return { load: true, reason: `New Relic ligado (app "${NEW_RELIC_APP_NAME}").` };
}

let api: NewRelicApi | null = null;

/** A API do agente, ou null se ele não foi carregado. */
export function getNewRelic(): NewRelicApi | null {
  return api;
}

export interface StartNewRelicDeps {
  env?: NodeJS.ProcessEnv;
  load?: (id: string) => unknown;
  log?: (level: 'log' | 'warn', message: string) => void;
}

/** Carrega o agente se a decisão mandar. Nunca lança: uma falha do agente não derruba o backend. */
export function startNewRelic(deps: StartNewRelicDeps = {}): NewRelicApi | null {
  const env = deps.env ?? process.env;
  const load = deps.load ?? ((id: string) => require(id) as unknown);
  const log = deps.log ?? nestLog;
  const decision = decideNewRelic(env);
  if (!decision.load) {
    api = null;
    log('warn', decision.reason);
    return null;
  }
  try {
    const loaded = load('newrelic') as Partial<NewRelicApi> | null;
    api = loaded && typeof loaded.recordLogEvent === 'function' ? (loaded as NewRelicApi) : null;
    log(api ? 'log' : 'warn', api ? decision.reason : 'New Relic desligado: o agente carregou sem a API esperada.');
  } catch (err) {
    api = null;
    log('warn', `New Relic desligado: o agente não carregou (${err instanceof Error ? err.message : String(err)}).`);
  }
  return api;
}

// O Logger do Nest é carregado só aqui, DEPOIS do agente (que precisa vir antes dos módulos que
// instrumenta).
function nestLog(level: 'log' | 'warn', message: string): void {
  const { Logger } = require('@nestjs/common') as typeof import('@nestjs/common');
  new Logger('NewRelic')[level](message);
}
