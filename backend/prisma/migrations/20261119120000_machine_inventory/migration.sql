-- CreateTable
CREATE TABLE "MachineInventory" (
    "machineId" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "collectedById" TEXT NOT NULL,
    "items" JSONB NOT NULL,

    CONSTRAINT "MachineInventory_pkey" PRIMARY KEY ("machineId")
);

-- CreateIndex
CREATE INDEX "MachineInventory_collectedById_idx" ON "MachineInventory"("collectedById");

-- AddForeignKey
ALTER TABLE "MachineInventory" ADD CONSTRAINT "MachineInventory_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineInventory" ADD CONSTRAINT "MachineInventory_collectedById_fkey" FOREIGN KEY ("collectedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

