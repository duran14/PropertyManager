# Restaurar y extender "modelo primero" para el chatbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hacer que el modelo real (GLM-5.2) sea el intérprete principal de cada turno de conversación de renta y de compra/venta, dejando el motor determinista actual como red de seguridad solo ante fallo del proveedor — resolviendo por qué el bot se siente "cuadrado".

**Architecture:** Para renta: resucitar sin cambios `rental-conversation.{types,interpreter,context}.ts` (probados en el commit revertido `4551eae`) y cablearlos en `chatbot.service.ts` reemplazando el cuerpo de `callGlm` para que llame al intérprete y traduzca su resultado (`ConversationTurn`) al formato legado `InterpretedTurn` que el pipeline de recomendaciones/shortlist/reservas actual ya sabe consumir sin cambios. Para compra/venta: mismo patrón, código nuevo (sin action-executor, porque ese flujo no reserva nada ni recomienda inventario).

**Tech Stack:** TypeScript, Prisma, Zod, Vitest, `GlmAdapter` (`packages/adapters`).

## Global Constraints

- El modelo interpreta todos los turnos de renta y compra/venta ya iniciados, salvo `/start` y el turno inicial de "¿renta, compra o venta?" antes de que exista `transaction_intent`.
- Ante confianza baja (`confidence: 'low'`), nunca se muta el perfil ni se ejecuta ninguna acción — solo se responde con la aclaración.
- Ninguna selección de unidad o slot de tour inventada por el modelo se acepta nunca; se trata igual que un fallo del proveedor.
- **No se resucita `rental-conversation.actions.ts`** — ver spec (`docs/superpowers/specs/2026-08-03-chatbot-model-first-restore-design.md`) para la justificación completa. El pipeline de recomendaciones/shortlist/reservas de `chatbot.service.ts` no cambia.
- Cada tarea deja `pnpm --filter @property-manager/api test` y `pnpm --filter @property-manager/api typecheck` en verde antes de pasar a la siguiente.
- Ejecutar todos los comandos de test/typecheck desde la raíz del repo: `C:\Users\duran\Documents\Proyectos IA\ZCodeProject\Property Manager`.

---

### Task 1: Resucitar el contrato semántico de renta

**Files:**
- Create: `apps/api/src/services/rental-conversation.types.ts`
- Create: `apps/api/src/services/rental-conversation.types.test.ts`

**Interfaces:**
- Consumes: nada (capa base).
- Produces: `RentalProfileField`, `RentalProfile`, `ConversationTurn`, `parseConversationTurn(value: unknown): ConversationTurn`, `normalizeRentalProfilePatch(input: ConversationTurn['profile']): ConversationTurn['profile']`.

- [ ] **Step 1: Escribir el archivo de implementación exacto**

```ts
import { z } from 'zod';

export type RentalProfileField =
  | 'prospect_name'
  | 'transaction_intent'
  | 'preferred_area'
  | 'preferred_province'
  | 'bedrooms'
  | 'bedrooms_min'
  | 'bedrooms_max'
  | 'pets'
  | 'budget'
  | 'occupants'
  | 'move_in_date';

export type RentalProfile = Partial<Record<RentalProfileField, string>>;

export type ConversationTurn = {
  reply: string;
  intent: 'discover' | 'compare' | 'select_unit' | 'request_tour' | 'choose_slot' | 'handoff' | 'other';
  confidence: 'high' | 'low';
  clarification?: { question: string; field?: RentalProfileField };
  profile: { set: RentalProfile; clear: RentalProfileField[] };
  selection?: { unitIds?: string[]; slotIndex?: number };
};

const rentalProfileFieldSchema = z.enum([
  'prospect_name',
  'transaction_intent',
  'preferred_area',
  'preferred_province',
  'bedrooms',
  'bedrooms_min',
  'bedrooms_max',
  'pets',
  'budget',
  'occupants',
  'move_in_date',
]);

const normalizedStringSchema = z.string().transform((value) => value.trim());
const petsSchema = normalizedStringSchema.transform((value) => (
  value.toLowerCase() === 'dogs' ? 'dog' : value
));

const rentalProfileSchema = z.object({
  prospect_name: normalizedStringSchema.optional(),
  transaction_intent: normalizedStringSchema.optional(),
  preferred_area: normalizedStringSchema.optional(),
  preferred_province: normalizedStringSchema.optional(),
  bedrooms: normalizedStringSchema.optional(),
  bedrooms_min: normalizedStringSchema.optional(),
  bedrooms_max: normalizedStringSchema.optional(),
  pets: petsSchema.optional(),
  budget: normalizedStringSchema.optional(),
  occupants: normalizedStringSchema.optional(),
  move_in_date: normalizedStringSchema.optional(),
}).strict();

const rentalProfilePatchSchema = z.object({
  set: rentalProfileSchema,
  clear: z.array(rentalProfileFieldSchema),
}).strict();

const conversationTurnSchema = z.object({
  reply: normalizedStringSchema,
  intent: z.enum(['discover', 'compare', 'select_unit', 'request_tour', 'choose_slot', 'handoff', 'other']),
  confidence: z.enum(['high', 'low']),
  clarification: z.object({
    question: normalizedStringSchema,
    field: rentalProfileFieldSchema.optional(),
  }).strict().optional(),
  profile: rentalProfilePatchSchema,
  selection: z.object({
    unitIds: z.array(normalizedStringSchema).optional(),
    slotIndex: z.number().int().optional(),
  }).strict().optional(),
}).strict();

export function parseConversationTurn(value: unknown): ConversationTurn {
  return conversationTurnSchema.parse(value);
}

export function normalizeRentalProfilePatch(
  input: ConversationTurn['profile'],
): ConversationTurn['profile'] {
  return rentalProfilePatchSchema.parse(input);
}
```

- [ ] **Step 2: Escribir el test exacto**

```ts
import { describe, expect, it } from 'vitest';

import {
  normalizeRentalProfilePatch,
  parseConversationTurn,
} from './rental-conversation.types.js';

describe('parseConversationTurn', () => {
  it('trims profile values and normalizes a dog preference', () => {
    expect(parseConversationTurn({
      reply: 'Got it.',
      intent: 'discover',
      confidence: 'high',
      profile: {
        set: { prospect_name: ' Carlos ', bedrooms: ' 2 ', pets: 'DOGS' },
        clear: [],
      },
    })).toMatchObject({
      profile: { set: { prospect_name: 'Carlos', bedrooms: '2', pets: 'dog' } },
    });
  });

  it('rejects profile updates for fields outside the contract', () => {
    expect(() => parseConversationTurn({
      reply: 'x',
      intent: 'discover',
      confidence: 'high',
      profile: { set: { made_up_field: 'x' }, clear: [] },
    })).toThrow(/profile/i);
  });

  it('rejects intent values outside the contract', () => {
    expect(() => parseConversationTurn({
      reply: 'x',
      intent: 'invent',
      confidence: 'high',
      profile: { set: {}, clear: [] },
    })).toThrow();
  });
});

describe('normalizeRentalProfilePatch', () => {
  it('normalizes profile values without changing declared fields to clear', () => {
    expect(normalizeRentalProfilePatch({
      set: { pets: 'DOGS', budget: ' 2500 ' },
      clear: ['move_in_date'],
    })).toEqual({
      set: { pets: 'dog', budget: '2500' },
      clear: ['move_in_date'],
    });
  });
});
```

- [ ] **Step 3: Correr los tests**

Run: `pnpm --filter @property-manager/api test -- rental-conversation.types.test.ts`
Expected: PASS (3 tests en `parseConversationTurn`, 1 en `normalizeRentalProfilePatch`).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @property-manager/api typecheck`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/rental-conversation.types.ts apps/api/src/services/rental-conversation.types.test.ts
git commit -m "feat: restore semantic rental conversation contract"
```

---

### Task 2: Resucitar el aplicador transaccional de perfil

**Files:**
- Create: `apps/api/src/services/rental-conversation.context.ts`
- Create: `apps/api/src/services/rental-conversation.context.test.ts`

**Interfaces:**
- Consumes: `ConversationTurn['profile']` (Task 1), `Prisma.TransactionClient`.
- Produces: `applyRentalProfilePatch(input: {tx, tenantId, conversationId, leadId?, patch}): Promise<RentalProfile>`.

- [ ] **Step 1: Escribir el archivo de implementación exacto**

```ts
import type { Prisma } from '@prisma/client';
import {
  normalizeRentalProfilePatch,
  type ConversationTurn,
  type RentalProfile,
  type RentalProfileField,
} from './rental-conversation.types.js';

const rentalProfileFields: RentalProfileField[] = [
  'prospect_name',
  'transaction_intent',
  'preferred_area',
  'preferred_province',
  'bedrooms',
  'bedrooms_min',
  'bedrooms_max',
  'pets',
  'budget',
  'occupants',
  'move_in_date',
];

export async function applyRentalProfilePatch(input: {
  tx: Prisma.TransactionClient;
  tenantId: string;
  conversationId: string;
  leadId?: string | null;
  patch: ConversationTurn['profile'];
}): Promise<RentalProfile> {
  const patch = normalizeRentalProfilePatch(input.patch);

  if (patch.clear.length > 0) {
    await input.tx.conversationSlot.deleteMany({
      where: {
        conversationId: input.conversationId,
        key: { in: patch.clear },
      },
    });
  }

  for (const [key, value] of Object.entries(patch.set)) {
    await input.tx.conversationSlot.upsert({
      where: {
        conversationId_key: {
          conversationId: input.conversationId,
          key,
        },
      },
      update: { value },
      create: {
        conversationId: input.conversationId,
        key,
        value,
      },
    });
  }

  const correctedName = patch.set.prospect_name
    ?? (patch.clear.includes('prospect_name') ? null : undefined);
  if (input.leadId && correctedName !== undefined) {
    await input.tx.lead.updateMany({
      where: { id: input.leadId, tenantId: input.tenantId },
      data: { name: correctedName },
    });
  }

  const finalSlots = await input.tx.conversationSlot.findMany({
    where: {
      conversationId: input.conversationId,
      key: { in: rentalProfileFields },
    },
    select: { key: true, value: true },
  });

  return finalSlots.reduce<RentalProfile>((profile: RentalProfile, slot: { key: string; value: string }) => {
    profile[slot.key as RentalProfileField] = slot.value;
    return profile;
  }, {});
}
```

- [ ] **Step 2: Escribir el test exacto**

