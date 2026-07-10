# Channel Rollout Plan

This plan defines how the prospect-facing assistant should expand across channels while keeping implementation risk staged.

## Channel Order

1. Telegram.
2. SMS through Twilio.
3. WhatsApp.
4. Voice.

## Shared Channel Requirements

Every channel should use the same assistant knowledge, lead model, and audit trail.

Each inbound conversation should create or update:

- lead,
- conversation,
- channel identity,
- extracted slots,
- source property or unit when known,
- handoff status,
- audit entries.

Each channel should support:

- AI disclosure,
- warm professional responses,
- property Q&A,
- qualification,
- showing intent capture,
- human handoff,
- conversation history,
- role-based staff review.

## Phase 1: Telegram

Why first:

- Easier integration than WhatsApp.
- Good for testing conversation flow.
- Useful for internal demos and operational validation.

Scope:

- connect Telegram bot,
- route inbound messages into the existing conversation service,
- use tenant context,
- create or update leads,
- show conversations in the admin UI,
- allow staff manual reply,
- log audit trail.

Acceptance criteria:

- tenant can configure Telegram bot token,
- prospect can message the Telegram bot,
- conversation appears in Conversations,
- lead appears in Leads,
- assistant can answer property questions from structured app knowledge,
- staff can send manual reply,
- handoff is visible.

## Phase 2: SMS through Twilio

Why second:

- Many prospects in Canada use normal SMS instead of WhatsApp.
- SMS is commercially important for property managers and brokers.

Scope:

- configure Twilio number per tenant,
- receive SMS webhooks,
- send SMS replies,
- map phone number to lead,
- respect opt-out language,
- handle short-message constraints,
- allow staff takeover.

Acceptance criteria:

- inbound SMS creates or updates a lead,
- assistant reply is sent by SMS,
- opt-out keywords are handled,
- staff handoff pauses AI replies,
- conversation is visible in the app,
- audit trail records message handling.

Open compliance questions:

- consent requirements,
- opt-out wording,
- message retention,
- Canada-specific SMS rules.

## Phase 3: WhatsApp

Why third:

- Still useful for some prospects and international renters.
- More operational friction due to WhatsApp Business setup and templates.

Scope:

- configure WhatsApp sender,
- receive inbound messages,
- send session replies,
- handle template requirements when outside allowed windows,
- reuse lead and conversation model.

Acceptance criteria:

- inbound WhatsApp message creates or updates a lead,
- assistant replies within session window,
- staff can take over,
- channel-specific errors are visible to admins.

## Phase 4: Voice

Why fourth:

- Highest complexity.
- Requires voice provider selection, telephony routing, latency testing, disclosure rules, and handoff design.

Prototype providers:

- Gemini,
- ElevenLabs,
- OpenAI Realtime.

Likely telephony layer:

- Twilio Voice.

Prototype script:

1. Prospect asks about a property.
2. Prospect asks about requirements and pets.
3. Prospect asks to schedule a showing.
4. Prospect asks a legal/compliance-adjacent question.
5. Prospect asks for a human.

Measure:

- naturalness,
- latency,
- interruption handling,
- disclosure quality,
- handoff behavior,
- average cost per 5-minute call,
- average cost per 10-minute call,
- integration complexity.

## Human Handoff Requirements

Handoff should trigger when:

- prospect asks for a human,
- assistant confidence is low,
- legal or compliance-sensitive question appears,
- pricing exception or negotiation appears,
- complaint or conflict appears,
- maintenance/emergency issue appears,
- discrimination-sensitive topic appears,
- prospect is angry or confused,
- channel delivery fails repeatedly.

When handoff triggers:

- pause AI replies for that conversation,
- notify the assigned staff role,
- show reason for handoff,
- preserve transcript and extracted context,
- allow staff to resume or close the handoff.

## Legal and Compliance Guardrails

The assistant can:

- answer approved factual property questions,
- explain approved process steps,
- share approved requirements,
- suggest scheduling a showing,
- collect prospect preferences.

The assistant should not:

- give legal advice,
- invent eligibility rules,
- negotiate terms without approval,
- discuss protected-class criteria,
- make promises about approval,
- override broker or manager policy,
- answer beyond approved knowledge when uncertain.

## Recommended Next Build Slice

Build Phase 1 Telegram in mock-friendly mode:

1. Add tenant channel configuration model.
2. Build Telegram setup screen.
3. Connect Telegram webhook or poller to tenant config.
4. Enrich lead/conversation records with channel metadata.
5. Add handoff status to conversations.
6. Add assistant knowledge lookup from app source-of-truth data.
7. Add smoke tests for Telegram-style conversations.
