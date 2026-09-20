/*
  Warnings:

  - A unique constraint covering the columns `[deploymentId,machineId]` on the table `DeploymentTarget` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "DeploymentTarget_deploymentId_machineId_key" ON "DeploymentTarget"("deploymentId", "machineId");
