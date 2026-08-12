-- AlterTable
ALTER TABLE "chat_conversations" ADD COLUMN     "handoffNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "handoffPreState" TEXT,
ADD COLUMN     "handoffReason" TEXT;
