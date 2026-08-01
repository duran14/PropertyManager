ALTER TABLE "chat_messages"
ADD COLUMN "deliveryStatus" TEXT NOT NULL DEFAULT 'sent',
ADD COLUMN "deliveryError" TEXT,
ADD COLUMN "providerMessageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
