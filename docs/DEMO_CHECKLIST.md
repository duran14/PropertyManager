# Property Manager Demo Checklist

## Demo Accounts

Use `Password123!` for every account.

- `pm@pacificridge.ca` - Property Manager: leasing, photos, leads, showings, and operations.
- `books@pacificridge.ca` - Bookkeeper: OCR review, reconciliation, Sentinel, and audit checks.
- `broker@pacificridge.ca` - Broker: compliance review, RTA signing, and audit verification.

## Recommended Walkthrough

1. Sign in as the Bookkeeper and open the Dashboard.
   - Confirm the Financial Integrity Bridge summary is populated.
   - Open Bills / OCR and review pending bills.
   - Approve or reject one pending-review bill to show human-in-the-loop controls.

2. Open Financial Sentinel.
   - Queue an e-Transfer with a realistic reference and sender.
   - Watch the queue counters and recent AI activity update.
   - Run reconciliation from the same page.

3. Open Reconciliation.
   - Review open discrepancies.
   - Mark one discrepancy as resolved.
   - Run reconciliation again to show the matching flow.

4. Sign in as the Property Manager.
   - Open Leads / Prospecting and advance one lead through the funnel.
   - Open Conversations and send a manual staff reply.
   - Open Showings & Calendar and confirm or cancel a pending tour.

5. Open AI Photos.
   - Select a unit.
   - Add an image URL if needed.
   - Trigger an enhancement and watch the processing state.

6. Sign in as the Broker.
   - Open Leases / RTA.
   - Generate an RTA draft and sign it as Broker.
   - Open Audit Trail and verify the hash chain.

## Rental model-first scenario

The leasing assistant interprets each rental turn through the model and keeps
the deterministic fast path only as a fallback when the model provider is
unreachable. Run this against the Telegram bot
(`@PropertyManagerCanada_bot`) with the local API and Vite running.

1. Send: `I'm Carlos, 2 bedrooms in Burnaby, dog, $3500, September`
   - The bot captures name, area, bedrooms, pets, budget, and move-in date in
     one turn and proposes matching inventory.
2. Correct the name: `sorry Carlos` (or `actually Carlos`)
   - The profile updates in place to `Carlos` without losing the area, budget,
     or any other captured field.
3. Select one of the proposed properties (reply with its option number).
4. Request a tour and pick a slot number from the offered times.
5. Verify the broker confirmation appears in the broker app and that the
   showing is tied to the same unit selected in step 3.
   - Confirm `Lead.name` is `Carlos`, and `ChatConversation.unitId` matches
     `Showing.unitId`.
6. (Optional) Intentionally send an out-of-range slot number (e.g. `99`) to
   confirm the bot asks again instead of booking a phantom tour.

> Outage check: if you point the API at an unreachable GLM endpoint, the bot
> should keep qualifying via the deterministic fallback instead of repeating
> "Could you clarify that?".

## Omnichannel Prospecting Walkthrough (~5-7 min)

This is the buyer-journey demo: a prospect messages the leasing assistant, the
bot qualifies them, captures a profile, recommends a unit, and schedules a tour.
It works in mock mode (no AI key needed); the assistant falls back to the mock
GLM adapter automatically.

### Seed snapshot

After `pnpm db:seed`, the demo tenant has:

- 8 properties across Vancouver, Burnaby, Richmond, Surrey, North Vancouver,
  and Victoria, Kelowna.
- 15 active units with full details (bedrooms, bathrooms, square feet,
  amenities, pet policy, parking, utilities, available-from dates).
- 11 leads across the full funnel (`new_`, `contacted`, `tour_scheduled`,
  `qualified`, `converted`, `lost`).
- 6 conversations with messages and enriched prospect profiles, in different
  states of the chatbot flow (`greeting`, `collecting_budget`,
  `collecting_movein`, `proposing_tour`, `scheduling`, `handoff`).
- 7 showings across statuses (scheduled, confirmed, completed, cancelled).
- Conversation events populating **Recent activity** and **Activity history**.

### Option A - Live message (recommended)

Requires real Twilio SMS/WhatsApp configured (see `PROJECT_HANDOFF.md`).

1. Open **Conversations** and keep it visible.
2. From a test phone, send to the Twilio SMS number (ending `5576`) or WhatsApp
   Sandbox (ending `8886`):
   ```text
   Hi, I am looking for a place in Burnaby for August.
   ```
3. Reply with budget, occupants, and a pet so the bot can capture a profile:
   ```text
   My budget is $2600. I want to move in August near Burnaby. 2 occupants and one cat.
   ```
   - **Stop and show**: the conversation list preview and the detail summary
     now show profile chips for budget, move-in, area, occupants, pets.
4. When the bot proposes a tour, reply `yes` to move into scheduling.
   - **Stop and show**: the **Recommended unit** card with the match reason
     (e.g. "fits the $2,600 budget, matches the Burnaby area, supports cat
     needs").
5. Pick a tour slot from the numbered options the bot offers.
   - **Stop and show**: **Conversation timeline** chips (lead, unit, tour,
     pending reply) and the newly created showing on **Showings**.

### Option B - Scripted (no live messaging)

If Twilio is not connected, drive the same story from the seeded conversations.

1. Open **Conversations** and pick **Aiden Walker** (WhatsApp, `proposing_tour`).
   - **Stop and show**: the full enriched profile chips ($2,600 budget, August
     move-in, Burnaby area, 2 people, cat) — this is the showcase lead.
2. Scroll to **Conversation timeline** and point out lead capture, unit
   recommendation, and tour status.
3. Scroll to **Recent activity** and **Activity history**.
   - Filter by **Staff actions**, **Messages**, **Lead profile**, and
   **Showings** to show the categorized audit trail.
4. Add an internal note ("Strong fit, cat-friendly") and request **Human
   handoff** to show the state change to `Human handoff`.
5. Open **Leads**:
   - Point out the **Latest activity** column and the profile chips per row.
   - Click **Aiden Walker** to open **Lead Detail** with profile, conversations,
   showings, activity history, and notes in one place.
6. Assign a staff owner and save the workflow to show lead assignment.
7. Open **Properties & Onboarding**:
   - Show the inventory grouped by property across all 7 cities.
   - Point out full unit details (amenities, pet policy, parking) that feed the
   bot's recommendations.

### Prospecting talking points

- The assistant is an **AI**, disclosed up front — warm but never pretending to
  be human.
- It **qualifies** (budget, move-in, area, occupants, pets) before proposing
  units, so staff see a enriched profile the moment they open the conversation.
- It **recommends a specific unit** with a match reason, and staff can override
  it from the conversation.
- It **hands off** legal, lease-term, emergency, or explicit human requests.
- Everything the bot captures is surfaced operationally: timeline, recent
  activity, activity history, and the Leads dashboard.

## Reset Demo Data

From the repository root:

```bash
pnpm db:seed
```

The seed rebuilds the deterministic demo tenant and restores the walkthrough data.

## Automated Smoke Test

From the repository root:

```bash
pnpm test:smoke
```

The smoke suite starts or reuses the local API and web servers, reseeds the demo data, signs in with the demo roles, and verifies the main walkthrough screens in Chromium.
