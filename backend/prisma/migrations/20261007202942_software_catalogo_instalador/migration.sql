-- AlterEnum
BEGIN;
CREATE TYPE "InstallType_new" AS ENUM ('MSI', 'EXE');
ALTER TABLE "Software" ALTER COLUMN "installType" TYPE "InstallType_new" USING ("installType"::text::"InstallType_new");
ALTER TYPE "InstallType" RENAME TO "InstallType_old";
ALTER TYPE "InstallType_new" RENAME TO "InstallType";
DROP TYPE "InstallType_old";
COMMIT;

-- AlterTable
ALTER TABLE "Software" DROP COLUMN "installerPath",
ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "installArgs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "installerFileName" TEXT,
ADD COLUMN     "installerOriginalName" TEXT,
ADD COLUMN     "installerSha256" TEXT,
ADD COLUMN     "installerSizeBytes" INTEGER,
ADD COLUMN     "installerUploadedAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "updatedById" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Software_installerFileName_key" ON "Software"("installerFileName");

-- CreateIndex
CREATE INDEX "Software_createdById_idx" ON "Software"("createdById");

-- CreateIndex
CREATE INDEX "Software_updatedById_idx" ON "Software"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "Software_name_version_key" ON "Software"("name", "version");

-- AddForeignKey
ALTER TABLE "Software" ADD CONSTRAINT "Software_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Software" ADD CONSTRAINT "Software_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

