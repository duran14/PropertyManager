# Fase 1B: Lead Re-engagement / Remarketing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Job semanal de BullMQ que reactiva leads inactivos (≥14 días sin mensajes, sin showing agendado, un solo intento por lead para siempre) reutilizando la memoria de conversación ya guardada, más un detector determinista de opt-out sobre los mensajes entrantes.

**Architecture:** Un servicio de dominio nuevo (`remarketing.service.ts`) con funciones puras/testables por separado (candidatos, redacción, envío, orquestación), conectado a un job de BullMQ que corre una vez por semana para todos los tenants. El opt-out se detecta con una función pura dentro del flujo normal de mensajes entrantes (`chatbot.service.ts`), sin IA.

**Tech Stack:** Node.js/Express/TypeScript, Prisma, BullMQ, Vitest.

Spec de referencia: [`docs/superpowers/specs/2026-08-07-fase-1b-remarketing-design.md`](../specs/2026-08-07-fase-1b-remarketing-design.md).

## Global Constraints

- Envío 100% automático, sin cola de revisión humana.
- Un solo intento de remarketing por lead, para siempre — no una serie.
- Frases de opt-out son de **alta precisión** — nunca ambigüedades como "no me interesa" (falso positivo es peor que falso negativo).
- Umbral de inactividad: ≥14 días sin mensajes en la conversación más reciente del lead.
- Audiencia: `Lead.status IN ('new_', 'contacted', 'qualified')`, sin ningún `Showing` asociado.
- Job corre semanalmente, para **todos los tenants** en una sola ejecución (no requiere registro manual por tenant).
- Tests: solo automatizados, Prisma real contra la DB de test + adapters mock/spy inyectados — mismo patrón que `chatbot.routing.test.ts`. Nunca `vi.mock` de Prisma.
- Comentarios en español, solo donde el porqué no sea obvio.
- Cada tarea deja el repo verde: `tsc --noEmit` limpio y la suite completa de `apps/api` pasando.

---

### Task 1: Campos nuevos en `Lead` (schema + migración)

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: migración de Prisma (generada por el comando del Step 2)

**Interfaces:**
- Produces: `Lead.lastRemarketedAt: DateTime | null`, `Lead.optedOutAt: DateTime | null` en el modelo Prisma. Consumidos por las Tasks 2-5.

- [ ] **Step 1: Agregar los campos al modelo `Lead`**

En `apps/api/prisma/schema.prisma`, dentro de `model Lead { ... }`, después de `updatedAt DateTime @updatedAt`:

```prisma
model Lead {
  id                String     @id @default(cuid())
  tenantId          String
  unitId            String?
  // Datos del prospecto
  name              String?
  email             String?
  phone             String?
  message           String?
  // De dónde vino el lead
  source            LeadSource
  // Canal de comunicación preferido
  preferredChannel  String?
  // Estado del funnel
  status            LeadStatus @default(new_)
  // Referencia a ShowMojo cuando se agenda una visita (Fase 10)
  showmojoShowingId String?
  tourUrl           String?
  operationalStatus String?    @default("needs_review")
  assignedUserId    String?
  createdAt         DateTime   @default(now())
  updatedAt         DateTime   @updatedAt
  // Fase 1B: reactivación de leads inactivos
  lastRemarketedAt  DateTime?
  optedOutAt        DateTime?

  tenant             Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  unit               Unit?               @relation(fields: [unitId], references: [id])
  assignedUser       User?               @relation("LeadAssignedUser", fields: [assignedUserId], references: [id])
  conversations      ChatConversation[]
  conversationEvents ConversationEvent[]
  showings           Showing[]

  @@index([tenantId, status])
  @@index([tenantId, operationalStatus])
  @@index([tenantId, assignedUserId])
  @@index([tenantId, source])
  @@map("leads")
}
```

(Solo se agregan las dos líneas nuevas y su comentario — el resto del bloque queda igual, se muestra completo para ubicar el punto de inserción exacto.)

- [ ] **Step 2: Generar y aplicar la migración**

Asegúrate de que Postgres esté corriendo (`pnpm db:up` si no lo está), luego:

Run: `pnpm --filter @property-manager/api exec prisma migrate dev --name add_lead_remarketing_fields`
Expected: crea `apps/api/prisma/migrations/<timestamp>_add_lead_remarketing_fields/migration.sql` con dos `ALTER TABLE "leads" ADD COLUMN` (ambas nullable), sin errores.

Si el shell no es interactivo y `migrate dev` se rehúsa a correr (ya pasó antes en este repo): usa `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --shadow-database-url "$DATABASE_URL"` para generar el SQL, escríbelo a mano en una carpeta nueva `apps/api/prisma/migrations/<timestamp>_add_lead_remarketing_fields/migration.sql`, y aplica con `prisma migrate deploy`.

