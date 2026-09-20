/*
  Warnings:

  - The `status` column on the `Deployment` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `DeploymentTarget` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `Machine` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `level` on the `DeploymentLog` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `installType` on the `Software` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `role` on the `User` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "MachineStatus" AS ENUM ('ONLINE', 'OFFLINE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InstallType" AS ENUM ('MSI', 'EXE', 'SCRIPT');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- DropForeignKey
ALTER TABLE "DeploymentLog" DROP CONSTRAINT "DeploymentLog_deploymentTargetId_fkey";

-- DropForeignKey
ALTER TABLE "DeploymentTarget" DROP CONSTRAINT "DeploymentTarget_deploymentId_fkey";

-- AlterTable
ALTER TABLE "Deployment" DROP COLUMN "status",
ADD COLUMN     "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "DeploymentLog" DROP COLUMN "level",
ADD COLUMN     "level" "LogLevel" NOT NULL;

-- AlterTable
ALTER TABLE "DeploymentTarget" DROP COLUMN "status",
ADD COLUMN     "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "Machine" DROP COLUMN "status",
ADD COLUMN     "status" "MachineStatus" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "Software" DROP COLUMN "installType",
ADD COLUMN     "installType" "InstallType" NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "role" "UserRole" NOT NULL;

-- CreateIndex
CREATE INDEX "Deployment_userId_idx" ON "Deployment"("userId");

-- CreateIndex
CREATE INDEX "Deployment_softwareId_idx" ON "Deployment"("softwareId");

-- CreateIndex
CREATE INDEX "DeploymentLog_deploymentTargetId_timestamp_idx" ON "DeploymentLog"("deploymentTargetId", "timestamp");

-- CreateIndex
CREATE INDEX "DeploymentTarget_machineId_idx" ON "DeploymentTarget"("machineId");

-- AddForeignKey
ALTER TABLE "DeploymentTarget" ADD CONSTRAINT "DeploymentTarget_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_deploymentTargetId_fkey" FOREIGN KEY ("deploymentTargetId") REFERENCES "DeploymentTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