```ts
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { applyRentalProfilePatch } from './rental-conversation.context.js';

function rentalProfileTransaction(initialSlots: Record<string, string>) {
  const slots = new Map(Object.entries(initialSlots));
  let leadName: string | null = 'Carlops';

  const tx = {
    conversationSlot: {
      deleteMany: vi.fn(async ({ where }: {
        where: { conversationId: string; key: { in: string[] } };
      }) => {
        let count = 0;
        for (const key of where.key.in) {
          if (slots.delete(key)) count += 1;
        }
        return { count };
      }),
      upsert: vi.fn(async ({ where, update }: {
        where: { conversationId_key: { conversationId: string; key: string } };
        update: { value: string };
      }) => {
        const { key } = where.conversationId_key;
        slots.set(key, update.value);
        return { key, value: update.value };
      }),
      findMany: vi.fn(async () => (
        [...slots].map(([key, value]) => ({ key, value }))
      )),
    },
    lead: {
      updateMany: vi.fn(async ({ data }: { data: { name: string | null } }) => {
        leadName = data.name;
        return { count: 1 };
      }),
    },
  } as unknown as Prisma.TransactionClient;

  return { tx, getLeadName: () => leadName };
}

describe('applyRentalProfilePatch', () => {
  it('corrects the prospect name without losing the preferred area', async () => {
    const db = rentalProfileTransaction({
      prospect_name: 'Carlops',
      preferred_area: 'Burnaby',
    });

    const profile = await applyRentalProfilePatch({
      tx: db.tx,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      leadId: 'lead-1',
      patch: { set: { prospect_name: 'Carlos' }, clear: [] },
    });

    expect(profile).toEqual({
      prospect_name: 'Carlos',
      preferred_area: 'Burnaby',
    });
    expect(db.getLeadName()).toBe('Carlos');
  });

  it('applies set values after clears when both target the same field', async () => {
    const db = rentalProfileTransaction({
      prospect_name: 'Carlops',
      preferred_area: 'Burnaby',
    });

    const profile = await applyRentalProfilePatch({
      tx: db.tx,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      patch: {
        clear: ['preferred_area'],
        set: { preferred_area: 'Richmond' },
      },
    });

    expect(profile).toEqual({
      prospect_name: 'Carlops',
      preferred_area: 'Richmond',
    });
  });
});
```

- [ ] **Step 3: Correr los tests**

Run: `pnpm --filter @property-manager/api test -- rental-conversation.context.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @property-manager/api typecheck`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/rental-conversation.context.ts apps/api/src/services/rental-conversation.context.test.ts
git commit -m "feat: restore transactional rental profile patch application"
```

---

### Task 3: Resucitar el intérprete semántico de renta

**Files:**
- Create: `apps/api/src/services/rental-conversation.interpreter.ts`
- Create: `apps/api/src/services/rental-conversation.interpreter.test.ts`

**Interfaces:**
- Consumes: `GlmAdapter` (de `@property-manager/adapters`, ya existe), `AvailableUnit` (de `chatbot.service.ts`, ya existe), `ConversationTurn`/`parseConversationTurn` (Task 1).
- Produces: `ConversationContext`, `buildRentalConversationPrompt(context): string`, `interpretRentalTurn(input: {glm, context, message}): Promise<{turn: ConversationTurn; providerFailed: boolean}>`.

- [ ] **Step 1: Escribir el archivo de implementación exacto**

```ts
import type { GlmAdapter } from '@property-manager/adapters';
import type { AvailableUnit } from './chatbot.service.js';
import {
  parseConversationTurn,
  type ConversationTurn,
  type RentalProfile,
} from './rental-conversation.types.js';

export type ConversationContext = {
  tenantName: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  profile: RentalProfile;
  selectedUnitId?: string;
  pendingSlotCount: number;
  visibleUnits: AvailableUnit[];
  knowledgeContext: string;
};

const conversationTurnJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string' },
    intent: {
      type: 'string',
      enum: ['discover', 'compare', 'select_unit', 'request_tour', 'choose_slot', 'handoff', 'other'],
    },
    confidence: { type: 'string', enum: ['high', 'low'] },
    clarification: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string' },
        field: {
          type: 'string',
          enum: [
            'prospect_name',
            'transaction_intent',
            'preferred_area',
            'preferred_province',
            'bedrooms',
            'bedrooms_min',
            'bedrooms_max',
            'pets',
            'budget',
            'occupants',
            'move_in_date',
          ],
        },
      },
      required: ['question'],
    },
    profile: {
      type: 'object',
      additionalProperties: false,
      properties: {
        set: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prospect_name: { type: 'string' },
            transaction_intent: { type: 'string' },
            preferred_area: { type: 'string' },
            preferred_province: { type: 'string' },
            bedrooms: { type: 'string' },
            bedrooms_min: { type: 'string' },
            bedrooms_max: { type: 'string' },
            pets: { type: 'string' },
            budget: { type: 'string' },
            occupants: { type: 'string' },
            move_in_date: { type: 'string' },
          },
        },
        clear: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'prospect_name',
              'transaction_intent',
              'preferred_area',
              'preferred_province',
              'bedrooms',
              'bedrooms_min',
              'bedrooms_max',
              'pets',
              'budget',
              'occupants',
              'move_in_date',
            ],
          },
        },
      },
      required: ['set', 'clear'],
    },
    selection: {
      type: 'object',
      additionalProperties: false,
      properties: {
        unitIds: { type: 'array', items: { type: 'string' } },
        slotIndex: { type: 'integer' },
      },
    },
  },
  required: ['reply', 'intent', 'confidence', 'profile'],
};

const safeClarification: ConversationTurn = {
  reply: 'Could you clarify that in one sentence?',
  intent: 'other',
  confidence: 'low',
  clarification: { question: 'Could you clarify that in one sentence?' },
  profile: { set: {}, clear: [] },
};

export type InterpretRentalResult = {
  turn: ConversationTurn;
  providerFailed: boolean;
};

export function buildRentalConversationPrompt(context: ConversationContext): string {
  return [
    'Interpret the current rental conversation message and return only one JSON object matching the response schema.',
    'Use the conversation context as factual input. Do not claim that a tour, handoff, message, or data update has been executed.',
    'Corrections replace only the contradicted field. Recognize corrections such as "sorry Carlos" as a replacement for the previously supplied name.',
    'Preserve every uncontradicted fact already present in the profile and history.',
    "Ask one short clarification question when the user's meaning or reference is uncertain.",
    "When uncertain, return confidence: 'low', include exactly one clarification question, and leave the profile patch empty unless the fact is explicit.",
    'Use a unit ID only when it appears in selectedUnitId or visibleUnits. Use a slotIndex only from the pending slot range.',
    'Never invent a unit ID or slot index.',
    `Conversation context:\n${JSON.stringify({
      tenantName: context.tenantName,
      history: context.history,
      profile: context.profile,
      selectedUnitId: context.selectedUnitId ?? null,
      pendingSlotCount: context.pendingSlotCount,
      visibleUnits: context.visibleUnits,
      knowledgeContext: context.knowledgeContext,
    })}`,
  ].join('\n');
}

function hasValidSelection(turn: ConversationTurn, context: ConversationContext): boolean {
  const allowedUnitIds = new Set([
    ...context.visibleUnits.map((unit) => unit.id),
    ...(context.selectedUnitId ? [context.selectedUnitId] : []),
  ]);
  const unitIdsAreValid = turn.selection?.unitIds?.every((unitId) => allowedUnitIds.has(unitId)) ?? true;
  const slotIndex = turn.selection?.slotIndex;
  const slotIndexIsValid = slotIndex === undefined
    || (slotIndex >= 0 && slotIndex < context.pendingSlotCount);
  return unitIdsAreValid && slotIndexIsValid;
}

export async function interpretRentalTurn(input: {
  glm: GlmAdapter;
  context: ConversationContext;
  message: string;
}): Promise<InterpretRentalResult> {
  try {
    const response = await input.glm.reason({
      systemPrompt: buildRentalConversationPrompt(input.context),
      userPrompt: input.message,
      responseSchema: conversationTurnJsonSchema,
      temperature: 0.2,
    });
    const normalized = response.content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const turn = parseConversationTurn(JSON.parse(normalized));
    if (turn.confidence === 'low' && !turn.clarification) {
      return { turn: safeClarification, providerFailed: false };
    }
    if (turn.confidence === 'low') {
      return {
        turn: {
          reply: turn.reply,
          intent: turn.intent,
          confidence: 'low',
          clarification: turn.clarification,
          profile: { set: {}, clear: [] },
        },
        providerFailed: false,
      };
    }
    if (!hasValidSelection(turn, input.context)) {
      return { turn: safeClarification, providerFailed: false };
    }
    return { turn, providerFailed: false };
  } catch {
    return { turn: safeClarification, providerFailed: true };
  }
}
```

- [ ] **Step 2: Escribir el test exacto**

```ts
import type { GlmAdapter, GlmReasoningRequest } from '@property-manager/adapters';
import { describe, expect, it, vi } from 'vitest';
import type { AvailableUnit } from './chatbot.service.js';
import {
  buildRentalConversationPrompt,
  interpretRentalTurn,
  type ConversationContext,
} from './rental-conversation.interpreter.js';

const visibleUnit: AvailableUnit = {
  id: 'unit-410',
  name: 'Suite 410',
  rentCents: 245000,
  city: 'Burnaby',
  province: 'British Columbia',
  propertyName: 'Cedar House',
  address: '4100 Hastings Street',
  bedrooms: 2,
  bathrooms: 1,
  availableFrom: new Date('2026-09-01T00:00:00.000Z'),
  petPolicy: 'Cats allowed',
};

function conversationContext(): ConversationContext {
  return {
    tenantName: 'North Shore Rentals',
    history: [
      { role: 'user', content: 'My name is Carla and I need two bedrooms.' },
      { role: 'assistant', content: 'What area works for you?' },
    ],
    profile: { prospect_name: 'Carla', bedrooms: '2' },
    selectedUnitId: 'unit-410',
    pendingSlotCount: 3,
    visibleUnits: [visibleUnit],
    knowledgeContext: 'Tours require 24 hours notice.',
  };
}

function glmReturning(content: string): {
  glm: GlmAdapter;
  reason: ReturnType<typeof vi.fn<(request: GlmReasoningRequest) => Promise<{ content: string }>>>;
} {
  const reason = vi.fn(async (_request: GlmReasoningRequest) => ({ content }));
  return { glm: { name: 'glm', reason } as unknown as GlmAdapter, reason };
}

const safeClarification = {
  reply: 'Could you clarify that in one sentence?',
  intent: 'other',
  confidence: 'low',
  clarification: { question: 'Could you clarify that in one sentence?' },
  profile: { set: {}, clear: [] },
} as const;

