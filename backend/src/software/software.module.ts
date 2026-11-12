import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InstallerStorageService } from './installer-storage.service';
import { SoftwareController } from './software.controller';
import { SoftwareService } from './software.service';

@Module({
  imports: [AuthModule],
  controllers: [SoftwareController],
  providers: [SoftwareService, InstallerStorageService],
  // A implantação (Bloco 4) usa a MESMA instância: o armazenamento continua com um
  // único ponto de acesso a disco, e a limpeza da subida roda uma vez só.
  exports: [InstallerStorageService],
})
export class SoftwareModule {}
