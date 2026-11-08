import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SoftwareController } from './software.controller';
import { SoftwareService } from './software.service';

// O InstallerStorageService entra aqui na etapa do envio do instalador.
@Module({
  imports: [AuthModule],
  controllers: [SoftwareController],
  providers: [SoftwareService],
})
export class SoftwareModule {}
