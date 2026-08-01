# Missing Demo Listing Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three fictional local images to each active demo unit that currently has no gallery, without replacing any existing images.

**Architecture:** Generate 12 PNG assets under Vite's `apps/web/public/demo-listings/` directory and add 12 `ListingPhoto` seed rows using their local paths. The established Telegram adapter uploads local paths to Telegram, and a small idempotent database sync makes the galleries available without reseeding the current demo.

**Tech Stack:** GPT Image generation, Vite static files, Prisma seed, Prisma Client, Vitest.

## Global Constraints

- Only `unit_kelowna_303`, `unit_kits_203`, `unit_northvan_101`, and `unit_richmond_502` receive new photos.
- Every generated image is fictional, photorealistic, has no people, no text, no logos, and no watermark.
- Existing Unsplash and Loft 410 photo records are not modified.
- Each new gallery has exactly three images, with `exterior` as the only primary image.

---

### Task 1: Generate and save the four three-photo galleries

**Files:**
- Create: `apps/web/public/demo-listings/kelowna-lakeside-303-{exterior,living-kitchen,bedroom}.png`
- Create: `apps/web/public/demo-listings/kits-point-203-{exterior,living-kitchen,bedroom}.png`
- Create: `apps/web/public/demo-listings/northvan-bluffs-101-{exterior,living-kitchen,bedroom}.png`
- Create: `apps/web/public/demo-listings/richmond-gardens-502-{exterior,living-kitchen,bedroom}.png`

**Interfaces:**
- Consumes: unit details from `apps/api/prisma/seed.ts`.
- Produces: 12 public paths under `/demo-listings/`.

- [ ] **Step 1: Generate the Kelowna gallery**

Generate a fictional Okanagan lakeside low-rise exterior, a one-bedroom living room/kitchen with lake view, and a bright compact bedroom. Match `Lakeside 303`: one bedroom, 580 sq ft, cats allowed.

- [ ] **Step 2: Generate the Kits gallery**

Generate a fictional Kitsilano walkup exterior, a two-bedroom suite living room/kitchen with patio, and a bright bedroom. Match `Suite 203`: two bedrooms, 910 sq ft, pet friendly.

- [ ] **Step 3: Generate the North Vancouver gallery**

Generate a fictional mountain-view estate exterior, a two-bedroom living room/kitchen with mountain view, and a primary bedroom. Match `Estates 101`: two bedrooms, 1000 sq ft, pet friendly.

- [ ] **Step 4: Generate the Richmond gallery**

Generate a fictional contemporary Richmond tower exterior, a compact one-bedroom living room/kitchen, and a bedroom. Match `Tower 502`: one bedroom, 590 sq ft, no pets.

- [ ] **Step 5: Inspect and copy the selected images**

Confirm the three images per unit are visually coherent, distinct, and free of text or marks. Copy every selected asset to its exact path above.

### Task 2: Seed exactly three photos for each previously empty unit

**Files:**
- Modify: `apps/api/prisma/seed.ts` (`prisma.listingPhoto.createMany` data)
- Modify: `apps/api/prisma/seed.test.ts`

**Interfaces:**
- Consumes: `unitKelowna303.id`, `unitKits.id`, `unitNorthVan101.id`, and `unitRichmond502.id`.
- Produces: twelve `ListingPhoto` rows whose IDs begin `photo_kelowna_303_`, `photo_kits_203_`, `photo_northvan_101_`, and `photo_richmond_502_`.

- [ ] **Step 1: Write the failing seed test**

For each of the four ID prefixes, count source matches using `new RegExp("id: 'photo_<prefix>_[^']+'", 'g')` and expect exactly three. Assert one `/demo-listings/<slug>-exterior.png` path per unit.

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm --filter @property-manager/api test -- seed.test.ts`

Expected: FAIL because all four galleries are absent.

- [ ] **Step 3: Add the seed records**

Add three `ListingPhoto` objects per unit. Use the local PNG path for `originalUrl`, set `enhancedUrl` equal to the exterior path and `isPrimary: true` only for `exterior`; use `enhancedUrl: null` and `isPrimary: false` for `living_kitchen` and `bedroom`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `corepack pnpm --filter @property-manager/api test -- seed.test.ts`

Expected: PASS.

### Task 3: Synchronize the safe current demo data and verify coverage

**Files:**
- No repository source changes beyond Tasks 1–2.

**Interfaces:**
- Consumes: the twelve deterministic IDs and local paths seeded in Task 2.
- Produces: current `tenant_demo_pm` inventory where every active unit has at least three photos.

- [ ] **Step 1: Upsert only the twelve new ListingPhoto records**

Use a Prisma Client one-off script that calls `listingPhoto.upsert` by each deterministic ID. It must use the exact seed values and must not delete any tenant, conversation, property, unit, or existing photo.

- [ ] **Step 2: Query photo coverage**

Use `unit.findMany({ where: { tenantId: 'tenant_demo_pm', isActive: true }, include: { listingPhotos: true } })` and assert each returned unit has `listingPhotos.length >= 3`.

- [ ] **Step 3: Run final verification**

Run:

```powershell
corepack pnpm --filter @property-manager/adapters test
corepack pnpm --filter @property-manager/api test
corepack pnpm --filter @property-manager/adapters typecheck
corepack pnpm --filter @property-manager/api typecheck
```

For each new local asset, request `http://localhost:5173/demo-listings/<filename>.png` and expect HTTP 200.
