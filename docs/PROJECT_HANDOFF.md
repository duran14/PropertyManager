# Project Handoff - Property Manager

Last updated: 2026-07-15, America/Vancouver.

This document is for a future AI agent or developer continuing the project after the current Codex session. It summarizes what was built, what is currently working, how to verify it, and what should come next.

## Current Objective

Build a Property Manager / Broker SaaS for British Columbia, Canada. The current product direction is an English-language operational app where property managers can onboard their business and properties, then let AI-assisted bots handle early prospect conversations across Telegram, SMS, WhatsApp, and later voice.

The app is still in mock/prototype mode for intelligence and most third-party integrations. Real Twilio SMS and WhatsApp are connected for testing.

## Repository

- Local path: `C:\Users\duran\Documents\Proyectos IA\ZCodeProject\Property Manager`
- GitHub remote: `https://github.com/duran14/PropertyManager.git`
- Branch: `main`
- Latest confirmed feature commit: `dc0a25d Add document storage and knowledge retrieval`.

Important recent commits:

- `dc0a25d Add document storage and knowledge retrieval`
- `2cf7773 Add document knowledge and lead workflow`
- `45443f0 Add lead operations and inventory edits`
- `07f914f Add conversation activity history filters`
- `0b4a8bb Dedupe persisted showing activity`
- `438c5a0 Persist conversation event log`
- `62c3589 Add conversation recent activity feed`
- `8de86ff Add conversation timeline summary`
- `4686afa Stage suggested replies and reschedule tours`
- `d9b0966 Suggest replies for showing actions`
- `3583f81 Manage showings from conversations`
- `032e330 Schedule showings from conversations`
- `a59b081 Add lead status controls to conversations`
- `Add staff override for recommended units`
- `b1dcb17 Track chatbot unit recommendations`
- `8da09e0 Add onboarding and property inventory management`
- `a31208e Surface chatbot lead profile in dashboard`
- `22eddc0 Track preferred lead channel separately`
- `4f6f930 Improve mock leasing chatbot flow`
- `79fbfbe Keep chat conversations channel-specific`
- `15779c1 Return TwiML from Twilio webhooks`
- `06b7ee7 Add real Twilio messaging adapter`
- `3400687 Add Twilio SMS and WhatsApp webhook plumbing`
- `ad11f5d Configure shared Telegram demo routing`

Before starting new work, run:

```powershell
git status --short
git log --oneline -8
```

The feature work through `dc0a25d` is pushed to `origin/main`. Recovery documentation and the Windows-safe `127.0.0.1` database example were prepared and verified on 2026-07-15.

## Verified Capabilities

### Messaging channels

Telegram:

- Shared Telegram demo routing exists.
- A previously created Telegram bot is configured through `TELEGRAM_BOT_TOKEN` when present.
- Default tenant routing uses `TELEGRAM_DEFAULT_TENANT_ID=tenant_demo_pm`.

SMS:

- Real Twilio SMS is connected and verified end to end.
- User's test phone received SMS replies.
- Twilio inbound and outbound were confirmed in Twilio Messages API.
- `TWILIO_SMS_FROM` was corrected to the real SMS-capable Twilio number ending in `5576`.

WhatsApp:

- Twilio WhatsApp Sandbox is connected and verified end to end.
- User received WhatsApp replies.
- Twilio status showed outbound WhatsApp as `read`.
- `TWILIO_WHATSAPP_FROM` points to Twilio Sandbox number ending in `8886`.

Channel separation:

- SMS and WhatsApp conversations now use channel-specific external IDs, e.g. `sms:+...` and `whatsapp:+...`.
- This prevents the same phone number from overwriting the same conversation across channels.
- Manual staff replies strip the channel prefix before sending.

### Mock chatbot brain

The app still uses the mock GLM adapter unless a real AI key is configured. The mock was improved to support a better leasing journey:

