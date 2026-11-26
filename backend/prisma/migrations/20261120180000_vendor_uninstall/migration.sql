-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "uninstallArch" TEXT,
ADD COLUMN     "uninstallCommand" TEXT,
ADD COLUMN     "uninstallKey" TEXT;


-- Acrescentado à mão: o CHECK passa a aceitar a desinstalação por comando do fabricante
-- (programa que não é MSI, exceção controlada — DECISIONS.md).
ALTER TABLE "Deployment" DROP CONSTRAINT "Deployment_software_or_product_check";
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_software_or_product_check" CHECK (
  "softwareId" IS NOT NULL OR ("action" = 'UNINSTALL' AND (
    "productCode" IS NOT NULL OR ("uninstallKey" IS NOT NULL AND "uninstallCommand" IS NOT NULL))));
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_uninstall_arch_check"
  CHECK ("uninstallArch" IS NULL OR "uninstallArch" IN ('64', '32'));
