// PRIMEIRO: .env e, se houver chave, o agente New Relic (antes do Nest, do Express e do Prisma).
import './observability/instrument';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureRequestTimeout } from './http-server.config';
import { AppLogger } from './observability/app-logger';
import { formatListenAddress, loadListenAddress } from './listen-address.config';

async function bootstrap() {
  // Console igual ao do Nest; com o New Relic ligado, cada linha também vai para lá (mascarada).
  const app = await NestFactory.create(AppModule, { logger: new AppLogger() });
  const logger = new Logger('Bootstrap');
  const timeoutMs = configureRequestTimeout(app.getHttpServer(), logger);
  logger.log(`Tempo máximo por requisição HTTP: ${timeoutMs / 60_000} min.`);
  const { host, port } = loadListenAddress(process.env, logger);
  await app.listen(port, host);
  logger.log(`Backend escutando em ${formatListenAddress(app.getHttpServer().address())}`);
}
// Falha na subida (ex.: banco fora do ar, segredo do JWT fraco): registra o motivo e encerra
// com código 1, em vez de deixar uma promessa rejeitada sem tratamento.
bootstrap().catch((err: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error(`O backend não subiu: ${err instanceof Error ? err.message : String(err)}`, err instanceof Error ? err.stack : undefined);
  process.exit(1);
});