- English responses.
- Extracts budget.
- Asks for move-in timing.
- Extracts preferred area, occupants, and pets.
- Moves toward tour scheduling after basic qualification.
- Routes human/legal/emergency requests to handoff.

Primary files:

- `packages/adapters/src/mocks/glm.mock.ts`
- `packages/adapters/src/mocks/glm.mock.test.ts`
- `apps/api/src/services/chatbot.service.ts`
- `apps/api/src/services/chatbot.service.test.ts`

### Dashboard lead profile

Captured chatbot data is surfaced in the app:

- `/leads` now returns `prospectProfile`.
- Leads table shows compact chips for budget, move-in, area, occupants, pets.
- Leads table recognizes `sms`, `whatsapp`, `telegram`, `web`, `email`, `unit_url`, `showmojo`, `manual`.
- Conversations page shows visible slots in list previews and detail summary cards.
- Conversations detail lets staff update the linked lead status without leaving the conversation.
- Lead status updates are validated against the known funnel states: `new_`, `contacted`, `tour_scheduled`, `qualified`, `converted`, `lost`.

### Showings from Conversations

Staff can now create a manual/internal showing directly from a conversation:

- `POST /chat/conversations/:id/showing` creates a `Showing` from the linked lead and recommended unit.
- The showing is tenant-scoped and appears on `/showings`.
- Creating the showing updates the lead status to `tour_scheduled`.
- Conversation detail now returns linked showings for the lead, so staff can see scheduled visits without leaving the thread.
- This does not require real ShowMojo integration; `showmojoId` and `showmojoUrl` remain empty for manual/internal showings.
- Showing duration is validated to 15, 30, 45, or 60 minutes.
- Linked showings can now be confirmed or cancelled from the conversation detail.
- Backend guards prevent confirming non-scheduled showings and cancelling terminal showings.
- Confirming or cancelling a showing now fills the manual reply input with an editable English suggested message.
- If staff already typed a manual reply, the suggestion is staged in a `Suggested reply ready` band with `Use` and `Dismiss` actions instead of overwriting the draft.
- Cancelled showings expose a `Reschedule` action that preloads the tour scheduler with the same duration and a next-day time.
- Suggested showing reply copy lives in `@property-manager/core/showing-messages` so it can later be reused by AI-assisted reply generation.
- Conversation detail now includes a compact `Conversation timeline` with lead capture, unit recommendation, tour status, and pending reply state.
- Timeline copy and status priority live in `@property-manager/core/conversation-timeline` so it can later be reused in other operational views.
- Conversation detail now includes `Recent activity` ordered newest-first.
- Recent activity combines persisted staff/action events with derived events from existing conversation messages, profile slots, the active unit recommendation, lead creation, and linked showings.
- Persisted conversation events live in the new `conversation_events` table with tenant/conversation/lead/actor links and RLS policies.
- The app currently records events for lead status changes, staff unit overrides, manual staff replies, manual showing creation, showing confirmation, and showing cancellation.
- Recent activity now suppresses derived showing entries when a persisted event already references the same showing through `payload.showingId`.
- Conversation detail now includes `Activity history` below `Recent activity`.
- Activity history can be filtered by `All`, `Staff actions`, `Messages`, `Lead profile`, and `Showings`.
- Activity feed labels, priorities, category assignment, filtering, and date normalization live in `@property-manager/core/conversation-activity`.
- Staff can now add internal notes from the conversation detail.
- Staff can request human handoff from the conversation detail; the conversation state is set to `handoff`.
- Internal notes and handoff requests are persisted as conversation events and appear in `Activity history` under `Staff actions`.

Primary files:

- `apps/api/src/routes/chat.ts`
- `apps/api/src/routes/leads.ts`
- `apps/api/src/services/scheduling.service.ts`
- `apps/api/src/services/scheduling.service.test.ts`
- `apps/api/src/services/conversation-events.service.ts`
- `apps/api/src/services/conversation-events.service.test.ts`
- `apps/api/prisma/migrations/20260712032000_add_conversation_events/migration.sql`
- `apps/web/src/pages/ConversationsPage.tsx`
- `packages/core/src/showing-messages.ts`
- `packages/core/src/showing-messages.test.ts`
- `packages/core/src/conversation-timeline.ts`
- `packages/core/src/conversation-timeline.test.ts`
- `packages/core/src/conversation-activity.ts`
- `packages/core/src/conversation-activity.test.ts`

### Lead detail and dashboard activity

The Leads dashboard now surfaces operational activity:

- `/leads` includes `latestActivity` derived from the newest persisted conversation event for each lead.
- The Leads table links each prospect name to `/leads/:id`.
- The Lead Detail page shows profile/contact information, latest activity, full event history, recent conversation messages, showings, and internal notes.

Primary files:

- `apps/api/src/routes/leads.ts`
- `apps/api/src/services/leads.service.ts`
- `apps/api/src/services/leads.service.test.ts`
- `apps/web/src/pages/LeadsPage.tsx`
- `apps/web/src/pages/LeadDetailPage.tsx`
- `apps/web/src/lib/types.ts`
- `apps/web/src/App.tsx`

### Onboarding and property inventory

The app now has a `Properties & Onboarding` page for the PM/broker team:

- Company onboarding profile: logo URL, services, values, pricing notes, showing preferences, pet policy, handoff contact, AI tone, AI instructions.
- Property creation: name, address, city, province, postal code.
- Unit creation: rent, bedrooms, bathrooms, square feet, available date, amenities, pet policy, parking, utilities, active flag.
- Inventory list grouped by property.
- Property records can be loaded from Inventory into the property form and saved through `PATCH /properties/:propertyId`.
- Unit records can be loaded from Inventory into the unit form and saved through `PATCH /properties/units/:unitId`.
- Documents can be saved from `Properties & Onboarding` with file metadata/base64, category, attachment target, description, and extracted text/notes.
- Uploaded document binaries are now written to local object-style storage under `DOCUMENT_STORAGE_DIR` (default `.storage/documents`) instead of being persisted as base64 in the database.
- `knowledge_documents` stores `storageKey`, `storageUrl`, and `extractionStatus`; `fileBase64` is intentionally no longer written for new uploads.
- Text-like uploads are decoded automatically into `textContent`; PDFs/images without supplied text remain `pending` until a real OCR provider is added.
- Document descriptions and extracted text are chunked into `knowledge_chunks`.
- `GET /knowledge-base/search?q=...` ranks tenant-scoped chunks and returns the top matches.
- The `Properties & Onboarding` page shows extraction status and includes a small knowledge search panel.
- Obsidian-ready Markdown is generated by `GET /knowledge-base/obsidian-export`; the UI previews the files in `Properties & Onboarding`.
- The app remains the source of truth; Obsidian export is a synced/derived layer.

