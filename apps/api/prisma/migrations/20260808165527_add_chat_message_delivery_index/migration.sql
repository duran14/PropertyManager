-- CreateIndex
CREATE INDEX "chat_messages_deliveryStatus_deliveryNextAttemptAt_idx" ON "chat_messages"("deliveryStatus", "deliveryNextAttemptAt");
