-- Keep the earliest active showing for a prospect and time; cancel later conflicts.
WITH ranked_showings AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "tenantId", "leadId", "scheduledAt"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS row_number
  FROM "showings"
  WHERE "status" IN ('scheduled', 'confirmed')
)
UPDATE "showings"
SET "status" = 'cancelled'
WHERE "id" IN (
  SELECT "id" FROM ranked_showings WHERE row_number > 1
);

ALTER TABLE "showings" ADD COLUMN "activeSlotKey" TEXT;

UPDATE "showings"
SET "activeSlotKey" = "leadId" || ':' ||
  to_char("scheduledAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') || 'T' ||
  to_char("scheduledAt" AT TIME ZONE 'UTC', 'HH24:MI:SS.MS') || 'Z'
WHERE "status" IN ('scheduled', 'confirmed');

CREATE UNIQUE INDEX "showings_tenantId_activeSlotKey_key"
  ON "showings"("tenantId", "activeSlotKey");
