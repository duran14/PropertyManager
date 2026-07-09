/*
  Warnings:

  - You are about to drop the column `conversationId` on the `leads` table. All the data in the column will be lost.
  - Changed the type of `channel` on the `chat_conversations` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "ChatChannel" AS ENUM ('whatsapp', 'sms', 'telegram', 'web', 'email');

-- CreateEnum
CREATE TYPE "ShowingStatus" AS ENUM ('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "EnhancementType" AS ENUM ('none', 'enhance', 'object_removal', 'virtual_staging');

-- CreateEnum
CREATE TYPE "PhotoStatus" AS ENUM ('uploaded', 'processing', 'enhanced', 'failed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LeadSource" ADD VALUE 'telegram';
ALTER TYPE "LeadSource" ADD VALUE 'web';
ALTER TYPE "LeadSource" ADD VALUE 'email';

-- DropForeignKey
ALTER TABLE "leads" DROP CONSTRAINT "leads_conversationId_fkey";

-- DropIndex
DROP INDEX "leads_conversationId_key";

-- AlterTable
ALTER TABLE "chat_conversations" ADD COLUMN     "leadId" TEXT,
DROP COLUMN "channel",
ADD COLUMN     "channel" "ChatChannel" NOT NULL;

-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN     "mediaUrls" TEXT[];

-- AlterTable
ALTER TABLE "leads" DROP COLUMN "conversationId",
ADD COLUMN     "showmojoShowingId" TEXT,
ADD COLUMN     "tourUrl" TEXT;

-- AlterTable
ALTER TABLE "leases" ADD COLUMN     "docusignEnvelopeId" TEXT,
ADD COLUMN     "docusignStatus" TEXT;

-- CreateTable
CREATE TABLE "conversation_slots" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "showings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "unitId" TEXT,
    "showmojoId" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "brokerUserId" TEXT,
    "status" "ShowingStatus" NOT NULL DEFAULT 'scheduled',
    "showmojoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "showings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_photos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "originalUrl" TEXT NOT NULL,
    "enhancedUrl" TEXT,
    "enhancementType" "EnhancementType" NOT NULL DEFAULT 'none',
    "status" "PhotoStatus" NOT NULL DEFAULT 'uploaded',
    "autoenhanceOrderId" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_slots_conversationId_key_key" ON "conversation_slots"("conversationId", "key");

-- CreateIndex
CREATE INDEX "showings_tenantId_status_idx" ON "showings"("tenantId", "status");

-- CreateIndex
CREATE INDEX "showings_tenantId_scheduledAt_idx" ON "showings"("tenantId", "scheduledAt");

-- CreateIndex
CREATE INDEX "listing_photos_tenantId_unitId_idx" ON "listing_photos"("tenantId", "unitId");

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_slots" ADD CONSTRAINT "conversation_slots_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "showings" ADD CONSTRAINT "showings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "showings" ADD CONSTRAINT "showings_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "showings" ADD CONSTRAINT "showings_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_photos" ADD CONSTRAINT "listing_photos_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_photos" ADD CONSTRAINT "listing_photos_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
