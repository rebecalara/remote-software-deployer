'use strict';

/**
 * Configuração do agente New Relic (APM) do backend do RSD. NÃO tem segredo nenhum: a chave de
 * licença vem só de NEW_RELIC_LICENSE_KEY, no C:\rsd\config\backend.env da APP-RSD. Sem a chave,
 * o agente nem é carregado (src/observability/newrelic-loader.ts).
 *
 * O agente procura este arquivo na pasta de trabalho do processo (no serviço: current\backend).
 * Variáveis NEW_RELIC_* do ambiente têm precedência sobre os valores daqui.
 * Opções conferidas no schema do newrelic 14.12.0 (teste: newrelic-config.spec.ts).
 */
exports.config = {
  app_name: ['RSD (demo)'],

  // Log do próprio agente na saída padrão: vai para o log do WinSW em C:\rsd\logs (a conta do
  // serviço só lê a pasta de trabalho, onde ficaria o newrelic_agent.log padrão).
  logging: { level: 'info', filepath: 'stdout' },

  // Cabeçalhos: o padrão já só coleta accept, content-length, content-type, referer, user-agent e
  // host. A lista abaixo protege mesmo se alguém ligar allow_all_headers.
  allow_all_headers: false,
  attributes: {
    exclude: [
      'request.headers.authorization',
      'request.headers.cookie',
      'request.headers.proxyAuthorization',
      'request.headers.setCookie*',
      'response.headers.setCookie*',
      'request.parameters.*',
    ],
  },

  // O erro vai com o tipo e o stack; a mensagem vai pelo log (mascarado), ligada pelo trace.id.
  strip_exception_messages: { enabled: true },

  // Valores das consultas do Prisma ocultos; sem coleta de SQL lento.
  transaction_tracer: { record_sql: 'obfuscated' },
  slow_sql: { enabled: false },

  // Logs no New Relic (logs in context): o AppLogger envia cada linha por recordLogEvent.
  application_logging: {
    enabled: true,
    forwarding: { enabled: true },
    local_decorating: { enabled: false },
    metrics: { enabled: true },
  },

  // Sem o agente de segurança (IAST) e sem o audit log (só ligado por NEW_RELIC_AUDIT_LOG_ENABLED
  // durante a conferência do deploy\check-newrelic-secrets.ps1).
  security: { enabled: false, agent: { enabled: false } },
  audit_log: { enabled: false },

  // O modo alta segurança bloquearia os eventos personalizados; as proteções que valem aqui
  // estão explícitas acima.
  high_security: false,
};
