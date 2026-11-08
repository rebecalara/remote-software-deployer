import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureRequestTimeout } from './http-server.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');
  const timeoutMs = configureRequestTimeout(app.getHttpServer(), logger);
  logger.log(`Tempo máximo por requisição HTTP: ${timeoutMs / 60_000} min.`);
  await app.listen(3000);
  console.log('Backend rodando em http://localhost:3000');
}
bootstrap();
