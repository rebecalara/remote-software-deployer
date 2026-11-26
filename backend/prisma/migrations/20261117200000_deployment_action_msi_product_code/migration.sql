-- CreateEnum
CREATE TYPE "DeploymentAction" AS ENUM ('INSTALL', 'UNINSTALL');

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "action" "DeploymentAction" NOT NULL DEFAULT 'INSTALL';

-- AlterTable
ALTER TABLE "Software" ADD COLUMN     "msiProductCode" TEXT;

