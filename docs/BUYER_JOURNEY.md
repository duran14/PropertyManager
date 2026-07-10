# Buyer Journey Notes

These notes capture the intended buyer-persona journey for the next product design phase. The current app is still in demo and mockup mode; this document is meant to guide the next implementation work.

## Buyer Persona Journey: Node 1

The first journey node starts when a prospective renter discovers a broker or property manager through their website, social media, listing page, or another public channel.

The prospect shows interest by taking an action such as:

- clicking for more information,
- opening the website chat,
- choosing WhatsApp,
- choosing Telegram,
- requesting or starting a phone call.

The goal of this first node is to answer enough questions, build trust, and help the prospect feel comfortable scheduling a showing.

## Multi-Channel Conversation Entry

The product should support multiple entry points for the same leasing assistant:

- embedded website chat,
- WhatsApp,
- Telegram,
- phone or voice agent,
- possibly other channels later.

The voice channel should feel warm, professional, and natural. The assistant should disclose that it is AI-based at an appropriate moment, without making the experience feel robotic or deceptive.

Potential voice options to evaluate:

- Gemini voice capabilities,
- ElevenLabs,
- another voice stack if it better fits latency, cost, quality, or compliance needs.

The assistant should not proactively cold-call prospects. Voice should be used when the prospect initiates or requests that channel.

## Broker / Property Manager Onboarding

Before the assistant can answer prospects well, the broker or property manager needs an onboarding flow.

The preferred channel rollout order is:

1. Telegram.
2. WhatsApp.
3. Voice.

This lets the prospect choose the interaction channel while we keep implementation risk staged.

The onboarding should collect:

- company background,
- values and brand tone,
- services offered,
- pricing and fee structure,
- preferences for how prospects should be handled,
- human handoff rules,
- showing preferences,
- compliance requirements,
- property data.

The onboarding experience likely needs a guided form plus document upload. The client may need to upload:

- logo and brand assets,
- company documents,
- service descriptions,
- pricing sheets,
- fee schedules,
- property lists,
- compliance documents,
- policies and scripts currently used by staff.

Property data should include:

- photos,
- addresses,
- features and amenities,
- availability,
- rent and deposit details,
- pet policies,
- parking and storage,
- utilities,
- neighborhood context,
- showing instructions,
- any information required to comply with Canadian and British Columbia legislation.

This knowledge should feed the bots that respond in chat and voice.

The property upload and management area should be available to:

- bookkeeper,
- property manager,
- broker,
- assistant.

## Knowledge Base Direction

The onboarding knowledge should live in or sync with an Obsidian-based knowledge system.

Open design question:

- Should Obsidian be the source of truth, a synced documentation layer, or an export target from the app?

We need to evaluate how to connect Obsidian:

- local vault files,
- Git-backed markdown vault,
- API or plugin workflow,
- structured app database that generates Obsidian-compatible markdown.

## Assistant Experience Requirements

The chatbot and voice agent must be:

- warm,
- professional,
- friendly,
- natural,
- accurate,
- technically useful,
- transparent that it is AI when appropriate,
- capable of handing off to a human agent.

The assistant should answer questions about:

- available properties,
- requirements,
- rent,
- features,
- location,
- showing availability,
- basic process questions.

The assistant should avoid giving legal, financial, or regulated advice beyond approved scripts. When needed, it should hand off to a human.

## Primary Business Goal

The product should reduce manual message and call handling for property managers and brokers.

At this node, the assistant should:

- qualify the lead,
- answer common and property-specific questions,
- increase confidence,
- capture useful lead context,
- move the prospect toward booking a showing,
- preserve a clean handoff path to a human.

The existing Leads module is the starting point. It should be enriched with information collected during onboarding and with conversation context from each channel.

## Open Questions

1. What should the assistant disclose at the beginning of a voice call versus later in the conversation?
2. Should voice calls be real-time only, callback-request only, or both?
3. What exact human handoff rules should trigger escalation?
4. What Canadian or BC-specific leasing information must always be included or avoided?
5. Should Obsidian be integrated directly, or should the app maintain structured data and publish/sync markdown to Obsidian?
6. How much personality should be configurable per broker/property manager?
7. What information is mandatory before a property can be published to the assistant?
8. What should the first version of the onboarding form ask step by step?

## Suggested Next Product Work

1. Define the onboarding flow for broker/property manager knowledge capture.
2. Design the assistant knowledge model for company, policies, and property data.
3. Decide the Obsidian integration strategy.
4. Define the multi-channel conversation architecture.
5. Add lead enrichment fields driven by onboarding and conversations.
6. Prototype the first channel end to end, likely website chat.
7. Evaluate voice providers separately before committing to implementation.

## Updated Channel Decision

The first real channels should be implemented in this order:

1. Telegram.
2. WhatsApp.
3. Voice.

Voice provider research is tracked separately in `docs/VOICE_PROVIDER_RESEARCH.md`.
