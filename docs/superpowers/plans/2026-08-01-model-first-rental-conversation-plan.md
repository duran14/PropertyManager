# Modelo primero para conversaciones de renta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Reemplazar la calificación secuencial por un intérprete de conversación modelo-primero que conserva y corrige contexto y mantiene las reservas protegidas por validaciones deterministas.

**Architecture:** Se dividirá el chatbot en un contrato semántico, un intérprete con contexto, un aplicador transaccional de perfil y un orquestador de acciones. El modelo interpreta lenguaje libre; el backend compone datos factuales y es la única capa que consulta inventario o agenda visitas.

**Tech Stack:** TypeScript, Prisma, Zod, Vitest, GLM adapter y ShowMojo adapter.

## Global Constraints

- El modelo interpreta todos los turnos de renta salvo "/start" y una selección numérica de un horario pendiente.
- Ante incertidumbre, el bot hace una única pregunta breve y no muta el campo ambiguo.
- El modelo no ejecuta acciones externas; inventario, shortlist, horarios y reservas se validan contra datos reales en el backend.
- Las actualizaciones de perfil aplican "clear" antes de "set" y preservan campos no mencionados.
- Las reservas sólo ocurren con una unidad seleccionada y un índice que pertenezca a los horarios pendientes.
- "ConversationState" y las claves existentes de "conversation_slots" se mantienen durante la migración.
- No añadir dependencias de IA; reutilizar "GlmAdapter.reason" y "responseSchema".

---

### Task 1: Crear el contrato semántico y el validador de perfil

**Files:**
- Create: "apps/api/src/services/rental-conversation.types.ts"
- Create: "apps/api/src/services/rental-conversation.types.test.ts"

**Interfaces:**
- Consumes: JSON de "GlmAdapter.reason".
- Produces: "RentalProfile", "RentalProfileField", "ConversationTurn", "parseConversationTurn" y "normalizeRentalProfilePatch".

- [ ] **Step 1: Write the failing tests**

~~~
expect(parseConversationTurn({
  reply: 'Got it.', intent: 'discover', confidence: 'high',
  profile: { set: { prospect_name: 'Carlos', bedrooms: '2', pets: 'DOGS' }, clear: [] },
})).toMatchObject({ profile: { set: { prospect_name: 'Carlos', bedrooms: '2', pets: 'dog' } } });

expect(() => parseConversationTurn({
  reply: 'x', intent: 'discover', confidence: 'high',
  profile: { set: { made_up_field: 'x' }, clear: [] },
})).toThrow(/profile/i);
~~~

- [ ] **Step 2: Run test to verify it fails**

Run: "corepack pnpm --filter @property-manager/api test -- rental-conversation.types.test.ts"

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the exact contract**

~~~
export type RentalProfileField =
  | 'prospect_name' | 'transaction_intent' | 'preferred_area' | 'preferred_province'
  | 'bedrooms' | 'bedrooms_min' | 'bedrooms_max' | 'pets' | 'budget'
  | 'occupants' | 'move_in_date';
export type RentalProfile = Partial<Record<RentalProfileField, string>>;
export type ConversationTurn = {
  reply: string;
  intent: 'discover' | 'compare' | 'select_unit' | 'request_tour' | 'choose_slot' | 'handoff' | 'other';
  confidence: 'high' | 'low';
  clarification?: { question: string; field?: RentalProfileField };
  profile: { set: RentalProfile; clear: RentalProfileField[] };
  selection?: { unitIds?: string[]; slotIndex?: number };
};
export function parseConversationTurn(value: unknown): ConversationTurn;
export function normalizeRentalProfilePatch(input: ConversationTurn['profile']): ConversationTurn['profile'];
~~~

Use Zod with ".strict()" for "profile.set". Trim strings, normalize "DOGS" to "dog", and reject keys or enum values outside the contract.

- [ ] **Step 4: Run test to verify it passes**

Run: "corepack pnpm --filter @property-manager/api test -- rental-conversation.types.test.ts"

