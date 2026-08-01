# Demo Listing Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three generated, fictional listing images for Burnaby Heights Lofts — Loft 410 to the deterministic demo seed.

**Architecture:** Store generated PNG assets in the Vite public directory so they are served at stable `/demo-listings/...` URLs. Extend the existing `prisma.listingPhoto.createMany` seed data with three `ListingPhoto` records for `unit_burnaby_410`, ordered with the exterior image as primary. When Telegram receives a local path, its adapter fetches it from `WEB_URL` and uploads its bytes with multipart form data.

**Tech Stack:** GPT Image generation, Vite public assets, Prisma seed, Vitest.

## Global Constraints

- Images are fictional and photorealistic; they must not depict or claim to be a real property.
- Only `unit_burnaby_410` is in scope.
- The first seed record is the primary image used by Telegram recommendations.
- Asset URLs must be deterministic local Vite paths.
- For local asset paths, Telegram must upload the fetched file; it cannot be given `localhost` as a remote URL.

---

### Task 1: Generate and store the three project assets

**Files:**
- Create: `apps/web/public/demo-listings/burnaby-heights-loft-410-exterior.png`
- Create: `apps/web/public/demo-listings/burnaby-heights-loft-410-living-kitchen.png`
- Create: `apps/web/public/demo-listings/burnaby-heights-loft-410-bedroom.png`

**Interfaces:**
- Consumes: the Loft 410 description in `apps/api/prisma/seed.ts` (2 bedrooms, 2 bathrooms, 980 sq ft, city-view balcony).
- Produces: three public URLs beginning `/demo-listings/burnaby-heights-loft-410-`.

- [ ] **Step 1: Generate one image per prompt**

Use three separate photorealistic prompts: a contemporary Burnaby mid-rise exterior, an open loft living room and kitchen with city-view balcony, and a bright primary bedroom. Include `fictional property photo`, no people, no logos, no signs, no text, and no watermark in every prompt.

- [ ] **Step 2: Inspect each result**

Confirm the exterior, living/kitchen, and bedroom are visually distinct, contain no legible branding, and match an upscale 2-bedroom rental listing.

- [ ] **Step 3: Copy the selected images to the public directory**

Create `apps/web/public/demo-listings/` and save the three final PNG files using the exact filenames above.

### Task 2: Seed the three ListingPhoto records

**Files:**
- Modify: `apps/api/prisma/seed.ts:444` (`prisma.listingPhoto.createMany` data)
- Test: `apps/api/prisma/seed.test.ts`

**Interfaces:**
- Consumes: `unitBurnaby410.id` and the three public paths produced by Task 1.
- Produces: three `ListingPhoto` rows with `unitId: unitBurnaby410.id`; the exterior row has `isPrimary: true`.

- [ ] **Step 1: Write the failing seed assertion**

Add an assertion that the deterministic seed source contains the three `photo_burnaby_410_*` IDs and `/demo-listings/burnaby-heights-loft-410-` paths.

- [ ] **Step 2: Run the seed test to verify it fails**

Run: `corepack pnpm --filter @property-manager/api test -- seed.test.ts`

Expected: FAIL because no Burnaby Loft 410 photo records exist.

- [ ] **Step 3: Add the exact seed records**

Insert three objects into the existing `listingPhoto.createMany` array:

```ts
{
  id: 'photo_burnaby_410_exterior',
  tenantId: tenant.id,
  unitId: unitBurnaby410.id,
  originalUrl: '/demo-listings/burnaby-heights-loft-410-exterior.png',
  enhancedUrl: '/demo-listings/burnaby-heights-loft-410-exterior.png',
  enhancementType: 'enhance',
  status: 'enhanced',
  autoenhanceOrderId: 'ae_demo_burnaby_410_exterior',
  isPrimary: true,
}
```

Add equivalent `living_kitchen` and `bedroom` objects with `isPrimary: false`.

- [ ] **Step 4: Run the seed test to verify it passes**

Run: `corepack pnpm --filter @property-manager/api test -- seed.test.ts`

Expected: PASS.

### Task 3: Validate static serving and recommendation data

**Files:**
- Test: `apps/api/src/services/chatbot.service.test.ts`

**Interfaces:**
- Consumes: `getAvailableUnits` mapping from `ListingPhoto` to `AvailableUnit.photoUrl`.
- Produces: a recommendation delivery plan whose first Burnaby option has the exterior asset URL.

- [ ] **Step 1: Add a failing delivery-plan assertion**

Add a `buildRecommendationDeliveryPlan` unit test that passes a Burnaby Loft 410 unit with `photoUrl: '/demo-listings/burnaby-heights-loft-410-exterior.png'` and asserts the first option preserves that value.

- [ ] **Step 2: Run the focused test**

Run: `corepack pnpm --filter @property-manager/api test -- chatbot.service.test.ts`

Expected: PASS if the existing mapping preserves the supplied URL; otherwise fix only the missing mapping.

- [ ] **Step 3: Run final verification**

Run:

```powershell
corepack pnpm --filter @property-manager/api test
corepack pnpm --filter @property-manager/api exec tsc --noEmit
Invoke-WebRequest http://localhost:5173/demo-listings/burnaby-heights-loft-410-exterior.png -UseBasicParsing
```

Expected: all API tests and TypeScript checks pass; the image request returns HTTP 200.

### Task 4: Upload local seeded photos to Telegram

**Files:**
- Modify: `packages/adapters/src/real/telegram.real.ts:58` (`TelegramRealAdapter.sendPhoto`)
- Test: `packages/adapters/src/real/telegram.real.test.ts`

**Interfaces:**
- Consumes: `photoUrl: string` from `MessagingAdapter.sendPhoto`.
- Produces: a standard Bot API `sendPhoto` call; local `/demo-listings/...` paths are posted as `multipart/form-data` file uploads.

- [ ] **Step 1: Write a failing adapter test**

Mock `fetch` so a GET to `http://localhost:5173/demo-listings/burnaby-heights-loft-410-exterior.png` returns a PNG `Blob`. Assert that `sendPhoto('123', '/demo-listings/burnaby-heights-loft-410-exterior.png')` performs the second request to Telegram with a `FormData` body containing `chat_id` and `photo`.

- [ ] **Step 2: Run the adapter test to verify it fails**

Run: `corepack pnpm --filter @property-manager/adapters test -- telegram.real.test.ts`

Expected: FAIL because `sendPhoto` currently serializes every image path as JSON.

- [ ] **Step 3: Implement local-path uploading**

When `photoUrl.startsWith('/')`, fetch `${process.env.WEB_URL ?? 'http://localhost:5173'}${photoUrl}`, append the returned blob to `FormData` as `photo`, append `chat_id` and an optional caption, and post that form to Telegram. Preserve the existing JSON path for external URLs and Telegram file IDs.

- [ ] **Step 4: Run tests and manually verify one Telegram image**

Run:

```powershell
corepack pnpm --filter @property-manager/adapters test -- telegram.real.test.ts
corepack pnpm --filter @property-manager/api test
```

Then re-run the seed and send a new two-bedroom query; Telegram should receive the exterior image after the option card.
