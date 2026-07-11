-- Add tenant onboarding profile and richer unit inventory fields.

CREATE TABLE "tenant_onboarding_profiles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "logoUrl" TEXT,
    "services" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "values" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "pricingNotes" TEXT,
    "showingPreferences" TEXT,
    "petPolicy" TEXT,
    "handoffName" TEXT,
    "handoffEmail" TEXT,
    "handoffPhone" TEXT,
    "aiTone" TEXT,
    "aiInstructions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_onboarding_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_onboarding_profiles_tenantId_key" ON "tenant_onboarding_profiles"("tenantId");

ALTER TABLE "tenant_onboarding_profiles"
ADD CONSTRAINT "tenant_onboarding_profiles_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "units"
ADD COLUMN "bedrooms" INTEGER,
ADD COLUMN "bathrooms" DOUBLE PRECISION,
ADD COLUMN "squareFeet" INTEGER,
ADD COLUMN "availableFrom" TIMESTAMP(3),
ADD COLUMN "amenities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "petPolicy" TEXT,
ADD COLUMN "parking" TEXT,
ADD COLUMN "utilities" TEXT;