Expected: PASS.

- [ ] **Step 5: Commit**

~~~
git add apps/api/src/services/rental-conversation.types.ts apps/api/src/services/rental-conversation.types.test.ts
git commit -m "feat: add semantic rental conversation contract"
~~~

### Task 2: Interpretar cada mensaje con contexto del modelo

**Files:**
- Create: "apps/api/src/services/rental-conversation.interpreter.ts"
- Create: "apps/api/src/services/rental-conversation.interpreter.test.ts"
- Modify: "apps/api/src/services/chatbot.service.ts:1231-1310"

**Interfaces:**
- Consumes: "GlmAdapter", historial, "RentalProfile", "AvailableUnit" y conocimiento del tenant.
- Produces: "ConversationContext", "buildRentalConversationPrompt" e "interpretRentalTurn".

- [ ] **Step 1: Write the failing tests**

~~~
expect(buildRentalConversationPrompt(context)).toContain('Corrections replace only the contradicted field');
expect(buildRentalConversationPrompt(context)).toContain('Ask one short clarification question');
expect(context.visibleUnits[0]).toMatchObject({ id: 'unit-410', city: 'Burnaby' });
~~~

Add a malformed-JSON adapter response test that expects a low-confidence clarification with an empty profile patch.

- [ ] **Step 2: Run test to verify it fails**

Run: "corepack pnpm --filter @property-manager/api test -- rental-conversation.interpreter.test.ts"

Expected: FAIL because the interpreter module does not exist.

- [ ] **Step 3: Implement the interpreter boundary**

~~~
export type ConversationContext = {
  tenantName: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  profile: RentalProfile;
  selectedUnitId?: string;
  pendingSlotCount: number;
  visibleUnits: AvailableUnit[];
  knowledgeContext: string;
};
export function buildRentalConversationPrompt(context: ConversationContext): string;
export async function interpretRentalTurn(input: {
  glm: GlmAdapter; context: ConversationContext; message: string;
}): Promise<ConversationTurn>;
~~~

Pass the strict "ConversationTurn" JSON schema to "glm.reason". Instruct the model to recognize corrections such as "sorry Carlos", preserve uncontradicted facts, return "confidence: low" with one clarification when uncertain, and never invent a unit ID or slot index. Convert malformed JSON, validation errors and provider failures to this safe turn:

~~~
{ reply: 'Could you clarify that in one sentence?', intent: 'other', confidence: 'low',
  clarification: { question: 'Could you clarify that in one sentence?' },
  profile: { set: {}, clear: [] } }
~~~

- [ ] **Step 4: Run test to verify it passes**

Run: "corepack pnpm --filter @property-manager/api test -- rental-conversation.interpreter.test.ts"

Expected: PASS, including malformed JSON and correction prompt cases.

- [ ] **Step 5: Commit**

~~~
git add apps/api/src/services/rental-conversation.interpreter.ts apps/api/src/services/rental-conversation.interpreter.test.ts apps/api/src/services/chatbot.service.ts
git commit -m "feat: interpret rental messages with model context"
~~~

### Task 3: Aplicar correcciones de perfil sin perder contexto

**Files:**
- Create: "apps/api/src/services/rental-conversation.context.ts"
- Create: "apps/api/src/services/rental-conversation.context.test.ts"
- Modify: "apps/api/src/services/chatbot.service.ts:846-885"

**Interfaces:**
- Consumes: "ConversationTurn.profile", "conversationId", "tenantId" y "leadId".
- Produces: "applyRentalProfilePatch" y un "RentalProfile" fusionado.

- [ ] **Step 1: Write the failing tests**

~~~
const updated = await applyRentalProfilePatch({
  tx, tenantId: 'tenant-1', conversationId: 'conv-1', leadId: 'lead-1',
  patch: { set: { prospect_name: 'Carlos' }, clear: [] },
});
expect(updated).toMatchObject({ prospect_name: 'Carlos', preferred_area: 'Burnaby' });
~~~

