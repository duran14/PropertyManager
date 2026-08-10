-- CreateEnum
CREATE TYPE "CalendarProvider" AS ENUM ('google');

-- CreateEnum
CREATE TYPE "CalendarConnectionStatus" AS ENUM ('active', 'revoked');

-- AlterTable
ALTER TABLE "showings" ADD COLUMN     "calendarSlotKey" TEXT,
ADD COLUMN     "googleCalendarId" TEXT,
ADD COLUMN     "googleEventId" TEXT;

-- CreateTable
CREATE TABLE "calendar_connections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" "CalendarProvider" NOT NULL DEFAULT 'google',
    "userId" TEXT,
    "ownerKey" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,
    "showingsCalendarId" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "accessTokenEnc" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "status" "CalendarConnectionStatus" NOT NULL DEFAULT 'active',
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduling_configs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "weeklyHours" JSONB NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'America/Vancouver',
    "showingDurationMinutes" INTEGER NOT NULL DEFAULT 30,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 30,
    "minNoticeHours" INTEGER NOT NULL DEFAULT 4,
    "maxAdvanceDays" INTEGER NOT NULL DEFAULT 14,
    "slotGranularityMinutes" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduling_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_connections_tenantId_status_idx" ON "calendar_connections"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_connections_tenantId_ownerKey_key" ON "calendar_connections"("tenantId", "ownerKey");

-- CreateIndex
CREATE UNIQUE INDEX "scheduling_configs_tenantId_key" ON "scheduling_configs"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "showings_tenantId_calendarSlotKey_key" ON "showings"("tenantId", "calendarSlotKey");

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduling_configs" ADD CONSTRAINT "scheduling_configs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
