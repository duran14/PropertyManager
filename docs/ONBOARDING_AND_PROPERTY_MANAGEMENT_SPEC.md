# Onboarding and Property Management Spec

This document turns the buyer journey decisions into an implementation-ready product spec. The app remains the source of truth. Obsidian is a synced and searchable knowledge layer.

## Product Principle

Onboarding and ongoing property management are separate experiences.

- Onboarding teaches the system about the company, brand, services, pricing, operating rules, and compliance posture.
- Property management is the day-to-day area where authorized users continuously add, update, publish, and retire properties.

## Roles

The following roles should access onboarding and property management, with different permissions:

- Broker: full approval, compliance, publishing, and handoff settings.
- Property Manager: full operational editing and publishing, subject to broker rules.
- Bookkeeper: pricing, fees, deposits, reconciliation-relevant property metadata.
- Assistant: data entry and draft preparation, no final compliance approval unless configured.

## Onboarding Wizard

### Step 1: Company Profile

Collect:

- legal company name,
- public brand name,
- logo and brand assets,
- website and social links,
- primary service areas,
- broker or manager contact information,
- emergency contact workflow,
- preferred brand tone.

Output:

- `company_profile`,
- brand asset records,
- first Obsidian markdown export for the company overview.

### Step 2: Services and Pricing

Collect:

- services offered,
- pricing sheets,
- management fees,
- leasing fees,
- tenant-facing fees,
- deposits and application-related costs,
- payment instructions,
- special conditions or exceptions.

Uploads:

- PDFs,
- spreadsheets,
- screenshots,
- existing price sheets.

Output:

- structured pricing records,
- source document records,
- bot-safe pricing summary.

### Step 3: Policies and Compliance

Collect:

- pet policy,
- smoking policy,
- occupancy rules,
- income or screening requirements,
- showing policy,
- application process,
- required disclosures,
- prohibited statements,
- escalation rules,
- jurisdiction notes for Canada and British Columbia.

Output:

- policy records,
- compliance guardrails for assistant prompts,
- human handoff rules.

### Step 4: Communication Preferences

Collect:

- assistant personality settings,
- greeting style,
- AI disclosure wording,
- preferred response length,
- languages supported,
- office hours,
- after-hours behavior,
- handoff contacts,
- channel priority.

Output:

- assistant profile,
- channel routing defaults,
- disclosure script.

### Step 5: Initial Property Import

Collect or upload:

- property list,
- unit list,
- photos,
- addresses,
- rent,
- availability,
- amenities,
- parking/storage,
- utilities,
- pet rules per unit,
- neighborhood notes,
- showing instructions.

Output:

- draft property and unit records,
- validation report,
- missing-information checklist.

### Step 6: Knowledge Review

Show a review screen:

- what the assistant knows,
- what is missing,
- what is approved,
- what is still draft,
- which source documents support each answer.

Output:

- approved knowledge base snapshot,
- Obsidian markdown export,
- assistant readiness score.

### Step 7: Channel Activation

Activation should be staged:

1. Telegram.
2. SMS through Twilio.
3. WhatsApp.
4. Voice.

Each channel should require:

- test message,
- channel-specific disclosure,
- human handoff path,
- logging enabled,
- broker or manager approval.

## Ongoing Property Management Area

This is separate from onboarding.

Core views:

- Properties list.
- Property detail.
- Unit detail.
- Photo manager.
- Pricing and availability.
- Amenities and features.
- Compliance checklist.
- Publish status.
- Assistant knowledge preview.

Required states:

- Draft.
- Needs review.
- Approved.
- Published to assistant.
- Archived.

Required actions:

- add property,
- add unit,
- upload photos,
- edit pricing,
- edit availability,
- attach source documents,
- request review,
- approve for assistant,
- publish to channels,
- archive property or unit.

## Required Property Data Model

At minimum, each property/unit needs:

- property name,
- full address,
- city,
- province,
- postal code,
- unit name or number,
- rent,
- currency,
- bedrooms,
- bathrooms,
- square footage when available,
- availability date,
- deposit details,
- pet policy,
- parking,
- storage,
- utilities,
- laundry,
- accessibility notes,
- amenities,
- photos,
- showing instructions,
- application requirements,
- compliance notes,
- source documents.

## Assistant Knowledge Preview

Before publishing a property to channels, the app should show:

- sample prospect questions,
- assistant draft answers,
- source citations or source labels,
- missing data warnings,
- legal/compliance warnings,
- handoff triggers.

## Obsidian Sync Strategy

The app is the source of truth.

Obsidian receives generated markdown from structured app data. The markdown should be readable by humans and useful for search/retrieval.

Suggested vault structure:

```text
PropertyManager/
  Company/
    Overview.md
    Services.md
    Pricing.md
    Policies.md
    Communication.md
  Properties/
    <property-slug>/
      Overview.md
      Units/
        <unit-slug>.md
      Photos.md
      Compliance.md
      ShowingInstructions.md
  Channels/
    Telegram.md
    SMS.md
    WhatsApp.md
    Voice.md
  Handoff/
    Rules.md
    Contacts.md
```

Sync modes to evaluate:

- export markdown files to a configured local vault path,
- push markdown to a Git-backed vault,
- store generated markdown in the database and allow download,
- later integrate with an Obsidian plugin if needed.

## MVP Scope

First implementation should focus on:

1. Company profile onboarding.
2. Policy/pricing/document upload.
3. Property and unit management area.
4. Assistant knowledge preview.
5. Markdown export format.
6. Telegram-ready assistant knowledge.

Out of scope for first implementation:

- production voice,
- final Obsidian plugin,
- full document OCR,
- automated legal compliance decisions,
- real WhatsApp templates,
- real phone-call routing.
