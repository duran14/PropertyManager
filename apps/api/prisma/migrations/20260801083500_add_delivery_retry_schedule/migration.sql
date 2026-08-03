ALTER TABLE "chat_messages"
ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "deliveryNextAttemptAt" TIMESTAMP(3);

CREATE INDEX "chat_messages_deliveryStatus_deliveryNextAttemptAt_idx"
ON "chat_messages"("deliveryStatus", "deliveryNextAttemptAt");
