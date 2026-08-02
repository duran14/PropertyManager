-- Prevent duplicate active showings for the same prospect even when they have separate lead records.
ALTER TABLE "showings" ADD COLUMN "activeProspectSlotKey" TEXT;

WITH ranked_showings AS (
  SELECT
    s."id",
    ROW_NUMBER() OVER (
      PARTITION BY
        s."tenantId",
        COALESCE(
          NULLIF('email:' || LOWER(l."email"), 'email:'),
          NULLIF('phone:' || REGEXP_REPLACE(l."phone", '[^0-9]', '', 'g'), 'phone:'),
          'lead:' || s."leadId"
        ),
        s."scheduledAt"
      ORDER BY s."createdAt" ASC, s."id" ASC
    ) AS row_number
  FROM "showings" s
  JOIN "leads" l ON l."id" = s."leadId"
  WHERE s."status" IN ('scheduled', 'confirmed')
)
UPDATE "showings"
SET "status" = 'cancelled'
WHERE "id" IN (
  SELECT "id" FROM ranked_showings WHERE row_number > 1
);

UPDATE "showings" s
SET "activeProspectSlotKey" =
  COALESCE(
    NULLIF('email:' || LOWER(l."email"), 'email:'),
    NULLIF('phone:' || REGEXP_REPLACE(l."phone", '[^0-9]', '', 'g'), 'phone:'),
    'lead:' || s."leadId"
  ) || ':' ||
  to_char(s."scheduledAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') || 'T' ||
  to_char(s."scheduledAt" AT TIME ZONE 'UTC', 'HH24:MI:SS.MS') || 'Z'
FROM "leads" l
WHERE l."id" = s."leadId"
  AND s."status" IN ('scheduled', 'confirmed');

CREATE UNIQUE INDEX "showings_tenantId_activeProspectSlotKey_key"
  ON "showings"("tenantId", "activeProspectSlotKey");

-- The active showing is the source of truth for the unit a broker sees on a lead and conversation.
WITH active_showings AS (
  SELECT DISTINCT ON ("leadId") "leadId", "unitId"
  FROM "showings"
  WHERE "status" IN ('scheduled', 'confirmed')
  ORDER BY "leadId", "scheduledAt" DESC, "createdAt" DESC
)
UPDATE "leads" l
SET "unitId" = active_showings."unitId"
FROM active_showings
WHERE l."id" = active_showings."leadId";

WITH active_showings AS (
  SELECT DISTINCT ON ("leadId") "leadId", "unitId"
  FROM "showings"
  WHERE "status" IN ('scheduled', 'confirmed')
  ORDER BY "leadId", "scheduledAt" DESC, "createdAt" DESC
)
UPDATE "chat_conversations" c
SET "unitId" = active_showings."unitId"
FROM active_showings
WHERE c."leadId" = active_showings."leadId";