describe('rental conversation interpreter', () => {
  it('preserves correction rules, short clarification guidance, and visible unit facts in the prompt', () => {
    const prompt = buildRentalConversationPrompt(conversationContext());

    expect(prompt).toContain('Corrections replace only the contradicted field');
    expect(prompt).toContain('Ask one short clarification question');
    expect(prompt).toContain('"id":"unit-410"');
    expect(prompt).toContain('"city":"Burnaby"');
  });

  it('requests a strict ConversationTurn schema and returns the validated model turn', async () => {
    const { glm, reason } = glmReturning(JSON.stringify({
      reply: 'Thanks Carlos. I kept your two-bedroom preference.',
      intent: 'discover',
      confidence: 'high',
      profile: { set: { prospect_name: 'Carlos' }, clear: [] },
    }));

    const result = await interpretRentalTurn({
      glm,
      context: conversationContext(),
      message: 'Sorry, Carlos.',
    });

    expect(result).toEqual({
      turn: {
        reply: 'Thanks Carlos. I kept your two-bedroom preference.',
        intent: 'discover',
        confidence: 'high',
        profile: { set: { prospect_name: 'Carlos' }, clear: [] },
      },
      providerFailed: false,
    });
    const request = reason.mock.calls[0]?.[0];
    expect(request?.userPrompt).toBe('Sorry, Carlos.');
    expect(request?.responseSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['reply', 'intent', 'confidence', 'profile'],
      properties: {
        profile: {
          type: 'object',
          additionalProperties: false,
          required: ['set', 'clear'],
        },
      },
    });
  });

  it('flags malformed JSON as a provider failure while returning the safe clarification', async () => {
    const { glm } = glmReturning('{not-json');

    await expect(interpretRentalTurn({
      glm,
      context: conversationContext(),
      message: 'Something else',
    })).resolves.toEqual({ turn: safeClarification, providerFailed: true });
  });

  it('removes profile and selection mutations from a low-confidence clarification', async () => {
    const { glm } = glmReturning(JSON.stringify({
      reply: 'Which option did you mean?',
      intent: 'select_unit',
      confidence: 'low',
      clarification: { question: 'Which option did you mean?' },
      profile: {
        set: { prospect_name: 'Carlos' },
        clear: ['budget'],
      },
      selection: { unitIds: ['unit-410'], slotIndex: 1 },
    }));

    await expect(interpretRentalTurn({
      glm,
      context: conversationContext(),
      message: 'That one, I think.',
    })).resolves.toEqual({
      turn: {
        reply: 'Which option did you mean?',
        intent: 'select_unit',
        confidence: 'low',
        clarification: { question: 'Which option did you mean?' },
        profile: { set: {}, clear: [] },
      },
      providerFailed: false,
    });
  });

  it('rejects a model-selected unit ID that is absent from the factual context', async () => {
    const { glm } = glmReturning(JSON.stringify({
      reply: 'I selected it.',
      intent: 'select_unit',
      confidence: 'high',
      profile: { set: {}, clear: [] },
      selection: { unitIds: ['invented-unit'] },
    }));

    await expect(interpretRentalTurn({
      glm,
      context: conversationContext(),
      message: 'The other unit.',
    })).resolves.toEqual({ turn: safeClarification, providerFailed: false });
  });

  it('rejects a model-selected slot index outside the pending slot range', async () => {
    const { glm } = glmReturning(JSON.stringify({
      reply: 'I selected that time.',
      intent: 'choose_slot',
      confidence: 'high',
      profile: { set: {}, clear: [] },
      selection: { slotIndex: 3 },
    }));

    await expect(interpretRentalTurn({
      glm,
      context: conversationContext(),
      message: 'The fourth time.',
    })).resolves.toEqual({ turn: safeClarification, providerFailed: false });
  });

  it('returns the same safe clarification turn for schema failures and provider failures, flagged as provider failures', async () => {
    const invalid = glmReturning(JSON.stringify({ reply: 'Incomplete' })).glm;
    const failing = {
      name: 'glm',
      reason: vi.fn(async () => { throw new Error('provider unavailable'); }),
    } as unknown as GlmAdapter;

    await expect(interpretRentalTurn({
      glm: invalid,
      context: conversationContext(),
      message: 'Incomplete response',
    })).resolves.toEqual({ turn: safeClarification, providerFailed: true });
    await expect(interpretRentalTurn({
      glm: failing,
      context: conversationContext(),
      message: 'Provider failure',
    })).resolves.toEqual({ turn: safeClarification, providerFailed: true });
  });
});
```

- [ ] **Step 3: Correr los tests**

Run: `pnpm --filter @property-manager/api test -- rental-conversation.interpreter.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @property-manager/api typecheck`
Expected: sin errores (`AvailableUnit` ganó campos opcionales nuevos desde el commit original — el fixture de arriba solo usa campos que siguen existiendo, así que no requiere ajuste).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/rental-conversation.interpreter.ts apps/api/src/services/rental-conversation.interpreter.test.ts
git commit -m "feat: restore rental conversation interpreter"
```

---

### Task 4: Cablear el intérprete de renta en `chatbot.service.ts`

**Files:**
- Modify: `apps/api/src/services/chatbot.service.ts` (imports en la cabecera; bloque de persistencia de perfil alrededor de la línea 826-885; función `callGlm` completa, línea ~1288 en adelante)
- Modify: `apps/api/src/services/chatbot.service.test.ts` (agregar un `describe` nuevo al final)

**Interfaces:**
- Consumes: `interpretRentalTurn`, `ConversationContext` (Task 3); `applyRentalProfilePatch` (Task 2); `ConversationTurn`, `RentalProfile`, `RentalProfileField` (Task 1).
- Produces: `resolveRentalTurnToInterpreted(input): InterpretedTurn` (exportada, para poder probarla sin tocar Prisma ni la red).

Antes de tocar código, leer con `Read` el archivo `apps/api/src/services/chatbot.service.ts` completo alrededor de las líneas 1-44 (imports), 826-885 (persistencia de slots) y 1280-1330 (función `callGlm` actual) para confirmar que los números de línea no se movieron desde que se escribió este plan (el archivo se edita en tareas previas de esta sesión — sección "parseCanadianLocation" ya fija — pero puede haber cambiado por otras razones).

- [ ] **Step 1: Escribir los tests nuevos (fallan porque `resolveRentalTurnToInterpreted` no existe)**

Agregar al final de `apps/api/src/services/chatbot.service.test.ts`, y añadir `resolveRentalTurnToInterpreted` al bloque de imports desde `./chatbot.service.js` (ya existente al inicio del archivo). `AvailableUnit` no está importado todavía en este archivo — agregar también estos dos imports nuevos:

```ts
import type { AvailableUnit } from './chatbot.service.js';
import type { ConversationTurn } from './rental-conversation.types.js';
```

```ts
const adapterBurnabyUnit: AvailableUnit = {
  id: 'unit_burnaby_410',
  name: 'Suite 410',
  rentCents: 275000,
  city: 'Burnaby',
  province: 'British Columbia',
  propertyName: 'Cedar House',
  address: '4100 Hastings Street',
  bedrooms: 2,
  bathrooms: 1,
  availableFrom: new Date('2026-09-01T00:00:00.000Z'),
  petPolicy: 'Pet friendly',
};

describe('resolveRentalTurnToInterpreted (semantic adapter mapping)', () => {
  function rentalTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
    return {
      reply: 'Got it.',
      intent: 'discover',
      confidence: 'high',
      profile: { set: {}, clear: [] },
      ...overrides,
    };
  }

  it('maps a name correction from the semantic turn into the legacy slots', () => {
    const result = resolveRentalTurnToInterpreted({
      turn: rentalTurn({
        reply: 'Thanks for the correction, Carlos.',
        intent: 'discover',
        profile: { set: { prospect_name: 'Carlos' }, clear: [] },
      }),
      providerFailed: false,
      currentState: 'collecting_budget',
      availableUnits: [adapterBurnabyUnit],
    });

    expect(result).toMatchObject({
      intent: 'provide_information',
      slots: { prospect_name: 'Carlos' },
    });
    expect(result.reply).toBe('Thanks for the correction, Carlos.');
  });

  it('filters a model-selected invented unit ID into a safe clarification', () => {
    const result = resolveRentalTurnToInterpreted({
      turn: rentalTurn({
        reply: 'Which option would you like?',
        intent: 'select_unit',
        selection: { unitIds: ['invented-unit'] },
      }),
      providerFailed: false,
      currentState: 'proposing_units',
      availableUnits: [adapterBurnabyUnit],
    });

    expect(result.selected_options).toBeUndefined();
  });

  it('maps a valid choose_slot turn to a confirm intent in the scheduling state', () => {
    const result = resolveRentalTurnToInterpreted({
      turn: rentalTurn({
        reply: 'I selected that time.',
        intent: 'choose_slot',
        selection: { slotIndex: 1 },
      }),
      providerFailed: false,
      currentState: 'scheduling',
      availableUnits: [adapterBurnabyUnit],
    });

    expect(result.intent).toBe('confirm');
    expect(result.next_state).toBe('scheduling');
  });

  it('returns the deterministic fallback turn when the provider failed', () => {
    const deterministicFallback = buildDeterministicQualificationTurn('a', {}, 'Pacific Ridge Property Management');

    const result = resolveRentalTurnToInterpreted({
      turn: rentalTurn({ reply: 'Could you clarify that in one sentence?', confidence: 'low' }),
      providerFailed: true,
      currentState: 'greeting',
      availableUnits: [adapterBurnabyUnit],
      deterministicFallback,
    });

    expect(result).toBe(deterministicFallback);
    expect(result.slots).toMatchObject({ transaction_intent: 'rent' });
  });

  it('falls back to a safe clarification on outage when no deterministic turn applies', () => {
    const result = resolveRentalTurnToInterpreted({
      turn: rentalTurn({ reply: 'Could you clarify that in one sentence?', confidence: 'low' }),
      providerFailed: true,
      currentState: 'proposing_tour',
      availableUnits: [adapterBurnabyUnit],
    });

    expect(result).toMatchObject({
      intent: 'ask_clarification',
      reply: 'Could you clarify that in one sentence?',
      next_state: 'proposing_tour',
    });
  });

  it('preserves a low-confidence clarification from the model as ask_clarification', () => {
    const result = resolveRentalTurnToInterpreted({
      turn: rentalTurn({
        reply: 'Which city did you mean?',
        intent: 'discover',
        confidence: 'low',
      }),
      providerFailed: false,
      currentState: 'collecting_budget',
      availableUnits: [adapterBurnabyUnit],
    });

    expect(result).toMatchObject({
      intent: 'ask_clarification',
      reply: 'Which city did you mean?',
      next_state: 'collecting_budget',
    });
  });
});
```

- [ ] **Step 2: Correr los tests para confirmar que fallan**

Run: `pnpm --filter @property-manager/api test -- chatbot.service.test.ts`
Expected: FAIL — `resolveRentalTurnToInterpreted` no existe todavía.

- [ ] **Step 3: Agregar los imports nuevos**

En la cabecera de `apps/api/src/services/chatbot.service.ts` (junto a los imports existentes de `./ownership-conversation.service.js` y `./rental-conversation.service.js`), agregar:

```ts
import { applyRentalProfilePatch } from './rental-conversation.context.js';
import { interpretRentalTurn } from './rental-conversation.interpreter.js';
import type { ConversationTurn, RentalProfile, RentalProfileField } from './rental-conversation.types.js';
```

- [ ] **Step 4: Agregar el conjunto de campos de perfil, justo después de la definición de `InterpretedTurn`**

```ts
const rentalProfileFields = new Set<RentalProfileField>([
  'prospect_name', 'transaction_intent', 'preferred_area', 'preferred_province',
  'bedrooms', 'bedrooms_min', 'bedrooms_max', 'pets', 'budget', 'occupants', 'move_in_date',
]);

function isRentalProfileField(key: string): key is RentalProfileField {
  return rentalProfileFields.has(key as RentalProfileField);
}
```

- [ ] **Step 5: Reemplazar el bloque de limpieza de `clearSlots` (dentro de `handleInboundMessageUnlocked`)**

Buscar este bloque exacto (justo después de `glmResult = applyBroadBedroomRequestScope(sanitizeInterpretedTurn(glmResult), input.body);`):

```ts
  if (glmResult.clearSlots?.length) {
    await prisma.conversationSlot.deleteMany({
      where: { conversationId: conversation.id, key: { in: glmResult.clearSlots } },
    });
    for (const key of glmResult.clearSlots) delete existingSlots[key];
  }
```

Reemplazarlo por:

```ts
  const rentalProfileClear = new Set(
    (glmResult.clearSlots ?? []).filter(isRentalProfileField),
  );
  const operationalSlotsToClear = (glmResult.clearSlots ?? []).filter(
    (key) => !isRentalProfileField(key),
  );
  if (operationalSlotsToClear.length > 0) {
    await prisma.conversationSlot.deleteMany({
      where: { conversationId: conversation.id, key: { in: operationalSlotsToClear } },
    });
  }
  if (glmResult.clearSlots?.length) {
    for (const key of glmResult.clearSlots) delete existingSlots[key];
  }
```

- [ ] **Step 6: Ajustar el bloque de corrección de área (unas líneas más abajo) para usar `rentalProfileClear`**

Buscar (dentro del mismo `if` de corrección de `contextualSlots.preferred_area`):

```ts
    await prisma.conversationSlot.deleteMany({
      where: {
        conversationId: conversation.id,
        key: { in: ['preferred_area', 'preferred_province', 'location_confirmed'] },
      },
    });
```

Reemplazarlo por (agregando las dos líneas de `rentalProfileClear.add` justo antes, y acotando el `deleteMany` a la clave operacional que no forma parte del perfil):

```ts
    rentalProfileClear.add('preferred_area');
    rentalProfileClear.add('preferred_province');
    await prisma.conversationSlot.deleteMany({
      where: {
        conversationId: conversation.id,
        key: 'location_confirmed',
      },
    });
```

- [ ] **Step 7: Reemplazar el bloque de persistencia de slots (`if (glmResult.slots) { ... }`)**

Buscar este bloque exacto:

```ts
  if (glmResult.slots) {
    for (const [key, value] of Object.entries(glmResult.slots)) {
      if (value) {
        await prisma.conversationSlot.upsert({
          where: { conversationId_key: { conversationId: conversation.id, key } },
          update: { value },
          create: { conversationId: conversation.id, key, value },
        });
      }
    }
  }

  const effectiveSlots = { ...existingSlots, ...(glmResult.slots ?? {}) };
```

Reemplazarlo por:

```ts
  const rentalProfileSet: RentalProfile = {};
  const operationalSlots: Record<string, string> = {};
  for (const [key, value] of Object.entries(glmResult.slots ?? {})) {
    if (!value) continue;
    if (isRentalProfileField(key)) rentalProfileSet[key] = value;
    else operationalSlots[key] = value;
  }

  let finalRentalProfile: RentalProfile | undefined;
  if (rentalProfileClear.size > 0 || Object.keys(rentalProfileSet).length > 0) {
    finalRentalProfile = await prisma.$transaction((tx) => applyRentalProfilePatch({
      tx,
      tenantId: input.tenantId,
      conversationId: conversation.id,
      leadId: conversation.leadId,
      patch: { clear: [...rentalProfileClear], set: rentalProfileSet },
    }));
  }

  for (const [key, value] of Object.entries(operationalSlots)) {
    await prisma.conversationSlot.upsert({
      where: { conversationId_key: { conversationId: conversation.id, key } },
      update: { value },
      create: { conversationId: conversation.id, key, value },
    });
  }

  if (finalRentalProfile) {
    for (const key of rentalProfileFields) {
      if (finalRentalProfile[key] === undefined) delete existingSlots[key];
    }
  }

  const effectiveSlots: Record<string, string> = {
    ...existingSlots,
    ...finalRentalProfile,
    ...(glmResult.slots ?? {}),
  };
```

- [ ] **Step 8: Reemplazar la función `callGlm` completa**

Buscar la función `callGlm` completa actual (empieza con `async function callGlm(` y termina con el `catch { return buildGlmFallback(...); }` de su cuerpo, justo antes de `export function parseGlmJsonResponse`). Reemplazar TODO su cuerpo (dejando la firma igual) por:

```ts
async function callGlm(
  glm: GlmAdapter,
  ctx: {
    currentState: ConversationState;
    tenantId: string;
    userMessage: string;
    history: Array<{ role: string; content: string }>;
    existingSlots: Record<string, string>;
    availableUnits: AvailableUnit[];
  },
): Promise<InterpretedTurn> {
  const knowledgeContext = await getTenantKnowledgeContext(ctx.tenantId, ctx.userMessage);
  const tenantName = await getTenantName(ctx.tenantId);
  const profile: RentalProfile = {};
  for (const field of rentalProfileFields) {
    if (ctx.existingSlots[field] !== undefined) profile[field] = ctx.existingSlots[field];
  }
  const history = ctx.history
    .slice(-10)
    .filter((message): message is { role: 'user' | 'assistant'; content: string } =>
      message.role === 'user' || message.role === 'assistant');
  let pendingSlotCount = 0;
  try {
    const pendingSlots = JSON.parse(ctx.existingSlots.pending_slots ?? '[]') as unknown;
    if (Array.isArray(pendingSlots)) pendingSlotCount = pendingSlots.length;
  } catch {
    pendingSlotCount = 0;
  }

  const { turn, providerFailed } = await interpretRentalTurn({
    glm,
    context: {
      tenantName,
      history,
      profile,
      selectedUnitId: ctx.existingSlots.selected_unit_id ?? ctx.existingSlots.scheduling_unit_id,
      pendingSlotCount,
      visibleUnits: ctx.availableUnits,
      knowledgeContext,
    },
    message: ctx.userMessage,
  });

  const deterministicFallback = providerFailed
    ? buildDeterministicQualificationTurn(ctx.userMessage, ctx.existingSlots, tenantName)
    : undefined;
  return resolveRentalTurnToInterpreted({
    turn,
    providerFailed,
    currentState: ctx.currentState,
    availableUnits: ctx.availableUnits,
    deterministicFallback,
  });
}

/**
 * Convierte el `ConversationTurn` semántico (resultado del intérprete) al
 * `InterpretedTurn` legado que el handler ya sabe procesar. Es una función
 * pura para poder probar el mapeo sin tocar Prisma ni al proveedor GLM.
 */
export function resolveRentalTurnToInterpreted(input: {
  turn: ConversationTurn;
  providerFailed: boolean;
  currentState: ConversationState;
  availableUnits: AvailableUnit[];
  deterministicFallback?: InterpretedTurn;
}): InterpretedTurn {
  const { turn, providerFailed, currentState, availableUnits, deterministicFallback } = input;

  if (providerFailed) {
    if (deterministicFallback) return deterministicFallback;
    return {
      reply: turn.reply,
      intent: 'ask_clarification',
      next_state: currentState,
    };
  }

  const lowConfidence = turn.confidence === 'low';
  const intent = lowConfidence ? 'ask_clarification' : legacyIntentForRentalTurn(turn.intent);
  const selectedOptions = turn.selection?.unitIds
    ?.map((unitId) => availableUnits.findIndex((unit) => unit.id === unitId) + 1)
    .filter((option) => option > 0);
  return {
    reply: turn.reply,
    intent,
    slots: turn.profile.set,
    clearSlots: turn.profile.clear,
    selected_options: selectedOptions?.length ? selectedOptions : undefined,
    selection_scope: selectedOptions?.length
      ? selectedOptions.length > 1 ? 'multiple' : 'single'
      : undefined,
    next_state: lowConfidence ? currentState : nextStateForRentalTurn(turn.intent, currentState),
  };
}

function legacyIntentForRentalTurn(intent: ConversationTurn['intent']): ConversationIntent {
  const intents: Record<ConversationTurn['intent'], ConversationIntent> = {
    discover: 'provide_information',
    compare: 'request_matches',
    select_unit: 'select_options',
    request_tour: 'schedule_tour',
    choose_slot: 'confirm',
    handoff: 'handoff',
    other: 'other',
  };
  return intents[intent];
}

function nextStateForRentalTurn(
  intent: ConversationTurn['intent'],
  currentState: ConversationState,
): ConversationState {
  const states: Partial<Record<ConversationTurn['intent'], ConversationState>> = {
    compare: 'proposing_tour',
    select_unit: 'proposing_units',
    request_tour: 'scheduling',
    choose_slot: 'scheduling',
    handoff: 'handoff',
  };
  return states[intent] ?? currentState;
}
```