- [ ] **Step 3: Verificar que todo compila**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — toda la suite existente sigue verde (los campos son opcionales, no rompen nada).

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat: add Lead.lastRemarketedAt and Lead.optedOutAt for Fase 1B"
```

---

### Task 2: Detectar y aplicar opt-out en mensajes entrantes

Función pura y determinista (sin IA), más su conexión al flujo normal de
`handleInboundMessage`. Ambas piezas viven en `chatbot.service.ts` — la
función solo la usa ese archivo, así que no hace falta un archivo separado
(y evita una dependencia circular con el servicio de remarketing de las
Tasks 3-5, que sí necesita importar cosas de `chatbot.service.ts`).

**Files:**
- Modify: `apps/api/src/services/chatbot.service.ts`
- Modify: `apps/api/src/services/chatbot.service.test.ts` (test de la función pura)
- Modify: `apps/api/src/services/chatbot.routing.test.ts` (test de integración: el opt-out se aplica de verdad al `Lead` vía `handleInboundMessage`)

**Interfaces:**
- Produces: `export function detectOptOutPhrase(message: string): boolean` en `chatbot.service.ts`. No es consumida por ninguna task posterior (es de uso interno de este archivo), pero debe existir con este nombre exacto por si se reutiliza más adelante.

- [ ] **Step 1: Escribir el test de la función pura (aún no existe)**

En `apps/api/src/services/chatbot.service.test.ts`, agregar (junto a los tests de otras funciones puras del archivo, por ejemplo cerca de `looksLikeSpanish`):

```typescript
  it.each([
    'no me contacten más por favor',
    'no me escriban más',
    'dejen de escribirme',
    'quítenme de la lista',
    'ya no me manden mensajes',
    'unsubscribe',
    'please unsubscribe me',
    'stop contacting me',
    'stop messaging me',
  ])('detects an explicit opt-out phrase: %s', (message) => {
    expect(detectOptOutPhrase(message)).toBe(true);
  });

  it.each([
    'no me interesa este depa',
    'no gracias',
    'no tengo mascotas',
    'estoy buscando algo con más espacio',
    'hola, quiero rentar un depa',
  ])('does not flag an ordinary message as opt-out: %s', (message) => {
    expect(detectOptOutPhrase(message)).toBe(false);
  });
```

Y agregar `detectOptOutPhrase` al bloque de imports del test en la parte superior del archivo (junto a los demás imports nombrados de `./chatbot.service.js`).

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/chatbot.service.test.ts`
Expected: FAIL — `detectOptOutPhrase is not defined` / `is not exported`.

- [ ] **Step 3: Implementar la función pura**

En `apps/api/src/services/chatbot.service.ts`, agregar (por ejemplo cerca de `looksLikeSpanish`, con las demás funciones puras de detección):

```typescript
// Frases de alta precisión únicamente — "no me interesa" o "no gracias"
// son negaciones normales de conversación y NO deben disparar opt-out.
// Un falso positivo (excluir a alguien que sigue interesado) es peor que
// un falso negativo (alguien que de verdad no quiere más mensajes tiene
// que escribirlo de forma más explícita una vez).
const OPT_OUT_PATTERNS = [
  /no me contact/i,
  /no me escriban? m[aá]s/i,
  /dejen? de escribirme/i,
  /qu[ií]tenme de la lista/i,
  /ya no me manden mensajes/i,
  /\bunsubscribe\b/i,
  /\bstop contacting me\b/i,
  /\bstop messaging me\b/i,
];

export function detectOptOutPhrase(message: string): boolean {
  return OPT_OUT_PATTERNS.some((pattern) => pattern.test(message));
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/chatbot.service.test.ts`
Expected: PASS (18 tests nuevos: 9 positivos + 9 negativos — ajusta el conteo si agregaste más casos).

- [ ] **Step 5: Escribir el test de integración (aún falla — no está conectado)**

En `apps/api/src/services/chatbot.routing.test.ts`, agregar un nuevo `it` dentro del `describe` existente:

```typescript
  it('marks Lead.optedOutAt when an inbound message contains an explicit opt-out phrase', async () => {
    const { glm } = glmReturning('{"reply":"Entendido.","intent":"other","slots":{},"profile":{"set":{},"clear":[]},"confidence":"low"}');

    await handleInboundMessage(
      { tenantId: TENANT_ID, from: '+16045550199', body: 'Hola, busco depa de 2 recámaras', channel: 'web' },
      { glm, messaging, showmojo },
    );
    await handleInboundMessage(
      { tenantId: TENANT_ID, from: '+16045550199', body: 'ya no me manden mensajes por favor', channel: 'web' },
      { glm, messaging, showmojo },
    );

    const lead = await prisma.lead.findFirst({ where: { tenantId: TENANT_ID, phone: '+16045550199' } });
    expect(lead?.optedOutAt).not.toBeNull();
  });

  it('does not mark Lead.optedOutAt for an ordinary message', async () => {
    const { glm } = glmReturning('{"reply":"Claro, cuéntame más.","intent":"other","slots":{},"profile":{"set":{},"clear":[]},"confidence":"low"}');

    await handleInboundMessage(
      { tenantId: TENANT_ID, from: '+16045550198', body: 'Hola, busco depa de 2 recámaras', channel: 'web' },
      { glm, messaging, showmojo },
    );

    const lead = await prisma.lead.findFirst({ where: { tenantId: TENANT_ID, phone: '+16045550198' } });
    expect(lead?.optedOutAt).toBeNull();
  });
```

