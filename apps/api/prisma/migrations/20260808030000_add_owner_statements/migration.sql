-- DropIndex
DROP INDEX "chat_messages_deliveryStatus_deliveryNextAttemptAt_idx";

-- AlterTable
ALTER TABLE "bills" ADD COLUMN     "propertyId" TEXT;

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "managementFeePercentBps" INTEGER NOT NULL DEFAULT 1250,
ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "reserveFundTargetCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "webhook_receipts" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "owner_statements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "rentIncomeCents" INTEGER NOT NULL,
    "expensesCents" INTEGER NOT NULL,
    "managementFeeCents" INTEGER NOT NULL,
    "reserveWithheldCents" INTEGER NOT NULL,
    "ownerPayoutCents" INTEGER NOT NULL,
    "shortfallCents" INTEGER NOT NULL,
    "appliedFeePercentBps" INTEGER NOT NULL,
    "reserveTargetCents" INTEGER NOT NULL,
    "closedByUserId" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_statements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "owner_statements_tenantId_periodStart_idx" ON "owner_statements"("tenantId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "owner_statements_propertyId_periodStart_key" ON "owner_statements"("propertyId", "periodStart");

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "owners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "owners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
