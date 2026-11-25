-- CreateIndex
CREATE INDEX "Deployment_createdAt_id_idx" ON "Deployment"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Deployment_finishedAt_idx" ON "Deployment"("finishedAt");

-- CreateIndex
CREATE INDEX "Deployment_action_idx" ON "Deployment"("action");

-- CreateIndex
CREATE INDEX "DeploymentTarget_status_idx" ON "DeploymentTarget"("status");
