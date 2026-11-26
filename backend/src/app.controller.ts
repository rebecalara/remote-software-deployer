import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  async check() {
    const machineCount = await this.prisma.machine.count();
    return { status: 'ok', machinesInDb: machineCount };
  }
}