Primary files:

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260711152000_add_onboarding_and_unit_details/migration.sql`
- `apps/api/prisma/migrations/20260711154500_rls_onboarding_profile/migration.sql`
- `apps/api/src/routes/onboarding.ts`
- `apps/api/src/routes/properties.ts`
- `apps/api/src/routes/documents.ts`
- `apps/api/src/routes/knowledge-base.ts`
- `apps/api/src/services/property-inventory.service.ts`
- `apps/api/src/services/document-intake.service.ts`
- `apps/api/src/services/document-storage.service.ts`
- `apps/api/src/services/document-extraction.service.ts`
- `apps/api/src/services/knowledge-base.service.ts`
- `apps/api/src/services/knowledge-retrieval.service.ts`
- `apps/web/src/pages/PropertiesPage.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/components/Layout.tsx`

The chatbot now uses active units from the database when it reaches the unit recommendation stage. It replies with real property/unit names, city, rent, and available details when present.
The chatbot prompt also includes tenant onboarding policies/instructions, latest uploaded knowledge documents, and the top ranked knowledge chunks for the current user message. If `ZAI_API_KEY` is configured, the factory uses `GlmRealAdapter`; otherwise it keeps the existing mock adapter.

Primary AI files:

- `packages/adapters/src/real/glm.real.ts`
- `packages/adapters/src/factory.ts`
- `apps/api/src/services/chatbot.service.ts`
- `apps/api/src/services/knowledge-retrieval.service.ts`

### Lead workflow and assignment

Leads now have lightweight operational workflow fields:

- `operationalStatus`: `needs_review`, `assigned`, `waiting_on_prospect`, `needs_handoff`, or `closed`.
- `assignedUserId`: optional staff owner.
- `/users/staff` lists active users for assignment.
- `/leads/:id/workflow` updates operational status and assignee.
- Lead Detail exposes workflow controls.
- Conversation handoff marks the linked lead as `needs_handoff`.

### Traceable unit recommendations

The chatbot now ranks active units by captured lead criteria and stores the recommendation:

- Matching considers budget, preferred area, pets, occupants/bedrooms, and move-in month when available.
- The recommended unit is saved on `ChatConversation.unitId`.
- The same unit is also saved on `Lead.unitId`, so the Leads table shows the interested unit.
- The bot stores `match_reason` and `recommended_unit_id` as conversation slots.
- Conversations now display a `Recommended unit` summary and match reason.
- Staff can override the recommended unit directly from `/conversations`.
- The override is tenant-scoped, updates `ChatConversation.unitId`, updates `Lead.unitId` when a lead is linked, and rewrites the `recommended_unit_id` and `match_reason` slots.

Primary files:

- `apps/api/src/services/chatbot.service.ts`
- `apps/api/src/services/chatbot.service.test.ts`
- `apps/api/src/routes/chat.ts`
- `apps/web/src/pages/ConversationsPage.tsx`

Primary files:

- `apps/api/src/services/leads.service.ts`
- `apps/api/src/services/leads.service.test.ts`
- `apps/web/src/pages/LeadsPage.tsx`
- `apps/web/src/pages/ConversationsPage.tsx`
- `apps/web/src/lib/types.ts`

## Current Local Runtime

The API and tunnel were restarted after the last feature work.

Expected local services:

- API: `http://localhost:4000`
- Web: `http://localhost:5173`
- Cloudflare quick tunnel: `https://movers-ccd-starter-dance.trycloudflare.com`

Important: the Cloudflare quick tunnel URL is temporary. If it stops working, start a new tunnel and update Twilio webhook URLs.

Current Twilio webhook targets used during testing:

```text
SMS:
https://movers-ccd-starter-dance.trycloudflare.com/webhooks/twilio/sms

WhatsApp:
https://movers-ccd-starter-dance.trycloudflare.com/webhooks/twilio/whatsapp
```

Stable webhook targets:

- `GET /webhook-config` returns `health`, `twilioSms`, `twilioWhatsapp`, `telegram`, and `showmojo` URLs based on `API_URL`.
- See `docs/STABLE_WEBHOOK_DEPLOYMENT.md`.

Health checks:

```powershell
Invoke-RestMethod -Uri 'http://localhost:4000/health' -Method GET
Invoke-RestMethod -Uri 'https://movers-ccd-starter-dance.trycloudflare.com/health' -Method GET
```

Check API listener:

```powershell
Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,State,OwningProcess
```

If multiple stale API dev processes appear, stop only processes whose command line contains this project path and `@property-manager/api` or `tsx watch src/server.ts`, then restart:

```powershell
pnpm --filter @property-manager/api dev
```

## Environment Notes

Do not commit `.env`.

Required local services:

- Postgres from Docker on port `5433`
- Redis from Docker on port `6380`

Key environment variables currently relevant:

