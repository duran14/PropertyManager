-- CreateTable rental_applications
CREATE TABLE "rental_applications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "showingId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "unitId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'invited',
    "annualIncome" INTEGER,
    "employerName" TEXT,
    "references" TEXT,
    "idDocumentStorageKey" TEXT,
    "applicantFullName" TEXT,
    "consentApplicationAt" TIMESTAMP(3),
    "consentCreditCheckAt" TIMESTAMP(3),
    "consentPoliceCheckAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rental_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rental_applications_showingId_key" ON "rental_applications"("showingId");

-- CreateIndex
CREATE UNIQUE INDEX "rental_applications_tokenHash_key" ON "rental_applications"("tokenHash");

-- CreateIndex
CREATE INDEX "rental_applications_tenantId_status_idx" ON "rental_applications"("tenantId", "status");

-- AlterTable users
ALTER TABLE "users" ADD COLUMN "notificationChannel" "ChatChannel", ADD COLUMN "notificationAddress" TEXT;

-- AddForeignKey
ALTER TABLE "rental_applications" ADD CONSTRAINT "rental_applications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_applications" ADD CONSTRAINT "rental_applications_showingId_fkey" FOREIGN KEY ("showingId") REFERENCES "showings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_applications" ADD CONSTRAINT "rental_applications_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_applications" ADD CONSTRAINT "rental_applications_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