Add a second test with "clear: ['preferred_area']" plus "set: { preferred_area: 'Richmond' }" and assert that only Richmond remains.

- [ ] **Step 2: Run test to verify it fails**

Run: "corepack pnpm --filter @property-manager/api test -- rental-conversation.context.test.ts"

Expected: FAIL because "applyRentalProfilePatch" does not exist.

- [ ] **Step 3: Implement transactional application**

~~~
export async function applyRentalProfilePatch(input: {
  tx: Prisma.TransactionClient;
  tenantId: string;
  conversationId: string;
  leadId?: string | null;
  patch: ConversationTurn['profile'];
}): Promise<RentalProfile>;
~~~

Delete "clear" keys from "conversation_slots" before upserting normalized "set" keys. Treat those slots as the canonical rental profile during this migration. Update only "Lead.name" when "prospect_name" changes; the current Lead schema has no columns for budget, move-in date, pets or area. Read the resulting slots in the same transaction and return them as "RentalProfile".

- [ ] **Step 4: Run test to verify it passes**

Run: "corepack pnpm --filter @property-manager/api test -- rental-conversation.context.test.ts"

Expected: PASS; a name correction never clears an unrelated area.

- [ ] **Step 5: Commit**

~~~
git add apps/api/src/services/rental-conversation.context.ts apps/api/src/services/rental-conversation.context.test.ts apps/api/src/services/chatbot.service.ts
git commit -m "feat: apply rental profile changes transactionally"
~~~

### Task 4: Orquestar inventario, selección y reserva con datos reales

**Files:**
- Create: "apps/api/src/services/rental-conversation.actions.ts"
- Create: "apps/api/src/services/rental-conversation.actions.test.ts"
- Modify: "apps/api/src/services/chatbot.service.ts:895-1098"
- Test: "apps/api/src/services/scheduling.service.test.ts"

**Interfaces:**
- Consumes: "ConversationTurn", "RentalProfile", "AvailableUnit", shortlist activa, "getAvailableSlots" y "scheduleTour".
- Produces: "executeRentalConversationAction" y resultados de acción factuales.

- [ ] **Step 1: Write the failing tests**

~~~
expect(result.kind).toBe('recommendations');
expect(result.units.map((unit) => unit.id)).toEqual(['unit_burnaby_410']);
expect(invalidSelection.reply).toMatch(/which option/i);
expect(noUnit.reply).toBe('Which property would you like to visit?');
expect(scheduleTour).not.toHaveBeenCalled();
~~~

Cover a free-form discovery turn, a unit absent from the active shortlist, a tour request without selection, an invalid slot index, and a valid selected pending slot.

- [ ] **Step 2: Run test to verify it fails**

Run: "corepack pnpm --filter @property-manager/api test -- rental-conversation.actions.test.ts"

Expected: FAIL because the action orchestrator does not exist.

- [ ] **Step 3: Implement the action boundary**

~~~
export type RentalActionResult =
  | { kind: 'reply'; reply: string; state: ConversationState; selectedUnitId?: string }
  | { kind: 'recommendations'; state: 'proposing_tour'; units: AvailableUnit[]; selectedUnitId?: string }
  | { kind: 'clarification'; reply: string; state: ConversationState; selectedUnitId?: string };
export async function executeRentalConversationAction(input: {
  tenantId: string; conversationId: string; state: ConversationState;
  turn: ConversationTurn; profile: RentalProfile; availableUnits: AvailableUnit[];
  activeShortlist?: { id: string; unitIds: string[]; selectedUnitId: string | null } | null;
}): Promise<RentalActionResult>;
~~~

For "discover", call existing inventory filters and ranking, then persist the top three through "createShortlist". For "select_unit", accept only IDs present in the active shortlist. For "request_tour", require a selected unit, retrieve at most six real slots and store existing "pending_slots" and "scheduling_unit_id". For "choose_slot", require an integer index in those pending slots before calling "scheduleTour". Low confidence, unknown units and invalid indices return one short clarification without creating a showing.

