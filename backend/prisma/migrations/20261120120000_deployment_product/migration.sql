-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "productCode" TEXT,
ADD COLUMN     "productName" TEXT,
ADD COLUMN     "productPublisher" TEXT,
ADD COLUMN     "productVersion" TEXT,
ALTER COLUMN "softwareId" DROP NOT NULL;


-- Acrescentado à mão (o Prisma não gera CHECK): toda implantação tem um software do
-- catálogo OU é uma desinstalação com ProductCode.
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_software_or_product_check"
  CHECK ("softwareId" IS NOT NULL OR ("action" = 'UNINSTALL' AND "productCode" IS NOT NULL));

-- Acrescentado à mão: desinstalações já existentes ganham a cópia do produto.
UPDATE "Deployment" d
SET "productCode" = s."msiProductCode", "productName" = s."name",
    "productVersion" = s."version", "productPublisher" = s."vendor"
FROM "Software" s
WHERE d."softwareId" = s.id AND d."action" = 'UNINSTALL';
