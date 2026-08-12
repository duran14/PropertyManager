/*
  Warnings:

  - You are about to drop the column `handoffPreState` on the `chat_conversations` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "chat_conversations" DROP COLUMN "handoffPreState",
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedByUserId" TEXT;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_claimedByUserId_fkey" FOREIGN KEY ("claimedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