- [ ] **Step 4: Run tests to verify they pass**

Run:

~~~
corepack pnpm --filter @property-manager/api test -- rental-conversation.actions.test.ts
corepack pnpm --filter @property-manager/api test -- scheduling.service.test.ts
~~~

Expected: PASS; every listing and slot comes from operational data.

- [ ] **Step 5: Commit**

~~~
git add apps/api/src/services/rental-conversation.actions.ts apps/api/src/services/rental-conversation.actions.test.ts apps/api/src/services/chatbot.service.ts apps/api/src/services/scheduling.service.test.ts
git commit -m "feat: orchestrate model-driven rental actions safely"
~~~

### Task 5: Migrar "handleInboundMessage" y cubrir Telegram–broker

**Files:**
- Modify: "apps/api/src/services/chatbot.service.ts"
- Modify: "apps/api/src/services/chatbot.service.test.ts"
- Modify: "apps/api/src/services/conversation-transcripts.test.ts"
- Modify: "docs/DEMO_CHECKLIST.md"

**Interfaces:**
- Consumes: modules produced in Tasks 1–4.
- Produces: existing "handleInboundMessage" and "BotReply" contracts backed by the semantic pipeline.

- [ ] **Step 1: Write the failing end-to-end tests**

~~~
await send('I am Carlops and need 2 bedrooms in Burnaby, dog, up to 3500, September');
await send('sorry Carlos');
expect(await slotsFor(conversationId)).toMatchObject({ prospect_name: 'Carlos', preferred_area: 'Burnaby' });
expect(transcript('ambiguous-selection').final.reply).toMatch(/which option/i);
expect(transcript('invalid-slot').showings).toHaveLength(0);
~~~

Add a scripted GLM adapter to test profile correction, focused property questions, unit selection, tour request and a valid slot. Assert that "Lead.unitId", "ChatConversation.unitId" and "Showing.unitId" agree after booking.

- [ ] **Step 2: Run test to verify it fails**

Run:

~~~
corepack pnpm --filter @property-manager/api test -- chatbot.service.test.ts
corepack pnpm --filter @property-manager/api test -- conversation-transcripts.test.ts
~~~

Expected: FAIL because normal text still takes the legacy deterministic fast path.

- [ ] **Step 3: Integrate and remove the legacy priority**

Keep "/start", message serialization, delivery retry and post-tour acknowledgements in "handleInboundMessageUnlocked". For every other rental turn: build context, call "interpretRentalTurn", apply the profile patch in a Prisma transaction, then call "executeRentalConversationAction". Compose property cards and tour times exclusively from action results. Keep "buildFastQualificationTurn" only as a provider-outage fallback; remove its use as the normal "deterministicResult".

Update "DEMO_CHECKLIST.md" with this exact manual scenario: "I’m Carlos, 2 bedrooms in Burnaby, dog, $3500, September"; "actually Carlos"; select a property, request a tour, select a slot and verify the broker confirmation.

- [ ] **Step 4: Run tests to verify they pass**

Run:

~~~
corepack pnpm -r --filter "./packages/**" run typecheck
corepack pnpm -r --filter "./apps/**" run typecheck
corepack pnpm -r run test
git diff --check
~~~

Expected: every workspace typecheck and test passes, and the diff has no whitespace errors.

- [ ] **Step 5: Perform manual Telegram and broker QA**

With local API and Vite running, execute the documented Telegram scenario against "@PropertyManagerCanada_bot". Confirm the corrected lead and selected unit in the broker app, then intentionally confirm the pending showing and verify the card changes to Confirmed. Do not click Confirm before the manual flow reaches that action.

- [ ] **Step 6: Commit**

~~~
git add apps/api/src/services/chatbot.service.ts apps/api/src/services/chatbot.service.test.ts apps/api/src/services/conversation-transcripts.test.ts docs/DEMO_CHECKLIST.md
git commit -m "refactor: run rental chat through semantic turns"
~~~