- [ ] **Step 6: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/chatbot.routing.test.ts`
Expected: FAIL en el primer test nuevo — `lead?.optedOutAt` es `null` en vez de tener un valor (el detector existe pero no está conectado a `handleInboundMessage`).

- [ ] **Step 7: Conectar el detector a `handleInboundMessageUnlocked`**

En `apps/api/src/services/chatbot.service.ts`, dentro de `handleInboundMessageUnlocked`, justo después de la línea:

```typescript
  const leadCreated = await ensureLead(input.tenantId, conversation.id, input.from, input.body, input.channel, presentedUnit?.id);
```

agregar:

```typescript
  if (detectOptOutPhrase(input.body)) {
    const linkedConversation = await prisma.chatConversation.findUnique({
      where: { id: conversation.id },
      select: { leadId: true },
    });
    if (linkedConversation?.leadId) {
      await prisma.lead.update({
        where: { id: linkedConversation.leadId },
        data: { optedOutAt: new Date() },
      });
    }
  }
```

(Va después de `ensureLead` porque ahí es cuando la conversación ya tiene garantizado un `leadId` — antes de esa llamada, en el primer mensaje de una conversación nueva, todavía no existe el Lead.)

- [ ] **Step 8: Correr los tests y confirmar que pasan**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/chatbot.routing.test.ts`
Expected: PASS (8 tests — los 6 existentes + los 2 nuevos).

- [ ] **Step 9: Correr la suite completa y el typecheck**

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — toda la suite.

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/chatbot.service.ts apps/api/src/services/chatbot.service.test.ts apps/api/src/services/chatbot.routing.test.ts
git commit -m "feat: detect and apply lead opt-out from inbound messages"
```

---

### Task 3: `findReengagementCandidates`

**Files:**
- Create: `apps/api/src/services/remarketing.service.ts`
- Create: `apps/api/src/services/remarketing.service.test.ts`

**Interfaces:**
- Consumes: `withTenant` de `../config/tenant-context.js`; `prisma` de `../config/db.js`; `ChatChannel` de `@property-manager/adapters`.
- Produces: `export interface ReengagementCandidate { leadId: string; conversationId: string; channel: ChatChannel; externalId: string; }` y `export async function findReengagementCandidates(tenantId: string): Promise<ReengagementCandidate[]>`, ambos desde `apps/api/src/services/remarketing.service.ts`. Consumidos por las Tasks 4 y 5.

- [ ] **Step 1: Escribir el test (el módulo aún no existe)**

Crear `apps/api/src/services/remarketing.service.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import { findReengagementCandidates } from './remarketing.service.js';

const TENANT_ID = 'tenant_test_remarketing';

async function seedTenant() {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Remarketing Test Tenant', province: 'BC' },
  });
}

async function cleanup() {
  const conversations = await prisma.chatConversation.findMany({
    where: { tenantId: TENANT_ID },
    select: { id: true },
  });
  const conversationIds = conversations.map((c) => c.id);
  if (conversationIds.length > 0) {
    await prisma.conversationSlot.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await prisma.chatMessage.deleteMany({ where: { conversationId: { in: conversationIds } } });
  }
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.chatConversation.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
}

async function seedLeadWithConversation(options: {
  phone: string;
  status?: 'new_' | 'contacted' | 'qualified' | 'tour_scheduled' | 'converted' | 'lost';
  lastMessageDaysAgo: number;
  lastRemarketedAt?: Date;
  optedOutAt?: Date;
  withShowing?: boolean;
}) {
  const lead = await prisma.lead.create({
    data: {
      tenantId: TENANT_ID,
      phone: options.phone,
      source: 'web',
      status: options.status ?? 'new_',
      lastRemarketedAt: options.lastRemarketedAt,
      optedOutAt: options.optedOutAt,
    },
  });
  const conversation = await prisma.chatConversation.create({
    data: {
      tenantId: TENANT_ID,
      externalId: options.phone,
      channel: 'web',
      state: 'collecting_budget',
      leadId: lead.id,
    },
  });
  const messageDate = new Date(Date.now() - options.lastMessageDaysAgo * 24 * 60 * 60 * 1000);
  await prisma.chatMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'user',
      content: 'hola',
      createdAt: messageDate,
    },
  });
  if (options.withShowing) {
    await prisma.showing.create({
      data: { tenantId: TENANT_ID, leadId: lead.id, scheduledAt: new Date() },
    });
  }
  return { lead, conversation };
}

