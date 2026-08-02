-- Normalize keys created by earlier migrations so they match JavaScript Date#toISOString().
UPDATE "showings"
SET "activeSlotKey" = "leadId" || ':' ||
  to_char("scheduledAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') || 'T' ||
  to_char("scheduledAt" AT TIME ZONE 'UTC', 'HH24:MI:SS.MS') || 'Z'
WHERE "activeSlotKey" IS NOT NULL;

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
  AND s."activeProspectSlotKey" IS NOT NULL;