- `DATABASE_URL`
- `REDIS_URL`
- `API_URL`
- `WEB_URL`
- `DOCUMENT_STORAGE_DIR` (default `.storage/documents`)
- `DOCUMENT_STORAGE_PUBLIC_BASE_URL` (optional; blank means local `local://...` URLs)
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `INTEGRATION_ENCRYPTION_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_SMS_FROM`
- `TWILIO_WHATSAPP_FROM`
- `TWILIO_DEFAULT_TENANT_ID=tenant_demo_pm`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_DEFAULT_TENANT_ID=tenant_demo_pm`

Security note:

- A Twilio auth token was pasted into the chat earlier. The user was advised to rotate it. Do not expose or reprint secrets.

## How To Verify The Current State

Run:

```powershell
pnpm typecheck
pnpm test
pnpm build
```

Current verification after Docker/WSL recovery on 2026-07-15:

- `pnpm typecheck` passed.
- `pnpm test` passed: 29 test files and 84 tests.
- `pnpm build` passed.
- `prisma migrate deploy` found all 9 migrations applied and no pending migrations.
- `prisma generate` completed successfully.
- Postgres and Redis were healthy in Docker Compose.

Database maintenance commands:

```powershell
pnpm --dir apps/api exec prisma migrate deploy
pnpm --dir apps/api exec prisma generate
```

Use `127.0.0.1:5433` rather than `localhost:5433` in this Windows environment; the latter resolved through IPv6 and previously caused Prisma `P1001` despite a healthy Postgres container.

Manual UI check:

1. Open `http://localhost:5173`.
2. Login with demo account:
   - `pm@pacificridge.ca`
   - `Password123!`
3. Open `Leads`.
4. Confirm profile chips are visible for bot-enriched leads.
5. Open `Conversations`.
6. Confirm visible prospect slots appear in list previews and detail summary cards.
7. Confirm the conversation detail shows `Conversation timeline` chips for lead, unit, tour, and pending reply state.
8. Confirm the conversation detail shows `Recent activity` with newest events first.
9. Confirm `Activity history` filters events by `Staff actions`, `Messages`, `Lead profile`, and `Showings`.
10. Add an internal note and confirm it appears under `Staff actions`.
11. Request handoff and confirm the conversation state changes to `Human handoff`.
12. Trigger a lead status change or showing action and confirm a persisted staff/action event appears after the conversation detail refetches.
13. Open `Leads`, confirm the `Latest activity` column is populated for leads with conversation events.
14. Click a lead name and confirm `/leads/:id` shows profile, conversations, showings, activity history, and notes.
15. Open `Properties`, edit a property and a unit from Inventory, then confirm the list refreshes with the saved values.
16. Upload/save a document in `Properties & Onboarding` and confirm it appears in the document list.
17. Confirm text uploads show `completed`, binary uploads without text show `pending`, and uploaded files are stored under `.storage/documents`.
18. Search for a term from a document in `Knowledge search` and confirm matching snippets appear.
19. Generate the Obsidian export and confirm company, property, and document Markdown previews are shown.
20. Open a Lead Detail page, assign a staff owner, save workflow, and confirm the values persist.
21. Confirm `/webhook-config` returns stable webhook URLs based on `API_URL`.

Messaging smoke tests:

SMS:

1. Send a message from the user's phone to the Twilio SMS number ending in `5576`.
2. Confirm the phone receives a reply.
3. Confirm Twilio shows inbound received and outbound-api delivered.

WhatsApp:

1. Ensure the user's phone has joined the Twilio WhatsApp Sandbox.
2. Send a WhatsApp message to the sandbox number ending in `8886`.
3. Confirm the phone receives a reply.
4. Confirm Twilio shows inbound received and outbound-api read/delivered.

Useful test WhatsApp/SMS text:

```text
My budget is $2600. I want to move in August near Burnaby. 2 occupants and one cat.
```

Expected behavior:

- Bot replies coherently in English.
- Conversation slots capture budget, move-in date, area, occupants, pets.
- Leads dashboard surfaces the enriched profile.

## Product Decisions Captured

Language:

- User confirmed the application must be in English.
- Conversation with the user can remain Spanish.

