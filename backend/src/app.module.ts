import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { MachinesModule } from './machines/machines.module';
import { SoftwareModule } from './software/software.module';
import { DeploymentsModule } from './deployments/deployments.module';

@Module({
  imports: [PrismaModule, AuthModule, MachinesModule, SoftwareModule, DeploymentsModule],
  controllers: [AppController],
})
export class AppModule {}