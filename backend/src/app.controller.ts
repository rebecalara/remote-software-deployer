import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Saúde do backend, usada pelo deploy (rollback automático) e pelo monitoramento. Pública: não
   * devolve nenhum dado do sistema, só o status. Por dentro, consulta o banco — sem banco, 503.
   */
  @Get('health')
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'error' });
    }
    return { status: 'ok' };
  }
}
