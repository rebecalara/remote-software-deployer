import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InstallerStorageService } from './installer-storage.service';
import { MsiInfoReader, loadMsiInfoReaderConfig } from './msi-info-reader';
import { SoftwareController } from './software.controller';
import { SoftwareService } from './software.service';

@Module({
  imports: [AuthModule],
  controllers: [SoftwareController],
  providers: [
    SoftwareService,
    InstallerStorageService,
    // Fora do Windows fica indisponível (o MSI só não ganha desinstalação).
    { provide: MsiInfoReader, useFactory: () => new MsiInfoReader(loadMsiInfoReaderConfig(process.env)) },
  ],
  // A implantação (Bloco 4) usa a MESMA instância: o armazenamento continua com um
  // único ponto de acesso a disco, e a limpeza da subida roda uma vez só. A
  // desinstalação pede ao SoftwareService o ProductCode de um MSI que ainda não o tem.
  exports: [InstallerStorageService, SoftwareService],
})
export class SoftwareModule {}
