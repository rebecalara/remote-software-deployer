import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { MachinesModule } from './machines/machines.module';

@Module({
  imports: [PrismaModule, AuthModule, MachinesModule],
  controllers: [AppController],
})
export class AppModule {}