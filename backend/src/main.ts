import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureRequestTimeout } from './http-server.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true,
  });
  const logger = new Logger('Bootstrap');
  const timeoutMs = configureRequestTimeout(app.getHttpServer(), logger);
  logger.log(`Tempo máximo por requisição HTTP: ${timeoutMs / 60_000} min.`);
  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Backend rodando na porta ${port}`);
}
bootstrap();
