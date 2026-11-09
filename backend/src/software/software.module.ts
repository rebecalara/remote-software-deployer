import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InstallerStorageService } from './installer-storage.service';
import { SoftwareController } from './software.controller';
import { SoftwareService } from './software.service';

@Module({
  imports: [AuthModule],
  controllers: [SoftwareController],
  providers: [SoftwareService, InstallerStorageService],
})
export class SoftwareModule {}