No borrar `parseGlmJsonResponse` ni `buildGlmFallback` — ambas siguen usándose (`buildGlmFallback` desde `buildDeterministicQualificationTurn`'s fallback interno vía `buildFastQualificationTurn`, `parseGlmJsonResponse` desde sus propios tests existentes). No borrar `buildSystemPrompt` tampoco — queda sin uso directo desde `callGlm` pero la deja intacta el resto del archivo; si el compilador de TypeScript marca "declared but never read" para algún import ya no usado, ajustar solo ese import puntual, nada más.

- [ ] **Step 9: Correr los tests para verificar que pasan**

Run: `pnpm --filter @property-manager/api test -- chatbot.service.test.ts`
Expected: PASS — los ~150 tests existentes más los 6 nuevos de `resolveRentalTurnToInterpreted`.

- [ ] **Step 10: Typecheck**

Run: `pnpm --filter @property-manager/api typecheck`
Expected: sin errores. Si `buildSystemPrompt` queda sin ninguna referencia y el linter/compilador se queja, no eliminar la función (otros archivos podrían importarla) — solo confirmar con `grep -rn "buildSystemPrompt" apps/api/src` que sigue teniendo al menos un uso o exportación válida.

- [ ] **Step 11: Regresión completa del paquete**

Run: `pnpm --filter @property-manager/api test`
Expected: todos los archivos de test de `apps/api` en verde (no solo `chatbot.service.test.ts` — confirmar que no se rompió `conversation-transcripts.test.ts` ni `scheduling.service.test.ts`, que dependen indirectamente de `chatbot.service.ts`).

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/services/chatbot.service.ts apps/api/src/services/chatbot.service.test.ts
git commit -m "feat: run rental conversation through the semantic interpreter"
```

---

### Task 5: Cerrar las dos brechas restantes de sobre-coincidencia determinista

**Contexto:** `buildFastQualificationTurn` ya cede el paso al modelo (devuelve `undefined`) para mensajes ricos en los pasos de nombre, área (gracias al fix de `parseCanadianLocation` de esta misma sesión), recámaras y mascotas — todos esos matchean solo tokens únicos específicos. Quedan dos pasos que **siempre** devuelven un turno sin importar qué tan rico o ambiguo sea el mensaje: presupuesto (cualquier número de 3-5 dígitos en cualquier parte del mensaje) y fecha de mudanza (cualquier mensaje no vacío). Esta tarea cierra esos dos huecos para que un mensaje rico en esos pasos también llegue al modelo.

**Files:**
- Modify: `apps/api/src/services/chatbot.service.ts` (dentro de `buildFastQualificationTurn`, los bloques `if (!existingSlots.budget)` y `if (!existingSlots.move_in_date && message)`)
- Modify: `apps/api/src/services/chatbot.service.test.ts`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: mismo `buildFastQualificationTurn` exportado, comportamiento más estricto.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al `describe` existente relevante en `chatbot.service.test.ts` (buscar el `describe` que ya prueba `buildFastQualificationTurn`, o crear uno nuevo si no existe uno dedicado):

```ts
describe('buildFastQualificationTurn (model deferral on rich messages)', () => {
  it('defers to the model for a rich message during the budget step', () => {
    const result = buildFastQualificationTurn(
      'my max is around 3200 but I could stretch to 3500 for the right place',
      { transaction_intent: 'rent', prospect_name: 'Carlos', preferred_area: 'Burnaby', preferred_province: 'British Columbia', bedrooms: '2', pets: 'dog' },
      'Pacific Ridge Property Management',
    );
    expect(result).toBeUndefined();
  });

  it('still answers a simple numeric budget directly', () => {
    const result = buildFastQualificationTurn(
      '2600',
      { transaction_intent: 'rent', prospect_name: 'Carlos', preferred_area: 'Burnaby', preferred_province: 'British Columbia', bedrooms: '2', pets: 'dog' },
      'Pacific Ridge Property Management',
    );
    expect(result).toMatchObject({ slots: { budget: '2600' } });
  });

  it('defers to the model for a rich message during the move-in step', () => {
    const result = buildFastQualificationTurn(
      'honestly not sure yet, depends on when my lease ends',
      { transaction_intent: 'rent', prospect_name: 'Carlos', preferred_area: 'Burnaby', preferred_province: 'British Columbia', bedrooms: '2', pets: 'dog', budget: '2600' },
      'Pacific Ridge Property Management',
    );
    expect(result).toBeUndefined();
  });

  it('still answers a simple move-in month directly', () => {
    const result = buildFastQualificationTurn(
      'September',
      { transaction_intent: 'rent', prospect_name: 'Carlos', preferred_area: 'Burnaby', preferred_province: 'British Columbia', bedrooms: '2', pets: 'dog', budget: '2600' },
      'Pacific Ridge Property Management',
    );
    expect(result).toMatchObject({ slots: { move_in_date: 'September' } });
  });

  it('still answers "as soon as possible" directly', () => {
    const result = buildFastQualificationTurn(
      'asap',
      { transaction_intent: 'rent', prospect_name: 'Carlos', preferred_area: 'Burnaby', preferred_province: 'British Columbia', bedrooms: '2', pets: 'dog', budget: '2600' },
      'Pacific Ridge Property Management',
    );
    expect(result).toMatchObject({ slots: { move_in_date: 'As soon as possible' } });
  });
});
```

- [ ] **Step 2: Correr los tests para confirmar que fallan**

Run: `pnpm --filter @property-manager/api test -- chatbot.service.test.ts -t "model deferral on rich messages"`
Expected: FAIL en los dos tests "defers to the model" (los otros dos ya pasan con el código actual).

- [ ] **Step 3: Acotar el paso de presupuesto**

Buscar (dentro de `buildFastQualificationTurn`):

```ts
  if (!existingSlots.budget) {
    const amount = message.replace(/,/g, '').match(/\$?\s*(\d{3,5})/)?.[1];
    if (!amount) return undefined;
    return {
      reply: buildRentalMoveInQuestion(amount),
      slots: { budget: amount },
      next_state: 'collecting_movein',
    };
  }
```

Reemplazar por (exige que el mensaje sea esencialmente solo la cifra, con o sin `$`/texto trivial alrededor como "budget"/"month", no una oración con varias cláusulas):

```ts
  if (!existingSlots.budget) {
    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    const amount = message.replace(/,/g, '').match(/^\$?\s*(\d{3,5})\s*(?:\/?\s*(?:month|mo|per month))?$/i)?.[1];
    if (!amount || wordCount > 4) return undefined;
    return {
      reply: buildRentalMoveInQuestion(amount),
      slots: { budget: amount },
      next_state: 'collecting_movein',
    };
  }
```

- [ ] **Step 4: Acotar el paso de fecha de mudanza**

Buscar:

```ts
  if (!existingSlots.move_in_date && message) {
    const moveInTiming = canonicalizeMoveInTiming(message);
    return {
      reply: buildRentalMoveInAcknowledgement(moveInTiming),
      slots: { move_in_date: moveInTiming },
      next_state: 'proposing_tour',
    };
  }
```

Reemplazar por (solo responde directo cuando el mensaje realmente contiene una señal de fecha reconocible — un mes, "asap", o es corto y sin otras señales temáticas ricas; si no, cede el paso al modelo):

```ts
  if (!existingSlots.move_in_date && message) {
    const hasDateSignal = /\b(?:asap|as soon as possible|immediately|right away)\b/i.test(normalized)
      || /\b(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/i.test(normalized)
      || /\b20\d{2}\b/.test(normalized);
    const wordCount = normalized.split(/\s+/).filter(Boolean).length;
    if (!hasDateSignal && wordCount > 3) return undefined;
    const moveInTiming = canonicalizeMoveInTiming(message);
    return {
      reply: buildRentalMoveInAcknowledgement(moveInTiming),
      slots: { move_in_date: moveInTiming },
      next_state: 'proposing_tour',
    };
  }
```

- [ ] **Step 5: Correr los tests para verificar que pasan**

Run: `pnpm --filter @property-manager/api test -- chatbot.service.test.ts`
Expected: PASS — los 4 tests nuevos y todos los existentes (ningún test previo depende de que un mensaje largo sea aceptado como presupuesto/fecha; si alguno falla, leer el mensaje de assertion para confirmar si es un caso legítimo de "mensaje corto sin señal de fecha" que hay que ajustar en el guard, no relajar el guard a ciegas).

- [ ] **Step 6: Typecheck y regresión del paquete**

Run:
```bash
pnpm --filter @property-manager/api typecheck
pnpm --filter @property-manager/api test
```
Expected: sin errores, todo verde.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/chatbot.service.ts apps/api/src/services/chatbot.service.test.ts
git commit -m "fix: defer rich budget and move-in messages to the model"
```

---

### Task 6: Contrato semántico de compra/venta (nuevo)

**Files:**
- Create: `apps/api/src/services/ownership-conversation.types.ts`
- Create: `apps/api/src/services/ownership-conversation.types.test.ts`

**Interfaces:**
- Consumes: nada (capa base, análoga a Task 1 pero sin `selection`).
- Produces: `OwnershipProfileField`, `OwnershipProfile`, `OwnershipConversationSemanticTurn`, `parseOwnershipConversationTurn(value: unknown): OwnershipConversationSemanticTurn`, `normalizeOwnershipProfilePatch(input): OwnershipConversationSemanticTurn['profile']`.

- [ ] **Step 1: Escribir el archivo de implementación**

```ts
import { z } from 'zod';

export type OwnershipProfileField =
  | 'prospect_name'
  | 'transaction_intent'
  | 'preferred_area'
  | 'preferred_province'
  | 'buyer_property_type'
  | 'bedrooms'
  | 'purchase_budget'
  | 'financing_status'
  | 'purchase_timeline'
  | 'buyer_urgency'
  | 'buyer_household'
  | 'buyer_pets'
  | 'buyer_priorities'
  | 'contact_email'
  | 'contact_phone'
  | 'seller_property_address'
  | 'seller_property_type'
  | 'seller_bedrooms'
  | 'occupancy_status'
  | 'selling_timeline'
  | 'seller_goal';

export type OwnershipProfile = Partial<Record<OwnershipProfileField, string>>;

export type OwnershipConversationSemanticTurn = {
  reply: string;
  intent: 'discover' | 'handoff' | 'other';
  confidence: 'high' | 'low';
  clarification?: { question: string; field?: OwnershipProfileField };
  profile: { set: OwnershipProfile; clear: OwnershipProfileField[] };
};

const ownershipProfileFieldSchema = z.enum([
  'prospect_name',
  'transaction_intent',
  'preferred_area',
  'preferred_province',
  'buyer_property_type',
  'bedrooms',
  'purchase_budget',
  'financing_status',
  'purchase_timeline',
  'buyer_urgency',
  'buyer_household',
  'buyer_pets',
  'buyer_priorities',
  'contact_email',
  'contact_phone',
  'seller_property_address',
  'seller_property_type',
  'seller_bedrooms',
  'occupancy_status',
  'selling_timeline',
  'seller_goal',
]);

const normalizedStringSchema = z.string().transform((value) => value.trim());

const ownershipProfileSchema = z.object({
  prospect_name: normalizedStringSchema.optional(),
  transaction_intent: normalizedStringSchema.optional(),
  preferred_area: normalizedStringSchema.optional(),
  preferred_province: normalizedStringSchema.optional(),
  buyer_property_type: normalizedStringSchema.optional(),
  bedrooms: normalizedStringSchema.optional(),
  purchase_budget: normalizedStringSchema.optional(),
  financing_status: normalizedStringSchema.optional(),
  purchase_timeline: normalizedStringSchema.optional(),
  buyer_urgency: normalizedStringSchema.optional(),
  buyer_household: normalizedStringSchema.optional(),
  buyer_pets: normalizedStringSchema.optional(),
  buyer_priorities: normalizedStringSchema.optional(),
  contact_email: normalizedStringSchema.optional(),
  contact_phone: normalizedStringSchema.optional(),
  seller_property_address: normalizedStringSchema.optional(),
  seller_property_type: normalizedStringSchema.optional(),
  seller_bedrooms: normalizedStringSchema.optional(),
  occupancy_status: normalizedStringSchema.optional(),
  selling_timeline: normalizedStringSchema.optional(),
  seller_goal: normalizedStringSchema.optional(),
}).strict();

const ownershipProfilePatchSchema = z.object({
  set: ownershipProfileSchema,
  clear: z.array(ownershipProfileFieldSchema),
}).strict();

const ownershipConversationTurnSchema = z.object({
  reply: normalizedStringSchema,
  intent: z.enum(['discover', 'handoff', 'other']),
  confidence: z.enum(['high', 'low']),
  clarification: z.object({
    question: normalizedStringSchema,
    field: ownershipProfileFieldSchema.optional(),
  }).strict().optional(),
  profile: ownershipProfilePatchSchema,
}).strict();

export function parseOwnershipConversationTurn(value: unknown): OwnershipConversationSemanticTurn {
  return ownershipConversationTurnSchema.parse(value);
}

export function normalizeOwnershipProfilePatch(
  input: OwnershipConversationSemanticTurn['profile'],
): OwnershipConversationSemanticTurn['profile'] {
  return ownershipProfilePatchSchema.parse(input);
}
```

- [ ] **Step 2: Escribir el test**

```ts
import { describe, expect, it } from 'vitest';
import {
  normalizeOwnershipProfilePatch,
  parseOwnershipConversationTurn,
} from './ownership-conversation.types.js';

describe('parseOwnershipConversationTurn', () => {
  it('trims profile values for a buyer turn', () => {
    expect(parseOwnershipConversationTurn({
      reply: 'Got it.',
      intent: 'discover',
      confidence: 'high',
      profile: {
        set: { prospect_name: ' Sarah ', purchase_budget: ' 850000 ' },
        clear: [],
      },
    })).toMatchObject({
      profile: { set: { prospect_name: 'Sarah', purchase_budget: '850000' } },
    });
  });

  it('rejects profile fields outside the buyer/seller contract', () => {
    expect(() => parseOwnershipConversationTurn({
      reply: 'x',
      intent: 'discover',
      confidence: 'high',
      profile: { set: { made_up_field: 'x' }, clear: [] },
    })).toThrow(/profile/i);
  });

  it('rejects intents outside discover/handoff/other', () => {
    expect(() => parseOwnershipConversationTurn({
      reply: 'x',
      intent: 'select_unit',
      confidence: 'high',
      profile: { set: {}, clear: [] },
    })).toThrow();
  });
});

describe('normalizeOwnershipProfilePatch', () => {
  it('normalizes a patch without altering declared clears', () => {
    expect(normalizeOwnershipProfilePatch({
      set: { seller_property_address: ' 12 Main St ' },
      clear: ['selling_timeline'],
    })).toEqual({
      set: { seller_property_address: '12 Main St' },
      clear: ['selling_timeline'],
    });
  });
});
```

- [ ] **Step 3: Correr los tests**

Run: `pnpm --filter @property-manager/api test -- ownership-conversation.types.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @property-manager/api typecheck`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ownership-conversation.types.ts apps/api/src/services/ownership-conversation.types.test.ts
git commit -m "feat: add semantic ownership (buy/sell) conversation contract"
```

---

### Task 7: Aplicador transaccional de perfil de compra/venta (nuevo)

**Files:**
- Create: `apps/api/src/services/ownership-conversation.context.ts`
- Create: `apps/api/src/services/ownership-conversation.context.test.ts`

**Interfaces:**
- Consumes: `OwnershipConversationSemanticTurn['profile']`, `Prisma.TransactionClient` (Task 6).
- Produces: `applyOwnershipProfilePatch(input: {tx, tenantId, conversationId, leadId?, patch}): Promise<OwnershipProfile>`.

- [ ] **Step 1: Escribir el archivo de implementación**

```ts
import type { Prisma } from '@prisma/client';
import {
  normalizeOwnershipProfilePatch,
  type OwnershipConversationSemanticTurn,
  type OwnershipProfile,
  type OwnershipProfileField,
} from './ownership-conversation.types.js';

const ownershipProfileFields: OwnershipProfileField[] = [
  'prospect_name',
  'transaction_intent',
  'preferred_area',
  'preferred_province',
  'buyer_property_type',
  'bedrooms',
  'purchase_budget',
  'financing_status',
  'purchase_timeline',
  'buyer_urgency',
  'buyer_household',
  'buyer_pets',
  'buyer_priorities',
  'contact_email',
  'contact_phone',
  'seller_property_address',
  'seller_property_type',
  'seller_bedrooms',
  'occupancy_status',
  'selling_timeline',
  'seller_goal',
];

export async function applyOwnershipProfilePatch(input: {
  tx: Prisma.TransactionClient;
  tenantId: string;
  conversationId: string;
  leadId?: string | null;
  patch: OwnershipConversationSemanticTurn['profile'];
}): Promise<OwnershipProfile> {
  const patch = normalizeOwnershipProfilePatch(input.patch);

  if (patch.clear.length > 0) {
    await input.tx.conversationSlot.deleteMany({
      where: {
        conversationId: input.conversationId,
        key: { in: patch.clear },
      },
    });
  }

  for (const [key, value] of Object.entries(patch.set)) {
    await input.tx.conversationSlot.upsert({
      where: {
        conversationId_key: {
          conversationId: input.conversationId,
          key,
        },
      },
      update: { value },
      create: {
        conversationId: input.conversationId,
        key,
        value,
      },
    });
  }

  const correctedName = patch.set.prospect_name
    ?? (patch.clear.includes('prospect_name') ? null : undefined);
  if (input.leadId && correctedName !== undefined) {
    await input.tx.lead.updateMany({
      where: { id: input.leadId, tenantId: input.tenantId },
      data: { name: correctedName },
    });
  }

  const finalSlots = await input.tx.conversationSlot.findMany({
    where: {
      conversationId: input.conversationId,
      key: { in: ownershipProfileFields },
    },
    select: { key: true, value: true },
  });

  return finalSlots.reduce<OwnershipProfile>((profile: OwnershipProfile, slot: { key: string; value: string }) => {
    profile[slot.key as OwnershipProfileField] = slot.value;
    return profile;
  }, {});
}
```

- [ ] **Step 2: Escribir el test**

```ts
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { applyOwnershipProfilePatch } from './ownership-conversation.context.js';

function ownershipProfileTransaction(initialSlots: Record<string, string>) {
  const slots = new Map(Object.entries(initialSlots));
  let leadName: string | null = 'Sara';

  const tx = {
    conversationSlot: {
      deleteMany: vi.fn(async ({ where }: {
        where: { conversationId: string; key: { in: string[] } };
      }) => {
        let count = 0;
        for (const key of where.key.in) {
          if (slots.delete(key)) count += 1;
        }
        return { count };
      }),
      upsert: vi.fn(async ({ where, update }: {
        where: { conversationId_key: { conversationId: string; key: string } };
        update: { value: string };
      }) => {
        const { key } = where.conversationId_key;
        slots.set(key, update.value);
        return { key, value: update.value };
      }),
      findMany: vi.fn(async () => (
        [...slots].map(([key, value]) => ({ key, value }))
      )),
    },
    lead: {
      updateMany: vi.fn(async ({ data }: { data: { name: string | null } }) => {
        leadName = data.name;
        return { count: 1 };
      }),
    },
  } as unknown as Prisma.TransactionClient;

  return { tx, getLeadName: () => leadName };
}

describe('applyOwnershipProfilePatch', () => {
  it('corrects the prospect name without losing the purchase budget', async () => {
    const db = ownershipProfileTransaction({
      prospect_name: 'Sara',
      purchase_budget: '850000',
    });

    const profile = await applyOwnershipProfilePatch({
      tx: db.tx,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      leadId: 'lead-1',
      patch: { set: { prospect_name: 'Sarah' }, clear: [] },
    });

    expect(profile).toEqual({
      prospect_name: 'Sarah',
      purchase_budget: '850000',
    });
    expect(db.getLeadName()).toBe('Sarah');
  });

  it('applies set values after clears when both target the same field', async () => {
    const db = ownershipProfileTransaction({
      prospect_name: 'Sara',
      seller_property_type: 'condo',
    });

    const profile = await applyOwnershipProfilePatch({
      tx: db.tx,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      patch: {
        clear: ['seller_property_type'],
        set: { seller_property_type: 'townhouse' },
      },
    });

    expect(profile).toEqual({
      prospect_name: 'Sara',
      seller_property_type: 'townhouse',
    });
  });
});
```

- [ ] **Step 3: Correr los tests**

Run: `pnpm --filter @property-manager/api test -- ownership-conversation.context.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @property-manager/api typecheck`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ownership-conversation.context.ts apps/api/src/services/ownership-conversation.context.test.ts
git commit -m "feat: apply ownership profile changes transactionally"
```

---

### Task 8: Intérprete semántico de compra/venta (nuevo)

**Files:**
- Create: `apps/api/src/services/ownership-conversation.interpreter.ts`
- Create: `apps/api/src/services/ownership-conversation.interpreter.test.ts`

**Interfaces:**
- Consumes: `GlmAdapter`, `OwnershipConversationSemanticTurn`/`parseOwnershipConversationTurn` (Task 6).
- Produces: `OwnershipConversationContext`, `buildOwnershipConversationPrompt(context): string`, `interpretOwnershipTurn(input: {glm, context, message}): Promise<{turn, providerFailed}>`.

- [ ] **Step 1: Escribir el archivo de implementación**

```ts
import type { GlmAdapter } from '@property-manager/adapters';
import {
  parseOwnershipConversationTurn,
  type OwnershipConversationSemanticTurn,
  type OwnershipProfile,
} from './ownership-conversation.types.js';

export type OwnershipConversationContext = {
  tenantName: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  profile: OwnershipProfile;
  knowledgeContext: string;
};

const ownershipConversationTurnJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string' },
    intent: { type: 'string', enum: ['discover', 'handoff', 'other'] },
    confidence: { type: 'string', enum: ['high', 'low'] },
    clarification: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string' },
        field: {
          type: 'string',
          enum: [
            'prospect_name', 'transaction_intent', 'preferred_area', 'preferred_province',
            'buyer_property_type', 'bedrooms', 'purchase_budget', 'financing_status',
            'purchase_timeline', 'buyer_urgency', 'buyer_household', 'buyer_pets',
            'buyer_priorities', 'contact_email', 'contact_phone', 'seller_property_address',
            'seller_property_type', 'seller_bedrooms', 'occupancy_status', 'selling_timeline',
            'seller_goal',
          ],
        },
      },
      required: ['question'],
    },
    profile: {
      type: 'object',
      additionalProperties: false,
      properties: {
        set: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prospect_name: { type: 'string' },
            transaction_intent: { type: 'string' },
            preferred_area: { type: 'string' },
            preferred_province: { type: 'string' },
            buyer_property_type: { type: 'string' },
            bedrooms: { type: 'string' },
            purchase_budget: { type: 'string' },
            financing_status: { type: 'string' },
            purchase_timeline: { type: 'string' },
            buyer_urgency: { type: 'string' },
            buyer_household: { type: 'string' },
            buyer_pets: { type: 'string' },
            buyer_priorities: { type: 'string' },
            contact_email: { type: 'string' },
            contact_phone: { type: 'string' },
            seller_property_address: { type: 'string' },
            seller_property_type: { type: 'string' },
            seller_bedrooms: { type: 'string' },
            occupancy_status: { type: 'string' },
            selling_timeline: { type: 'string' },
            seller_goal: { type: 'string' },
          },
        },
        clear: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'prospect_name', 'transaction_intent', 'preferred_area', 'preferred_province',
              'buyer_property_type', 'bedrooms', 'purchase_budget', 'financing_status',
              'purchase_timeline', 'buyer_urgency', 'buyer_household', 'buyer_pets',
              'buyer_priorities', 'contact_email', 'contact_phone', 'seller_property_address',
              'seller_property_type', 'seller_bedrooms', 'occupancy_status', 'selling_timeline',
              'seller_goal',
            ],
          },
        },
      },
      required: ['set', 'clear'],
    },
  },
  required: ['reply', 'intent', 'confidence', 'profile'],
};

const safeClarification: OwnershipConversationSemanticTurn = {
  reply: 'Could you clarify that in one sentence?',
  intent: 'other',
  confidence: 'low',
  clarification: { question: 'Could you clarify that in one sentence?' },
  profile: { set: {}, clear: [] },
};

export type InterpretOwnershipResult = {
  turn: OwnershipConversationSemanticTurn;
  providerFailed: boolean;
};

export function buildOwnershipConversationPrompt(context: OwnershipConversationContext): string {
  return [
    'Interpret the current home buying/selling conversation message and return only one JSON object matching the response schema.',
    'This is qualification only: never claim a viewing, offer, or contract has been created. There is no inventory to recommend and no booking to make here.',
    'Corrections replace only the contradicted field. Preserve every uncontradicted fact already present in the profile and history.',
    "Ask one short clarification question when the user's meaning is uncertain. When uncertain, return confidence: 'low' and leave the profile patch empty unless the fact is explicit.",
    "Return intent: 'handoff' once enough of the relevant buyer or seller fields are known to hand off to a human broker (area, property type, budget/timeline for buyers; address, property type, timeline for sellers).",
    `Conversation context:\n${JSON.stringify({
      tenantName: context.tenantName,
      history: context.history,
      profile: context.profile,
      knowledgeContext: context.knowledgeContext,
    })}`,
  ].join('\n');
}

export async function interpretOwnershipTurn(input: {
  glm: GlmAdapter;
  context: OwnershipConversationContext;
  message: string;
}): Promise<InterpretOwnershipResult> {
  try {
    const response = await input.glm.reason({
      systemPrompt: buildOwnershipConversationPrompt(input.context),
      userPrompt: input.message,
      responseSchema: ownershipConversationTurnJsonSchema,
      temperature: 0.2,
    });
    const normalized = response.content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const turn = parseOwnershipConversationTurn(JSON.parse(normalized));
    if (turn.confidence === 'low' && !turn.clarification) {
      return { turn: safeClarification, providerFailed: false };
    }
    if (turn.confidence === 'low') {
      return {
        turn: {
          reply: turn.reply,
          intent: turn.intent,
          confidence: 'low',
          clarification: turn.clarification,
          profile: { set: {}, clear: [] },
        },
        providerFailed: false,
      };
    }
    return { turn, providerFailed: false };
  } catch {
    return { turn: safeClarification, providerFailed: true };
  }
}
```

- [ ] **Step 2: Escribir el test**

```ts
import type { GlmAdapter, GlmReasoningRequest } from '@property-manager/adapters';
import { describe, expect, it, vi } from 'vitest';
import {
  buildOwnershipConversationPrompt,
  interpretOwnershipTurn,
  type OwnershipConversationContext,
} from './ownership-conversation.interpreter.js';

function conversationContext(): OwnershipConversationContext {
  return {
    tenantName: 'North Shore Realty',
    history: [
      { role: 'user', content: 'I want to buy a home.' },
      { role: 'assistant', content: 'May I ask your first name?' },
    ],
    profile: { transaction_intent: 'buy', prospect_name: 'Sara' },
    knowledgeContext: 'Pre-approval required before offers.',
  };
}

function glmReturning(content: string): {
  glm: GlmAdapter;
  reason: ReturnType<typeof vi.fn<(request: GlmReasoningRequest) => Promise<{ content: string }>>>;
} {
  const reason = vi.fn(async (_request: GlmReasoningRequest) => ({ content }));
  return { glm: { name: 'glm', reason } as unknown as GlmAdapter, reason };
}

const safeClarification = {
  reply: 'Could you clarify that in one sentence?',
  intent: 'other',
  confidence: 'low',
  clarification: { question: 'Could you clarify that in one sentence?' },
  profile: { set: {}, clear: [] },
} as const;

describe('ownership conversation interpreter', () => {
  it('includes the qualification-only guardrail and context facts in the prompt', () => {
    const prompt = buildOwnershipConversationPrompt(conversationContext());
    expect(prompt).toContain('never claim a viewing, offer, or contract has been created');
    expect(prompt).toContain('"prospect_name":"Sara"');
  });

  it('returns the validated model turn for a rich qualifying message', async () => {
    const { glm } = glmReturning(JSON.stringify({
      reply: 'Got it — a $850k budget for a townhouse in Burnaby.',
      intent: 'discover',
      confidence: 'high',
      profile: { set: { purchase_budget: '850000', buyer_property_type: 'townhouse', preferred_area: 'Burnaby' }, clear: [] },
    }));

    await expect(interpretOwnershipTurn({
      glm,
      context: conversationContext(),
      message: 'My budget is around 850k for a townhouse in Burnaby.',
    })).resolves.toEqual({
      turn: {
        reply: 'Got it — a $850k budget for a townhouse in Burnaby.',
        intent: 'discover',
        confidence: 'high',
        profile: { set: { purchase_budget: '850000', buyer_property_type: 'townhouse', preferred_area: 'Burnaby' }, clear: [] },
      },
      providerFailed: false,
    });
  });

  it('flags malformed JSON as a provider failure', async () => {
    const { glm } = glmReturning('{not-json');
    await expect(interpretOwnershipTurn({
      glm,
      context: conversationContext(),
      message: 'Something else',
    })).resolves.toEqual({ turn: safeClarification, providerFailed: true });
  });

  it('removes profile mutations from a low-confidence clarification', async () => {
    const { glm } = glmReturning(JSON.stringify({
      reply: 'Which neighbourhood did you mean?',
      intent: 'discover',
      confidence: 'low',
      clarification: { question: 'Which neighbourhood did you mean?' },
      profile: { set: { preferred_area: 'somewhere' }, clear: ['purchase_budget'] },
    }));

    await expect(interpretOwnershipTurn({
      glm,
      context: conversationContext(),
      message: 'Somewhere nice, I guess.',
    })).resolves.toEqual({
      turn: {
        reply: 'Which neighbourhood did you mean?',
        intent: 'discover',
        confidence: 'low',
        clarification: { question: 'Which neighbourhood did you mean?' },
        profile: { set: {}, clear: [] },
      },
      providerFailed: false,
    });
  });

  it('returns handoff intent once the model determines qualification is complete', async () => {
    const { glm } = glmReturning(JSON.stringify({
      reply: "I'll connect you with our buying specialist now.",
      intent: 'handoff',
      confidence: 'high',
      profile: { set: {}, clear: [] },
    }));

    await expect(interpretOwnershipTurn({
      glm,
      context: conversationContext(),
      message: 'That covers everything I think.',
    })).resolves.toEqual({
      turn: {
        reply: "I'll connect you with our buying specialist now.",
        intent: 'handoff',
        confidence: 'high',
        profile: { set: {}, clear: [] },
      },
      providerFailed: false,
    });
  });
});
```

- [ ] **Step 3: Correr los tests**

Run: `pnpm --filter @property-manager/api test -- ownership-conversation.interpreter.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @property-manager/api typecheck`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ownership-conversation.interpreter.ts apps/api/src/services/ownership-conversation.interpreter.test.ts
git commit -m "feat: add ownership conversation interpreter"
```

---

### Task 9: Cablear el intérprete de compra/venta en `chatbot.service.ts`

**Files:**
- Modify: `apps/api/src/services/chatbot.service.ts` (imports; la línea de decisión determinista `qualificationTurn`/`deterministicResult` dentro de `handleInboundMessageUnlocked`, alrededor de la línea 713-728 antes de las tareas previas de esta sesión — confirmar el número exacto con `grep -n "const qualificationTurn = buildDeterministicQualificationTurn"` antes de editar)
- Modify: `apps/api/src/services/chatbot.service.test.ts`

**Interfaces:**
- Consumes: `interpretOwnershipTurn`, `OwnershipConversationContext` (Task 8); `applyOwnershipProfilePatch` (Task 7).
- Produces: `resolveOwnershipTurnToInterpreted(input): InterpretedTurn` (exportada).

- [ ] **Step 1: Escribir los tests nuevos (fallan porque nada de esto existe todavía)**

Agregar al final de `chatbot.service.test.ts`:

```ts
describe('resolveOwnershipTurnToInterpreted (semantic adapter mapping)', () => {
  function ownershipTurn(overrides: Partial<OwnershipConversationSemanticTurn> = {}): OwnershipConversationSemanticTurn {
    return {
      reply: 'Got it.',
      intent: 'discover',
      confidence: 'high',
      profile: { set: {}, clear: [] },
      ...overrides,
    };
  }

  it('maps a discover turn to provide_information and keeps collecting_budget as the state', () => {
    const result = resolveOwnershipTurnToInterpreted({
      turn: ownershipTurn({
        reply: 'Got it, a $850k budget.',
        profile: { set: { purchase_budget: '850000' }, clear: [] },
      }),
      providerFailed: false,
      currentState: 'collecting_budget',
    });

    expect(result).toMatchObject({
      intent: 'provide_information',
      slots: { purchase_budget: '850000' },
      next_state: 'collecting_budget',
    });
  });

  it('maps a handoff turn to the handoff state', () => {
    const result = resolveOwnershipTurnToInterpreted({
      turn: ownershipTurn({ reply: 'Connecting you now.', intent: 'handoff' }),
      providerFailed: false,
      currentState: 'collecting_budget',
    });

    expect(result).toMatchObject({ intent: 'handoff', next_state: 'handoff' });
  });

  it('preserves a low-confidence clarification as ask_clarification', () => {
    const result = resolveOwnershipTurnToInterpreted({
      turn: ownershipTurn({ reply: 'Which city did you mean?', confidence: 'low' }),
      providerFailed: false,
      currentState: 'collecting_budget',
    });

    expect(result).toMatchObject({ intent: 'ask_clarification', reply: 'Which city did you mean?' });
  });

  it('returns the deterministic fallback turn when the provider failed', () => {
    const deterministicFallback = buildOwnershipConversationTurn('I want to buy', {});

    const result = resolveOwnershipTurnToInterpreted({
      turn: ownershipTurn({ confidence: 'low' }),
      providerFailed: true,
      currentState: 'greeting',
      deterministicFallback,
    });

    expect(result).toBe(deterministicFallback);
  });

  it('falls back to a safe clarification on outage when no deterministic turn applies', () => {
    const result = resolveOwnershipTurnToInterpreted({
      turn: ownershipTurn({ reply: 'Could you clarify that in one sentence?', confidence: 'low' }),
      providerFailed: true,
      currentState: 'collecting_budget',
    });

    expect(result).toMatchObject({
      intent: 'ask_clarification',
      reply: 'Could you clarify that in one sentence?',
      next_state: 'collecting_budget',
    });
  });
});
```

Ninguno de estos dos está importado todavía en `chatbot.service.test.ts` — agregar, junto a los demás imports del archivo:

```ts
import { buildOwnershipConversationTurn } from './ownership-conversation.service.js';
import type { OwnershipConversationSemanticTurn } from './ownership-conversation.types.js';
```

- [ ] **Step 2: Correr los tests para confirmar que fallan**

Run: `pnpm --filter @property-manager/api test -- chatbot.service.test.ts -t "resolveOwnershipTurnToInterpreted"`
Expected: FAIL — la función no existe.

- [ ] **Step 3: Agregar los imports nuevos en `chatbot.service.ts`**

```ts
import { applyOwnershipProfilePatch } from './ownership-conversation.context.js';
import { interpretOwnershipTurn } from './ownership-conversation.interpreter.js';
import type { OwnershipConversationSemanticTurn, OwnershipProfile, OwnershipProfileField } from './ownership-conversation.types.js';
```

- [ ] **Step 4: Agregar `callOwnershipGlm`, `resolveOwnershipTurnToInterpreted` y sus mapeos, junto a las funciones análogas de renta (después de `nextStateForRentalTurn`)**

```ts
const ownershipProfileFields = new Set<OwnershipProfileField>([
  'prospect_name', 'transaction_intent', 'preferred_area', 'preferred_province',
  'buyer_property_type', 'bedrooms', 'purchase_budget', 'financing_status',
  'purchase_timeline', 'buyer_urgency', 'buyer_household', 'buyer_pets',
  'buyer_priorities', 'contact_email', 'contact_phone', 'seller_property_address',
  'seller_property_type', 'seller_bedrooms', 'occupancy_status', 'selling_timeline',
  'seller_goal',
]);

function isOwnershipProfileField(key: string): key is OwnershipProfileField {
  return ownershipProfileFields.has(key as OwnershipProfileField);
}

async function callOwnershipGlm(
  glm: GlmAdapter,
  ctx: {
    currentState: ConversationState;
    tenantId: string;
    userMessage: string;
    history: Array<{ role: string; content: string }>;
    existingSlots: Record<string, string>;
  },
): Promise<InterpretedTurn> {
  const knowledgeContext = await getTenantKnowledgeContext(ctx.tenantId, ctx.userMessage);
  const tenantName = await getTenantName(ctx.tenantId);
  const profile: OwnershipProfile = {};
  for (const field of ownershipProfileFields) {
    if (ctx.existingSlots[field] !== undefined) profile[field] = ctx.existingSlots[field];
  }
  const history = ctx.history
    .slice(-10)
    .filter((message): message is { role: 'user' | 'assistant'; content: string } =>
      message.role === 'user' || message.role === 'assistant');

  const { turn, providerFailed } = await interpretOwnershipTurn({
    glm,
    context: { tenantName, history, profile, knowledgeContext },
    message: ctx.userMessage,
  });

  const deterministicFallback = providerFailed
    ? buildOwnershipConversationTurn(ctx.userMessage, ctx.existingSlots)
    : undefined;
  return resolveOwnershipTurnToInterpreted({
    turn,
    providerFailed,
    currentState: ctx.currentState,
    deterministicFallback,
  });
}

export function resolveOwnershipTurnToInterpreted(input: {
  turn: OwnershipConversationSemanticTurn;
  providerFailed: boolean;
  currentState: ConversationState;
  deterministicFallback?: InterpretedTurn;
}): InterpretedTurn {
  const { turn, providerFailed, currentState, deterministicFallback } = input;

  if (providerFailed) {
    if (deterministicFallback) return deterministicFallback;
    return {
      reply: turn.reply,
      intent: 'ask_clarification',
      next_state: currentState,
    };
  }

  const lowConfidence = turn.confidence === 'low';
  return {
    reply: turn.reply,
    intent: lowConfidence ? 'ask_clarification' : legacyIntentForOwnershipTurn(turn.intent),
    slots: turn.profile.set,
    clearSlots: turn.profile.clear,
    next_state: lowConfidence ? currentState : (turn.intent === 'handoff' ? 'handoff' : 'collecting_budget'),
  };
}

function legacyIntentForOwnershipTurn(intent: OwnershipConversationSemanticTurn['intent']): ConversationIntent {
  const intents: Record<OwnershipConversationSemanticTurn['intent'], ConversationIntent> = {
    discover: 'provide_information',
    handoff: 'handoff',
    other: 'other',
  };
  return intents[intent];
}
```

- [ ] **Step 5: Cablear la persistencia transaccional del perfil de ownership**

Esta tarea extiende tres bloques que la Task 4 ya dejó en `chatbot.service.ts`, para que también reconozcan y persistan los campos de perfil de ownership. Hacer los tres reemplazos en este orden:

**5a.** Buscar el bloque de la Task 4 Step 5/6 (empieza con `const rentalProfileClear = new Set(`) y reemplazarlo por:

```ts
  const rentalProfileClear = new Set(
    (glmResult.clearSlots ?? []).filter(isRentalProfileField),
  );
  const ownershipProfileClear = new Set(
    (glmResult.clearSlots ?? []).filter(isOwnershipProfileField),
  );
  const operationalSlotsToClear = (glmResult.clearSlots ?? []).filter(
    (key) => !isRentalProfileField(key) && !isOwnershipProfileField(key),
  );
```

**5b.** Buscar el bloque de la Task 4 Step 7 que empieza con `const rentalProfileSet: RentalProfile = {};` y termina justo antes de `const effectiveSlots`, y reemplazarlo por:

```ts
  const rentalProfileSet: RentalProfile = {};
  const ownershipProfileSet: OwnershipProfile = {};
  const operationalSlots: Record<string, string> = {};
  for (const [key, value] of Object.entries(glmResult.slots ?? {})) {
    if (!value) continue;
    if (isRentalProfileField(key)) rentalProfileSet[key] = value;
    else if (isOwnershipProfileField(key)) ownershipProfileSet[key] = value;
    else operationalSlots[key] = value;
  }

  let finalRentalProfile: RentalProfile | undefined;
  if (rentalProfileClear.size > 0 || Object.keys(rentalProfileSet).length > 0) {
    finalRentalProfile = await prisma.$transaction((tx) => applyRentalProfilePatch({
      tx,
      tenantId: input.tenantId,
      conversationId: conversation.id,
      leadId: conversation.leadId,
      patch: { clear: [...rentalProfileClear], set: rentalProfileSet },
    }));
  }

  let finalOwnershipProfile: OwnershipProfile | undefined;
  if (ownershipProfileClear.size > 0 || Object.keys(ownershipProfileSet).length > 0) {
    finalOwnershipProfile = await prisma.$transaction((tx) => applyOwnershipProfilePatch({
      tx,
      tenantId: input.tenantId,
      conversationId: conversation.id,
      leadId: conversation.leadId,
      patch: { clear: [...ownershipProfileClear], set: ownershipProfileSet },
    }));
  }

  for (const [key, value] of Object.entries(operationalSlots)) {
    await prisma.conversationSlot.upsert({
      where: { conversationId_key: { conversationId: conversation.id, key } },
      update: { value },
      create: { conversationId: conversation.id, key, value },
    });
  }

  if (finalRentalProfile) {
    for (const key of rentalProfileFields) {
      if (finalRentalProfile[key] === undefined) delete existingSlots[key];
    }
  }
  if (finalOwnershipProfile) {
    for (const key of ownershipProfileFields) {
      if (finalOwnershipProfile[key] === undefined) delete existingSlots[key];
    }
  }
```

**5c.** Buscar `const effectiveSlots: Record<string, string> = {` (de la Task 4 Step 7) y reemplazarlo por:

```ts
  const effectiveSlots: Record<string, string> = {
    ...existingSlots,
    ...finalRentalProfile,
    ...finalOwnershipProfile,
    ...(glmResult.slots ?? {}),
  };
```

- [ ] **Step 6: Cambiar la decisión de enrutamiento en `handleInboundMessageUnlocked`**

Buscar (línea exacta a confirmar con `grep -n "let glmResult: InterpretedTurn = deterministicResult"` — después de la Task 4 debería verse así):

```ts
  const qualificationTurn = buildDeterministicQualificationTurn(input.body, existingSlots, tenantName);
  const deterministicResult = existingSlots.tour_scheduled_at
    ? buildPostTourContextTurn(input.body, existingSlots)
    : qualificationTurn
      ?? focusedTurn
      ?? optionDecline
      ?? repairTurn
      ?? undefined;
  let glmResult: InterpretedTurn = deterministicResult ?? await callGlm(deps.glm, {
    currentState,
    tenantId: input.tenantId,
    userMessage: input.body,
    history: prepareConversationHistory(conversation.messages, isStartCommand),
    existingSlots,
    availableUnits,
  });
```

Reemplazar por:

```ts
  const ownershipIntentAlreadySet = existingSlots.transaction_intent === 'buy' || existingSlots.transaction_intent === 'sell';
  const qualificationTurn = ownershipIntentAlreadySet
    ? undefined
    : buildDeterministicQualificationTurn(input.body, existingSlots, tenantName);
  const deterministicResult = existingSlots.tour_scheduled_at
    ? buildPostTourContextTurn(input.body, existingSlots)
    : qualificationTurn
      ?? focusedTurn
      ?? optionDecline
      ?? repairTurn
      ?? undefined;

  let glmResult: InterpretedTurn;
  if (deterministicResult) {
    glmResult = deterministicResult;
  } else if (ownershipIntentAlreadySet) {
    glmResult = await callOwnershipGlm(deps.glm, {
      currentState,
      tenantId: input.tenantId,
      userMessage: input.body,
      history: prepareConversationHistory(conversation.messages, isStartCommand),
      existingSlots,
    });
  } else {
    glmResult = await callGlm(deps.glm, {
      currentState,
      tenantId: input.tenantId,
      userMessage: input.body,
      history: prepareConversationHistory(conversation.messages, isStartCommand),
      existingSlots,
      availableUnits,
    });
  }
```

- [ ] **Step 7: Correr los tests para verificar que pasan**

Run: `pnpm --filter @property-manager/api test -- chatbot.service.test.ts`
Expected: PASS — todos los tests existentes más los 5 nuevos de `resolveOwnershipTurnToInterpreted`.

- [ ] **Step 8: Typecheck y regresión del paquete**

Run:
```bash
pnpm --filter @property-manager/api typecheck
pnpm --filter @property-manager/api test
```
Expected: sin errores, todo verde.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/chatbot.service.ts apps/api/src/services/chatbot.service.test.ts
git commit -m "feat: run ownership conversation through the semantic interpreter"
```

---

### Task 10: Regresión completa y prueba manual en vivo

**Files:** ninguno (solo verificación).

- [ ] **Step 1: Typecheck de todo el monorepo**

Run:
```bash
pnpm -r --filter "./packages/**" run typecheck
pnpm -r --filter "./apps/**" run typecheck
```
Expected: sin errores en `packages/config`, `packages/core`, `packages/adapters`, `apps/api`, `apps/web`.

- [ ] **Step 2: Suite completa del monorepo**

Run: `pnpm test`
Expected: todos los archivos de test pasan (`apps/api`, `packages/core`, `packages/adapters`, `apps/web`).

- [ ] **Step 3: Reiniciar el servidor de la API en modo watch**

Confirmar que el proceso de `apps/api` corriendo en `localhost:4000` está en modo `tsx watch` (no `node --import tsx` directo) para que recoja los cambios. Si no lo está:

```bash
pnpm --filter @property-manager/api dev
```

Verificar con: `curl -s http://localhost:4000/health`

- [ ] **Step 4: Prueba manual en vivo — renta**

Usando `curl` contra `POST /chat/messages` (header `x-tenant-id: tenant_demo_pm`, body `{"sessionId": "<id-unico>", "message": "..."}`), recorrer en una sola sesión:

1. `"a"` (selecciona renta)
2. `"My name is Carlos"`
3. `"My budget is $2600, I want to move in August near Burnaby, 2 occupants and one cat"` — confirmar que la respuesta reconoce varios datos a la vez, no solo uno.
4. Un mensaje de corrección de nombre tipo `"sorry, it's Carlos"` en un turno posterior — confirmar que el resto del perfil no se pierde.
5. Continuar hasta que el bot proponga una unidad y pedir un tour — confirmar que la unidad/horario ofrecidos existen realmente (comparar contra `GET /properties` o los datos de seed).

Reportar el JSON de cada respuesta.

- [ ] **Step 5: Prueba manual en vivo — compra/venta**

Nueva sesión, recorrido:

1. `"I want to buy a house"`
2. Un mensaje rico: `"I'm Sarah, budget around 850k, looking for a townhouse in Burnaby, pre-approved already"` — confirmar que captura varios campos a la vez.
3. Continuar hasta que el bot marque `handoff` — confirmar que el estado de la conversación pasa a `handoff` en la respuesta.

- [ ] **Step 6: Confirmar los criterios de aceptación del spec**

Repasar la sección "Criterios de aceptación" de `docs/superpowers/specs/2026-08-03-chatbot-model-first-restore-design.md` uno por uno contra la evidencia de los Steps 4-5. Documentar cualquier criterio que no se cumpla — no cerrar la tarea si alguno falla.

- [ ] **Step 7: Reporte final**

Resumir: tests totales antes/después, typecheck limpio, y las transcripciones de las Steps 4-5. No hacer commit en este paso (no hay cambios de código).