describe('findReengagementCandidates', () => {
  beforeEach(async () => {
    await cleanup();
    await seedTenant();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('includes a new_ lead inactive for 15 days with no showing', async () => {
    const { lead } = await seedLeadWithConversation({ phone: '+16045550001', lastMessageDaysAgo: 15 });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).toContain(lead.id);
  });

  it('excludes a lead inactive for only 10 days (below the 14-day threshold)', async () => {
    const { lead } = await seedLeadWithConversation({ phone: '+16045550002', lastMessageDaysAgo: 10 });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).not.toContain(lead.id);
  });

  it('excludes a lead that already has a showing scheduled', async () => {
    const { lead } = await seedLeadWithConversation({ phone: '+16045550003', lastMessageDaysAgo: 20, withShowing: true });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).not.toContain(lead.id);
  });

  it('excludes a lead already remarketed', async () => {
    const { lead } = await seedLeadWithConversation({
      phone: '+16045550004',
      lastMessageDaysAgo: 20,
      lastRemarketedAt: new Date(),
    });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).not.toContain(lead.id);
  });

  it('excludes a lead that opted out', async () => {
    const { lead } = await seedLeadWithConversation({
      phone: '+16045550005',
      lastMessageDaysAgo: 20,
      optedOutAt: new Date(),
    });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).not.toContain(lead.id);
  });

  it('excludes a lead whose status is tour_scheduled, converted, or lost', async () => {
    const { lead: touring } = await seedLeadWithConversation({ phone: '+16045550006', status: 'tour_scheduled', lastMessageDaysAgo: 20 });
    const { lead: converted } = await seedLeadWithConversation({ phone: '+16045550007', status: 'converted', lastMessageDaysAgo: 20 });
    const { lead: lost } = await seedLeadWithConversation({ phone: '+16045550008', status: 'lost', lastMessageDaysAgo: 20 });

    const candidates = await findReengagementCandidates(TENANT_ID);
    const ids = candidates.map((c) => c.leadId);

    expect(ids).not.toContain(touring.id);
    expect(ids).not.toContain(converted.id);
    expect(ids).not.toContain(lost.id);
  });

  it('includes a qualified lead', async () => {
    const { lead } = await seedLeadWithConversation({ phone: '+16045550009', status: 'qualified', lastMessageDaysAgo: 20 });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).toContain(lead.id);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/remarketing.service.test.ts`
Expected: FAIL — `Cannot find module './remarketing.service.js'`

- [ ] **Step 3: Implementar `findReengagementCandidates`**

Crear `apps/api/src/services/remarketing.service.ts`:

```typescript
/**
 * Fase 1B: reactivación de leads inactivos.
 *
 * Reutiliza la memoria de conversación ya guardada (ConversationSlot) y los
 * MessagingAdapter existentes por canal — sin infraestructura nueva más
 * allá de un job de BullMQ y dos campos nuevos en Lead.
 */
import type { ChatChannel } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { withTenant } from '../config/tenant-context.js';

export interface ReengagementCandidate {
  leadId: string;
  conversationId: string;
  channel: ChatChannel;
  externalId: string;
}

const INACTIVITY_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Un lead candidato: status temprano del funnel, sin showing agendado,
 * nunca remarketeado, no optó por no ser contactado, y su conversación
 * más reciente no tiene mensajes en los últimos 14 días. No hay un campo
 * denormalizado de "último mensaje", así que se calcula por lead.
 */
export async function findReengagementCandidates(tenantId: string): Promise<ReengagementCandidate[]> {
  return withTenant(prisma, tenantId, async (tx) => {
    const threshold = new Date(Date.now() - INACTIVITY_THRESHOLD_MS);
    const leads = await tx.lead.findMany({
      where: {
        tenantId,
        status: { in: ['new_', 'contacted', 'qualified'] },
        showings: { none: {} },
        lastRemarketedAt: null,
        optedOutAt: null,
      },
      include: {
        conversations: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          include: {
            messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });

    const candidates: ReengagementCandidate[] = [];
    for (const lead of leads) {
      const conversation = lead.conversations[0];
      const lastMessage = conversation?.messages[0];
      if (!conversation || !lastMessage) continue;
      if (lastMessage.createdAt >= threshold) continue;
      candidates.push({
        leadId: lead.id,
        conversationId: conversation.id,
        channel: conversation.channel as ChatChannel,
        externalId: conversation.externalId,
      });
    }
    return candidates;
  });
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/remarketing.service.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Correr el typecheck**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/remarketing.service.ts apps/api/src/services/remarketing.service.test.ts
git commit -m "feat: find lead re-engagement candidates"
```

---

### Task 4: Redactar y enviar el mensaje de reactivación

**Files:**
- Modify: `apps/api/src/services/remarketing.service.ts`
- Modify: `apps/api/src/services/remarketing.service.test.ts`

**Interfaces:**
- Consumes: `ReengagementCandidate` (Task 3); `sendWithRetry`, `getReplyAddressFromConversation` de `./chatbot.service.js` (ya exportadas); `GlmAdapter`, `MessagingAdapter` de `@property-manager/adapters`.
- Produces: `export async function draftReengagementMessage(glm: GlmAdapter, slots: Record<string, string>): Promise<string>` y `export async function sendReengagementMessage(messaging: MessagingAdapter, candidate: ReengagementCandidate, content: string): Promise<boolean>` (retorna `true` si el envío tuvo éxito), ambas desde `remarketing.service.ts`. Consumidas por la Task 5.

- [ ] **Step 1: Escribir los tests (fallan — las funciones no existen)**

En `apps/api/src/services/remarketing.service.test.ts`, agregar los imports necesarios al inicio del archivo:

```typescript
import type { GlmAdapter, GlmReasoningRequest, MessagingAdapter, OutboundMessage } from '@property-manager/adapters';
import { vi } from 'vitest';
import { draftReengagementMessage, sendReengagementMessage } from './remarketing.service.js';
```

Y agregar, después del `describe('findReengagementCandidates', ...)` existente:

```typescript
function fakeGlm(content: string): GlmAdapter {
  return {
    name: 'glm',
    reason: vi.fn(async (_request: GlmReasoningRequest) => ({ content })),
    extractReceipt: vi.fn(),
  } as unknown as GlmAdapter;
}

function fakeMessaging(options: { shouldFail?: boolean } = {}): MessagingAdapter & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    channel: 'web',
    sent,
    async send(message: OutboundMessage) {
      if (options.shouldFail) throw new Error('simulated send failure');
      sent.push(message);
      return { messageId: `msg_${sent.length}` };
    },
    async parseWebhook() {
      throw new Error('not used in this test');
    },
  };
}

describe('draftReengagementMessage', () => {
  it('returns the trimmed content from the GLM adapter', async () => {
    const glm = fakeGlm('  ¡Hola! ¿Sigues buscando en Surrey?  ');

    const message = await draftReengagementMessage(glm, { preferred_area: 'Surrey', budget: '1800' });

    expect(message).toBe('¡Hola! ¿Sigues buscando en Surrey?');
    expect(glm.reason).toHaveBeenCalledTimes(1);
  });
});

describe('sendReengagementMessage', () => {
  beforeEach(async () => {
    await cleanup();
    await seedTenant();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('creates a ChatMessage, sends it, and marks lastRemarketedAt on success', async () => {
    const { lead, conversation } = await seedLeadWithConversation({ phone: '+16045550010', lastMessageDaysAgo: 20 });
    const messaging = fakeMessaging();
    const candidate = { leadId: lead.id, conversationId: conversation.id, channel: 'web' as const, externalId: conversation.externalId };

    const result = await sendReengagementMessage(messaging, candidate, 'Hola, ¿sigues buscando?');

    expect(result).toBe(true);
    expect(messaging.sent).toHaveLength(1);
    const updatedLead = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updatedLead.lastRemarketedAt).not.toBeNull();
    const messages = await prisma.chatMessage.findMany({ where: { conversationId: conversation.id, role: 'assistant' } });
    expect(messages).toHaveLength(1);
    expect(messages[0].deliveryStatus).toBe('sent');
  });

  it('does not mark lastRemarketedAt when the send fails', async () => {
    const { lead, conversation } = await seedLeadWithConversation({ phone: '+16045550011', lastMessageDaysAgo: 20 });
    const messaging = fakeMessaging({ shouldFail: true });
    const candidate = { leadId: lead.id, conversationId: conversation.id, channel: 'web' as const, externalId: conversation.externalId };

    const result = await sendReengagementMessage(messaging, candidate, 'Hola, ¿sigues buscando?');

    expect(result).toBe(false);
    const updatedLead = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updatedLead.lastRemarketedAt).toBeNull();
    const messages = await prisma.chatMessage.findMany({ where: { conversationId: conversation.id, role: 'assistant' } });
    expect(messages[0].deliveryStatus).toBe('failed');
  });
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/remarketing.service.test.ts`
Expected: FAIL — `draftReengagementMessage`/`sendReengagementMessage` no exportadas.

- [ ] **Step 3: Implementar ambas funciones**

En `apps/api/src/services/remarketing.service.ts`, agregar los imports (junto a los existentes):

```typescript
import type { GlmAdapter, MessagingAdapter } from '@property-manager/adapters';
import { getReplyAddressFromConversation, sendWithRetry } from './chatbot.service.js';
```

Y agregar al final del archivo:

```typescript
const DRAFT_SYSTEM_PROMPT = `Eres un asistente de bienes raíces amable y profesional. Redacta un mensaje corto (1-2 líneas) para retomar contacto con un prospecto que dejó de responder hace un tiempo. No suenes a marketing masivo ni a plantilla genérica. Si el perfil incluye área, presupuesto, o tipo de unidad, menciónalos brevemente para mostrar que recuerdas la conversación. Si el perfil está vacío, pregunta qué está buscando. Responde solo con el texto del mensaje, sin comillas ni formato adicional.`;

export async function draftReengagementMessage(
  glm: GlmAdapter,
  slots: Record<string, string>,
): Promise<string> {
  const response = await glm.reason({
    systemPrompt: DRAFT_SYSTEM_PROMPT,
    userPrompt: JSON.stringify({ capturedProfile: slots }),
    temperature: 0.4,
  });
  return response.content.trim();
}

/**
 * Envía el mensaje de reactivación y registra el resultado. Si falla, NO
 * marca lastRemarketedAt — el lead sigue elegible y se reintenta la
 * siguiente corrida semanal del job, sin lógica de reintento especial.
 */
export async function sendReengagementMessage(
  messaging: MessagingAdapter,
  candidate: ReengagementCandidate,
  content: string,
): Promise<boolean> {
  const assistantMessage = await prisma.chatMessage.create({
    data: {
      conversationId: candidate.conversationId,
      role: 'assistant',
      content,
      deliveryStatus: 'pending',
    },
  });

  try {
    const to = getReplyAddressFromConversation(candidate.externalId);
    const result = await sendWithRetry(() => messaging.send({ to, body: content, channel: candidate.channel }));
    await prisma.chatMessage.update({
      where: { id: assistantMessage.id },
      data: {
        deliveryStatus: 'sent',
        providerMessageIds: [result.messageId],
      },
    });
    await prisma.lead.update({
      where: { id: candidate.leadId },
      data: { lastRemarketedAt: new Date() },
    });
    return true;
  } catch (error) {
    await prisma.chatMessage.update({
      where: { id: assistantMessage.id },
      data: {
        deliveryStatus: 'failed',
        deliveryError: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown delivery error',
        deliveryAttempts: 1,
      },
    });
    return false;
  }
}
```

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/remarketing.service.test.ts`
Expected: PASS (10 tests — los 7 de la Task 3 + 3 nuevos).

- [ ] **Step 5: Correr el typecheck**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/remarketing.service.ts apps/api/src/services/remarketing.service.test.ts
git commit -m "feat: draft and send reengagement messages"
```

---

### Task 5: Orquestación (`runWeeklyReengagement`)

**Files:**
- Modify: `apps/api/src/services/remarketing.service.ts`
- Modify: `apps/api/src/services/remarketing.service.test.ts`

**Interfaces:**
- Consumes: `findReengagementCandidates`, `draftReengagementMessage`, `sendReengagementMessage` (Tasks 3-4); `ChatChannel`, `GlmAdapter`, `MessagingAdapter` de `@property-manager/adapters`.
- Produces: `export async function runWeeklyReengagement(tenantId: string, deps: { glm: GlmAdapter; messaging: Record<ChatChannel, MessagingAdapter> }): Promise<{ sent: number; skipped: number }>`, desde `remarketing.service.ts`. Consumida por la Task 6 (worker de BullMQ).

- [ ] **Step 1: Escribir el test end-to-end (falla — la función no existe)**

En `apps/api/src/services/remarketing.service.test.ts`, agregar el import:

```typescript
import { draftReengagementMessage, runWeeklyReengagement, sendReengagementMessage } from './remarketing.service.js';
```

(reemplaza el import de la Task 4, que ahora incluye `runWeeklyReengagement`).

Y agregar, al final del archivo:

```typescript
describe('runWeeklyReengagement', () => {
  beforeEach(async () => {
    await cleanup();
    await seedTenant();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('sends to the eligible lead only, skipping one with a showing, one already remarketed, and one opted out', async () => {
    const { lead: eligible } = await seedLeadWithConversation({ phone: '+16045550020', lastMessageDaysAgo: 20 });
    await seedLeadWithConversation({ phone: '+16045550021', lastMessageDaysAgo: 20, withShowing: true });
    await seedLeadWithConversation({ phone: '+16045550022', lastMessageDaysAgo: 20, lastRemarketedAt: new Date() });
    await seedLeadWithConversation({ phone: '+16045550023', lastMessageDaysAgo: 20, optedOutAt: new Date() });

    const glm = fakeGlm('¡Hola de nuevo! ¿Sigues buscando?');
    const messaging = fakeMessaging();

    const result = await runWeeklyReengagement(TENANT_ID, {
      glm,
      messaging: { web: messaging } as never,
    });

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(messaging.sent).toHaveLength(1);
    const updatedEligible = await prisma.lead.findUniqueOrThrow({ where: { id: eligible.id } });
    expect(updatedEligible.lastRemarketedAt).not.toBeNull();
  });

  it('counts a candidate as skipped when there is no adapter for its channel', async () => {
    await seedLeadWithConversation({ phone: '+16045550024', lastMessageDaysAgo: 20 });
    const glm = fakeGlm('¡Hola de nuevo!');

    const result = await runWeeklyReengagement(TENANT_ID, { glm, messaging: {} as never });

    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  it('skips a candidate whose draft fails (GLM outage) without blocking the rest of the run', async () => {
    const { lead: broken } = await seedLeadWithConversation({ phone: '+16045550025', lastMessageDaysAgo: 20 });
    const { lead: healthy } = await seedLeadWithConversation({ phone: '+16045550026', lastMessageDaysAgo: 20 });
    const throwingGlm = {
      name: 'glm',
      reason: vi.fn()
        .mockRejectedValueOnce(new Error('simulated GLM outage'))
        .mockResolvedValueOnce({ content: '¡Hola de nuevo!' }),
      extractReceipt: vi.fn(),
    } as unknown as GlmAdapter;
    const messaging = fakeMessaging();

    const result = await runWeeklyReengagement(TENANT_ID, { glm: throwingGlm, messaging: { web: messaging } as never });

    expect(result).toEqual({ sent: 1, skipped: 1 });
    const brokenLead = await prisma.lead.findUniqueOrThrow({ where: { id: broken.id } });
    expect(brokenLead.lastRemarketedAt).toBeNull();
    const healthyLead = await prisma.lead.findUniqueOrThrow({ where: { id: healthy.id } });
    expect(healthyLead.lastRemarketedAt).not.toBeNull();
  });
});
```

(El orden de `mockRejectedValueOnce`/`mockResolvedValueOnce` asume que `findReengagementCandidates` devuelve los leads en el orden en que se crearon — igual que en el resto de los tests de este archivo, que no dependen de un orden específico salvo aquí; si al correr el test el orden real difiere, ajusta cuál mock corresponde a cuál lead, el punto del test es que un fallo en un candidato no bloquea a los demás, no el orden exacto.)

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/remarketing.service.test.ts`
Expected: FAIL — `runWeeklyReengagement` no exportada.

- [ ] **Step 3: Implementar la orquestación**

En `apps/api/src/services/remarketing.service.ts`, cambiar el import de `@property-manager/adapters` para incluir `GlmAdapter`:

```typescript
import type { ChatChannel, GlmAdapter, MessagingAdapter } from '@property-manager/adapters';
```

Y agregar al final del archivo:

```typescript
/**
 * Orquesta un ciclo completo de reactivación para un tenant: busca
 * candidatos, redacta y envía un mensaje a cada uno secuencialmente (no
 * en paralelo, para no ráfaguear al proveedor de mensajería).
 */
export async function runWeeklyReengagement(
  tenantId: string,
  deps: { glm: GlmAdapter; messaging: Record<ChatChannel, MessagingAdapter> },
): Promise<{ sent: number; skipped: number }> {
  const candidates = await findReengagementCandidates(tenantId);
  let sent = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const messaging = deps.messaging[candidate.channel];
    if (!messaging) {
      skipped++;
      continue;
    }
    // Un candidato que falla (ej. GLM caído) no debe tumbar la corrida
    // completa — se salta y se reintenta la próxima semana, igual que un
    // fallo de envío (ver sendReengagementMessage).
    try {
      const slots = await prisma.conversationSlot.findMany({
        where: { conversationId: candidate.conversationId },
      });
      const slotMap = Object.fromEntries(slots.map((slot) => [slot.key, slot.value]));
      const content = await draftReengagementMessage(deps.glm, slotMap);
      const wasSent = await sendReengagementMessage(messaging, candidate, content);
      if (wasSent) sent++;
      else skipped++;
    } catch (error) {
      console.error(`[Remarketing] Candidato ${candidate.leadId} falló, se reintenta la próxima corrida:`, error);
      skipped++;
    }
  }

  return { sent, skipped };
}
```

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/remarketing.service.test.ts`
Expected: PASS (13 tests — los 10 anteriores + 3 nuevos).

- [ ] **Step 5: Correr la suite completa y el typecheck**

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS.

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/remarketing.service.ts apps/api/src/services/remarketing.service.test.ts
git commit -m "feat: orchestrate the weekly lead reengagement run"
```

---

### Task 6: Job de BullMQ y arranque del servidor

**Files:**
- Modify: `apps/api/src/jobs/queues.ts`
- Modify: `apps/api/src/jobs/worker.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `runWeeklyReengagement` (Task 5); `getAdapters` de `../config/adapters.js`; `prisma` de `../config/db.js`.
- Produces: `remarketingQueue` (BullMQ `Queue`) y `scheduleWeeklyRemarketing(): Promise<void>`, ambas exportadas desde `apps/api/src/jobs/queues.ts`.

Este task no tiene un ciclo TDD propio (es cableado de infraestructura, sin
lógica de negocio nueva — toda la lógica ya está probada en las Tasks 3-5).
Se verifica con el typecheck y arrancando el servidor localmente.

- [ ] **Step 1: Agregar la cola y la función de scheduling**

En `apps/api/src/jobs/queues.ts`, agregar `remarketing` a `QUEUE_NAMES`:

```typescript
export const QUEUE_NAMES = {
  reconciliation: 'reconciliation',
  bankNotification: 'bank-notification',
  remarketing: 'remarketing',
} as const;
```

Y agregar, después de la definición de `bankNotificationQueue`:

```typescript
/** Job semanal de reactivación de leads (Fase 1B) — sin datos por tenant, corre para todos. */
export interface RemarketingJobData {
  triggeredBy: 'cron' | 'manual';
}

export const remarketingQueue = new Queue<RemarketingJobData, unknown, string>(QUEUE_NAMES.remarketing, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 20 },
  },
});

/**
 * Schedulea el job recurrente de reactivación semanal. A diferencia de
 * `scheduleDailyReconciliation`, no recibe tenantId: el worker itera todos
 * los tenants en cada corrida, así que basta con programarlo una sola vez
 * al arrancar el servidor (BullMQ reemplaza el repeatable job existente
 * si ya estaba programado, gracias al jobId fijo).
 */
export async function scheduleWeeklyRemarketing(): Promise<void> {
  await remarketingQueue.add(
    'weekly-remarketing',
    { triggeredBy: 'cron' },
    {
      // Cada lunes a las 09:00 AM (horario de Vancouver).
      repeat: { pattern: '0 9 * * 1', tz: 'America/Vancouver' },
      jobId: 'weekly-remarketing',
    },
  );
}
```

- [ ] **Step 2: Agregar el worker**

En `apps/api/src/jobs/worker.ts`, agregar los imports:

```typescript
import { prisma } from '../config/db.js';
import { runWeeklyReengagement } from '../services/remarketing.service.js';
```

Y agregar `RemarketingJobData` al import existente de `./queues.js`:

```typescript
import { QUEUE_NAMES, type BankNotificationJobData, type ReconciliationJobData, type RemarketingJobData } from './queues.js';
```

Dentro de `startWorkers()`, después de la definición de `bankWorker` y antes de los `.on('failed', ...)`:

```typescript
  // Worker de reactivación semanal de leads (Fase 1B).
  const remarketingWorker = new Worker<RemarketingJobData>(
    QUEUE_NAMES.remarketing,
    async () => {
      const adapters = getAdapters();
      const tenants = await prisma.tenant.findMany({ select: { id: true } });
      let totalSent = 0;
      let totalSkipped = 0;
      for (const tenant of tenants) {
        const result = await runWeeklyReengagement(tenant.id, {
          glm: adapters.glm,
          messaging: adapters.messaging,
        });
        totalSent += result.sent;
        totalSkipped += result.skipped;
      }
      console.log(`[Remarketing] Corrida semanal: ${totalSent} enviados, ${totalSkipped} omitidos, ${tenants.length} tenants`);
      return { totalSent, totalSkipped };
    },
    { connection: redis, concurrency: 1 },
  );
```

Y agregar su handler de error junto a los otros dos:

```typescript
  remarketingWorker.on('failed', (job, err) => {
    console.error(`[Remarketing] Job falló (${job?.id}):`, err.message);
  });
```

- [ ] **Step 3: Programar el job al arrancar el servidor**

En `apps/api/src/server.ts`, agregar el import:

```typescript
import { scheduleWeeklyRemarketing } from './jobs/queues.js';
```

Y dentro del callback de `app.listen`, después de `startWorkers();`:

```typescript
  void scheduleWeeklyRemarketing().catch((err) => {
    console.error('No se pudo programar el job de remarketing:', err);
  });
```

- [ ] **Step 4: Verificar que compila y la suite sigue verde**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — toda la suite (este task no agrega tests nuevos, solo cablea infraestructura ya probada).

- [ ] **Step 5: Verificar manualmente que el servidor arranca sin errores**

Con Postgres y Redis corriendo (`pnpm db:up` si hace falta):

Run: `pnpm --filter @property-manager/api dev` (déjalo correr ~5 segundos, luego detén con Ctrl+C)
Expected: en la consola aparece la línea de arranque de la API sin errores ni stack traces; no hace falta ver el log de `[Remarketing]` todavía (el job corre hasta el próximo lunes 9am hora de Vancouver, o cuando se dispare manualmente).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/queues.ts apps/api/src/jobs/worker.ts apps/api/src/server.ts
git commit -m "feat: schedule the weekly lead reengagement job"
```

---

### Task 7: Regresión completa

**Files:** ninguno nuevo — solo verificación.

- [ ] **Step 1: Typecheck de todo el monorepo**

Run: `pnpm -r exec tsc --noEmit`
Expected: sin errores en ningún paquete.

- [ ] **Step 2: Suite completa de `apps/api`**

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — todos los tests (los ya existentes + los de Fase 1B).

- [ ] **Step 3: Commit (si algún ajuste fue necesario durante la regresión)**

Si el Step 1-2 no requirió cambios, no hay nada que comitear — este task solo confirma el estado verde acumulado de los Tasks 1-6.
