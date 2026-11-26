import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { getNewRelic, NewRelicApi } from './newrelic-loader';
import { Redactor } from './redact';

/**
 * Logger do backend: o console continua exatamente como o do Nest e, com o agente New Relic
 * ligado, cada linha também vai para o New Relic (logs in context) por recordLogEvent — já
 * mascarada (redact.ts). Sem o agente, é só o ConsoleLogger.
 *
 * O agente só encaminha sozinho winston/pino/bunyan; o Nest usa o próprio ConsoleLogger, por isso
 * o envio é explícito aqui.
 */

const LEVELS: Record<LogLevel, string> = {
  log: 'INFO',
  error: 'ERROR',
  warn: 'WARN',
  debug: 'DEBUG',
  verbose: 'TRACE',
  fatal: 'FATAL',
};

/**
 * Mensagem estruturada (usada pelos eventos de segurança): o texto vai em `message` e os demais
 * campos viram atributos do log no New Relic.
 */
export interface StructuredLogMessage {
  message: string;
  attributes: Record<string, unknown>;
}

function isStructured(message: unknown): message is StructuredLogMessage {
  return (
    !!message &&
    typeof message === 'object' &&
    typeof (message as StructuredLogMessage).message === 'string' &&
    !!(message as StructuredLogMessage).attributes &&
    typeof (message as StructuredLogMessage).attributes === 'object'
  );
}

export interface AppLoggerDeps {
  newRelic?: () => NewRelicApi | null;
  redactor?: Redactor;
}

export class AppLogger extends ConsoleLogger {
  private readonly newRelic: () => NewRelicApi | null;
  private readonly redactor: Redactor;

  constructor(deps: AppLoggerDeps = {}) {
    super();
    this.newRelic = deps.newRelic ?? getNewRelic;
    this.redactor = deps.redactor ?? Redactor.fromEnv();
  }

  protected printMessages(
    messages: unknown[],
    context = '',
    logLevel: LogLevel = 'log',
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
  ): void {
    // No console, a mensagem estruturada aparece como "texto {atributos}".
    const forConsole = messages.map((m) => (isStructured(m) ? `${m.message} ${JSON.stringify(m.attributes)}` : m));
    super.printMessages(forConsole, context, logLevel, writeStreamType, errorStack);
    const api = this.newRelic();
    if (!api) return;
    for (const message of messages) this.forward(api, message, context, logLevel, errorStack);
  }

  private forward(api: NewRelicApi, message: unknown, context: string, logLevel: LogLevel, errorStack: unknown): void {
    try {
      const event: Record<string, unknown> = {};
      if (isStructured(message)) {
        Object.assign(event, this.redactor.value(message.attributes) as Record<string, unknown>);
        event.message = this.redactor.text(message.message);
      } else {
        event.message = typeof message === 'string' ? this.redactor.text(message) : JSON.stringify(this.redactor.value(message));
      }
      event.level = LEVELS[logLevel] ?? 'UNKNOWN';
      if (context) event['log.context'] = context;
      if (typeof errorStack === 'string' && errorStack) event['error.stack'] = this.redactor.text(errorStack);
      api.recordLogEvent(event);
    } catch {
      // Uma falha ao enviar o log nunca derruba o backend; o console já recebeu a linha.
    }
  }
}