Channel priority:

1. Telegram
2. WhatsApp
3. SMS/Twilio was added because many Canadian users prefer normal SMS
4. Voice later

Twilio model:

- Twilio is used for SMS and WhatsApp Sandbox testing.
- WhatsApp does not strictly require Twilio in the abstract, but for this MVP Twilio gives a unified messaging adapter and webhook model.

Tenant strategy:

- Current demo uses shared bots and `TWILIO_DEFAULT_TENANT_ID` / `TELEGRAM_DEFAULT_TENANT_ID`.
- Long term can route by per-tenant numbers, bot mappings, or channel configuration.

Obsidian direction:

- App should be the source of truth for properties, policies, prices, and documents.
- Later export/sync to Obsidian as Markdown.
- Bots should query app-owned structured data first; Obsidian can be a synced knowledge layer.

Voice direction:

- Later prototype the same script in Gemini, ElevenLabs, and OpenAI Realtime.
- Measure naturalness, latency, and cost for 5 and 10 minute calls.

Legal/handoff:

- Bot should be warm and useful but not pretend to be human.
- It should disclose AI nature at an appropriate point.
- It should hand off legal, emergency, complaint, contract, or explicit human requests.

## Next Recommended Work

Recommended next step:

1. Continue refining lead attribution and channel history.
   - `source` now means first-touch attribution.
   - `preferredChannel` is updated when an existing lead resumes through another channel.
   - `prospectProfile.lastChannel` is derived from the most recently updated conversation.
   - A future improvement could add a dedicated channel history table or event timeline.

Then:

2. Deepen property intake/onboarding.
   - Replace local document storage with S3/R2 or another durable object store when moving beyond local staging.
   - Add real OCR for pending PDFs/images and store confidence/review status.
   - Add assistant role if the product needs a fourth RBAC role.
   - Add delete/archive flows for properties and units; edit flows now exist.

3. Improve chatbot matching against real inventory.
   - Add amenities and exact availability-date matching.
   - Add stronger semantic retrieval with embeddings/vector search when the document corpus grows.
   - Add explicit "why this unit matched" event history, not only the latest slot value.
   - Let staff override the recommended unit from the Conversations page.
   - Keep legal/compliance guardrails.

4. Smoke-test the real GLM adapter with live Z.ai credentials.
   - Keep current mock behavior as fallback.
   - Do not remove mock mode; it is useful for demos and tests.

5. Make Twilio webhook/tunnel setup more durable.
   - For real deployment, use a stable hosted API URL instead of Cloudflare quick tunnel.
   - Avoid requiring local machine uptime for Twilio callbacks.

6. Persist an explicit project state/changelog.
   - Keep this handoff doc updated after each major milestone.
   - Add links to commits and exact verification commands.

## Known Gaps And Watchouts

- Windows Docker/WSL recovery, including the confirmed missing `system.vhd` / `modules.vhd` repair and the Prisma IPv6 `localhost` issue, is documented in `docs/TROUBLESHOOTING_DOCKER_WSL_WINDOWS.md`.

- Cloudflare quick tunnel is temporary and can break.
- Current AI remains mock unless `ZAI_API_KEY` is configured; real GLM adapter exists but has not been live-smoke-tested in this session.
- Properties & Onboarding can create/list/edit records and save prototype document uploads, but delete/archive and durable object storage are not implemented yet.
- Obsidian export is generated as Markdown JSON; direct Obsidian vault sync is not implemented yet.
- `.env` contains live credentials locally; never commit it.
- User had trouble connecting GitHub through ChatGPT, but direct git push works to `duran14/PropertyManager.git`.
- Twilio trial may have limitations around numbers and verified recipients.
- Some old seeded/demo conversations can contain historical Spanish slot values or old externalId format from before the channel-specific fix.
- README has mojibake/encoding artifacts from earlier content; not addressed yet.
- Lead source semantics need refinement: first-touch source vs latest channel/preferred channel.
