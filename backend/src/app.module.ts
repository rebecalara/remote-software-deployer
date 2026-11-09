import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { MachinesModule } from './machines/machines.module';
import { SoftwareModule } from './software/software.module';

@Module({
  imports: [PrismaModule, AuthModule, MachinesModule, SoftwareModule],
  controllers: [AppController],
})
export class AppModule {}