# Fase 2A: Aplicación de renta post-showing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cuando el broker confirma manualmente que un showing ocurrió, se crea una aplicación de renta con token público y se le manda el link seguro al prospecto; al enviarla, se notifica al broker por email y chat.

**Architecture:** Un servicio de dominio nuevo (`rental-application.service.ts`) con funciones puras/testables por separado (crear invitación, resolver destinatario de notificación, validar el envío), más rutas autenticadas en `showings.ts`, rutas públicas en el `publicRouter` existente, y una página pública nueva en el frontend que sigue el patrón de `ShortlistPage`.

**Tech Stack:** Node.js/Express/TypeScript, Prisma, Vitest, React + Vite + TanStack Query.

Spec de referencia: [`docs/superpowers/specs/2026-08-08-fase-2a-post-showing-application-design.md`](../specs/2026-08-08-fase-2a-post-showing-application-design.md).

## Global Constraints

- Los 3 consentimientos (aplicación, buró de crédito, police check) son **obligatorios**: sin los 3, el envío se rechaza con 400. Se guardan como **timestamps individuales**, no como booleans.
- El token nunca se persiste en claro — solo su hash SHA-256, igual que `hashShortlistToken` en `shortlist.service.ts`.
- **Expiración del token: 14 días**, mismo valor que el shortlist.
- El archivo de identificación se sube como **base64 dentro del JSON body** (no multipart), tope `1_500_000` caracteres, igual que `fileBase64` en `documents.ts`.
- **El canal `web` no puede recibir mensajes salientes** (su adapter es un mock permanente). Si la conversación del lead es `web`, o el lead no tiene conversación, el showing igual se marca `completed` y la aplicación igual se crea — se reporta que el link no se entregó.
- Las notificaciones al broker (email y chat) son **best-effort e independientes**: un fallo en cualquiera se loguea y **nunca** hace fallar la respuesta HTTP al prospecto.
- **El error handler global de `app.ts` convierte todo `throw` en 500.** Para devolver 409/400/404 como pide el spec, las funciones de servicio devuelven un **resultado discriminado** (`{ ok: false; status; error }`) y la ruta lo mapea — mismo patrón que `TwilioClaimResult` en `routes/webhooks.ts`. **No lanzar excepciones para errores esperados.**
- Tests: solo automatizados, Prisma real contra la DB de test + adapters mock/spy inyectados — mismo patrón que `remarketing.service.test.ts`. Nunca `vi.mock` de Prisma.
- Comentarios en español, solo donde el porqué no sea obvio.
- Cada tarea deja el repo verde: `tsc --noEmit` limpio y la suite completa de `apps/api` pasando.

---

### Task 1: Modelo `RentalApplication` y campos de notificación en `User`

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: migración de Prisma (generada en el Step 2)

**Interfaces:**
- Produces: modelo `RentalApplication` y los campos `User.notificationChannel: ChatChannel | null` / `User.notificationAddress: string | null`. Consumidos por las Tasks 2-6.

- [ ] **Step 1: Agregar el modelo y los campos**

En `apps/api/prisma/schema.prisma`, agregar el modelo nuevo al final del archivo:

```prisma
model RentalApplication {
  id        String   @id @default(cuid())
  tenantId  String
  showingId String   @unique
  leadId    String
  unitId    String?

  tokenHash String   @unique
  expiresAt DateTime

  status    String   @default("invited") // invited | submitted

  // Datos capturados cuando el prospecto envía el formulario
  annualIncome         Int?
  employerName         String?
  references           String?
  idDocumentStorageKey String?

  applicantFullName    String?
  // Los tres consentimientos se guardan como timestamps individuales (no un
  // solo boolean): para un dato de cumplimiento importa cuándo se otorgó
  // cada autorización por separado, no solo que "aceptó".
  consentApplicationAt DateTime?
  consentCreditCheckAt DateTime?
  consentPoliceCheckAt DateTime?

  submittedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  showing Showing @relation(fields: [showingId], references: [id], onDelete: Cascade)
  lead    Lead    @relation(fields: [leadId], references: [id], onDelete: Cascade)
  unit    Unit?   @relation(fields: [unitId], references: [id])

  @@index([tenantId, status])
  @@map("rental_applications")
}
```

En `model User`, agregar los dos campos justo después de `lastLoginAt DateTime?`:

```prisma
  // Canal opcional para notificaciones proactivas al staff (ej. aviso de
  // aplicación recibida). Sin esto configurado, solo se notifica por email.
  notificationChannel ChatChannel?
  notificationAddress String?
```

Agregar las back-relations (Prisma las exige). En `model Tenant`, junto a `shortlists PropertyShortlist[]`:

```prisma
  rentalApplications    RentalApplication[]
```

En `model Showing`, junto a `unit Unit? @relation(...)`:

```prisma
  rentalApplication RentalApplication?
```

En `model Lead`, junto a `showings Showing[]`:

```prisma
  rentalApplications RentalApplication[]
```

En `model Unit`, junto a `listingPhotos ListingPhoto[]`:

```prisma
  rentalApplications RentalApplication[]
```

- [ ] **Step 2: Generar y aplicar la migración**

Con Postgres corriendo (`pnpm db:up` si hace falta):

Run: `pnpm --filter @property-manager/api exec prisma migrate dev --name add_rental_applications`
Expected: crea `apps/api/prisma/migrations/<timestamp>_add_rental_applications/migration.sql` sin errores.

Si `migrate dev` se rehúsa a correr por no ser un shell interactivo (ya pasó antes en este repo): genera el SQL con `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --shadow-database-url "$DATABASE_URL"`, escríbelo a mano en `apps/api/prisma/migrations/<timestamp>_add_rental_applications/migration.sql`, y aplícalo con `prisma migrate deploy`.

- [ ] **Step 3: Verificar que todo compila y la suite sigue verde**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — toda la suite existente (los campos nuevos son opcionales, no rompen nada).

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat: add RentalApplication model and staff notification channel fields"
```

---

### Task 2: Crear la invitación de aplicación (token + persistencia)

**Files:**
- Create: `apps/api/src/services/rental-application.service.ts`
- Create: `apps/api/src/services/rental-application.service.test.ts`

**Interfaces:**
- Consumes: `prisma` de `../config/db.js`.
- Produces: desde `apps/api/src/services/rental-application.service.ts`:
  - `export function hashApplicationToken(token: string): string`
  - `export async function createRentalApplication(input: { tenantId: string; showingId: string; leadId: string; unitId?: string | null }): Promise<{ application: RentalApplication; token: string }>` (el tipo `RentalApplication` viene de `@prisma/client`)
  - `export async function getPublicRentalApplication(token: string)` — devuelve la aplicación con `showing`/`unit`/`tenant` incluidos, o `null` si el token no existe o expiró.

  Consumidos por las Tasks 3, 4 y 5.

- [ ] **Step 1: Escribir el test (el módulo aún no existe)**

Crear `apps/api/src/services/rental-application.service.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import {
  createRentalApplication,
  getPublicRentalApplication,
  hashApplicationToken,
} from './rental-application.service.js';

const TENANT_ID = 'tenant_test_rental_application';

async function seedShowing(options: { showingId?: string } = {}) {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Rental Application Test Tenant', province: 'BC' },
  });
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, phone: '+16045557001', source: 'web', status: 'new_' },
  });
  const showing = await prisma.showing.create({
    data: {
      ...(options.showingId ? { id: options.showingId } : {}),
      tenantId: TENANT_ID,
      leadId: lead.id,
      scheduledAt: new Date(),
      status: 'confirmed',
    },
  });
  return { lead, showing };
}

async function cleanup() {
  await prisma.rentalApplication.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
}

describe('rental application invitations', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('creates an application with a hashed token and a 14-day expiry', async () => {
    const { lead, showing } = await seedShowing();

    const { application, token } = await createRentalApplication({
      tenantId: TENANT_ID,
      showingId: showing.id,
      leadId: lead.id,
    });

    expect(token).toBeTruthy();
    expect(application.tokenHash).toBe(hashApplicationToken(token));
    expect(application.tokenHash).not.toBe(token);
    expect(application.status).toBe('invited');
    const daysUntilExpiry = (application.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysUntilExpiry).toBeGreaterThan(13.9);
    expect(daysUntilExpiry).toBeLessThan(14.1);
  });

  it('looks up an application by its plaintext token', async () => {
    const { lead, showing } = await seedShowing();
    const { token } = await createRentalApplication({
      tenantId: TENANT_ID,
      showingId: showing.id,
      leadId: lead.id,
    });

    const found = await getPublicRentalApplication(token);

    expect(found?.showingId).toBe(showing.id);
  });

  it('returns null for an unknown token', async () => {
    expect(await getPublicRentalApplication('not-a-real-token')).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const { lead, showing } = await seedShowing();
    const { application, token } = await createRentalApplication({
      tenantId: TENANT_ID,
      showingId: showing.id,
      leadId: lead.id,
    });
    await prisma.rentalApplication.update({
      where: { id: application.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await getPublicRentalApplication(token)).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/rental-application.service.test.ts`
Expected: FAIL — `Cannot find module './rental-application.service.js'`

- [ ] **Step 3: Implementar el servicio**

Crear `apps/api/src/services/rental-application.service.ts`:

```typescript
/**
 * Fase 2A: aplicación de renta post-showing.
 *
 * Sigue el mismo patrón de token público que PropertyShortlist: el token
 * en claro solo existe en el link que recibe el prospecto; en la base solo
 * vive su hash.
 */
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../config/db.js';

const DAY = 24 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 14 * DAY;

export function hashApplicationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createRentalApplication(input: {
  tenantId: string;
  showingId: string;
  leadId: string;
  unitId?: string | null;
}) {
  const token = randomBytes(24).toString('base64url');
  const application = await prisma.rentalApplication.create({
    data: {
      tenantId: input.tenantId,
      showingId: input.showingId,
      leadId: input.leadId,
      unitId: input.unitId ?? null,
      tokenHash: hashApplicationToken(token),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    },
  });
  return { application, token };
}

export async function getPublicRentalApplication(token: string) {
  return prisma.rentalApplication.findFirst({
    where: { tokenHash: hashApplicationToken(token), expiresAt: { gt: new Date() } },
    include: {
      showing: { select: { id: true, scheduledAt: true } },
      unit: { select: { name: true, property: { select: { name: true, address: true, city: true, province: true } } } },
      tenant: { select: { name: true } },
    },
  });
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/rental-application.service.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Verificar typecheck**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/rental-application.service.ts apps/api/src/services/rental-application.service.test.ts
git commit -m "feat: create rental application invitations with hashed tokens"
```

---

### Task 3: Resolver el destinatario de la notificación

Función pura, sin I/O, que decide a quién notificar. Se separa de su uso para poder probar el orden de precedencia sin montar todo el flujo.

**Files:**
- Modify: `apps/api/src/services/rental-application.service.ts`
- Modify: `apps/api/src/services/rental-application.service.test.ts`

**Interfaces:**
- Produces: desde `rental-application.service.ts`:
  ```typescript
  export interface NotifiableStaff {
    id: string;
    email: string;
    notificationChannel: string | null;
    notificationAddress: string | null;
  }

  export function resolveApplicationNotifyTargets(input: {
    brokerUserId: string | null;
    assignedUserId: string | null;
    staff: NotifiableStaff[];
    propertyManagerIds: string[];
  }): NotifiableStaff[]
  ```
  Consumida por la Task 5.

- [ ] **Step 1: Escribir el test (la función aún no existe)**

En `apps/api/src/services/rental-application.service.test.ts`, agregar el import de `resolveApplicationNotifyTargets` y `type NotifiableStaff` al bloque de imports existente de `./rental-application.service.js`, y agregar al final del archivo:

```typescript
describe('resolveApplicationNotifyTargets', () => {
  const broker: NotifiableStaff = { id: 'u_broker', email: 'broker@test.ca', notificationChannel: null, notificationAddress: null };
  const assignee: NotifiableStaff = { id: 'u_assignee', email: 'assignee@test.ca', notificationChannel: null, notificationAddress: null };
  const pmA: NotifiableStaff = { id: 'u_pm_a', email: 'pma@test.ca', notificationChannel: null, notificationAddress: null };
  const pmB: NotifiableStaff = { id: 'u_pm_b', email: 'pmb@test.ca', notificationChannel: null, notificationAddress: null };
  const staff = [broker, assignee, pmA, pmB];

  it('prefers the showing broker over everyone else', () => {
    expect(resolveApplicationNotifyTargets({
      brokerUserId: 'u_broker',
      assignedUserId: 'u_assignee',
      staff,
      propertyManagerIds: ['u_pm_a', 'u_pm_b'],
    })).toEqual([broker]);
  });

  it('falls back to the lead assignee when there is no broker', () => {
    expect(resolveApplicationNotifyTargets({
      brokerUserId: null,
      assignedUserId: 'u_assignee',
      staff,
      propertyManagerIds: ['u_pm_a', 'u_pm_b'],
    })).toEqual([assignee]);
  });

  it('falls back to every property manager when there is neither broker nor assignee', () => {
    expect(resolveApplicationNotifyTargets({
      brokerUserId: null,
      assignedUserId: null,
      staff,
      propertyManagerIds: ['u_pm_a', 'u_pm_b'],
    })).toEqual([pmA, pmB]);
  });

  it('skips an id that does not resolve to a known staff member', () => {
    expect(resolveApplicationNotifyTargets({
      brokerUserId: 'u_deleted',
      assignedUserId: 'u_assignee',
      staff,
      propertyManagerIds: ['u_pm_a'],
    })).toEqual([assignee]);
  });

  it('returns an empty list when nothing resolves', () => {
    expect(resolveApplicationNotifyTargets({
      brokerUserId: null,
      assignedUserId: null,
      staff: [],
      propertyManagerIds: [],
    })).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/rental-application.service.test.ts`
Expected: FAIL — `resolveApplicationNotifyTargets is not exported` / no está definida.

- [ ] **Step 3: Implementar la función**

En `apps/api/src/services/rental-application.service.ts`, agregar al final:

```typescript
export interface NotifiableStaff {
  id: string;
  email: string;
  notificationChannel: string | null;
  notificationAddress: string | null;
}

/**
 * A quién avisarle que llegó una aplicación, en orden de cercanía al
 * showing: el broker que lo atendió, si no el dueño del lead, y si no
 * todos los property managers del tenant. Un id que ya no corresponde a
 * ningún usuario (staff dado de baja) cae al siguiente nivel en vez de
 * dejar la notificación sin destinatario.
 */
export function resolveApplicationNotifyTargets(input: {
  brokerUserId: string | null;
  assignedUserId: string | null;
  staff: NotifiableStaff[];
  propertyManagerIds: string[];
}): NotifiableStaff[] {
  const byId = new Map(input.staff.map((member) => [member.id, member]));

  const broker = input.brokerUserId ? byId.get(input.brokerUserId) : undefined;
  if (broker) return [broker];

  const assignee = input.assignedUserId ? byId.get(input.assignedUserId) : undefined;
  if (assignee) return [assignee];

  return input.propertyManagerIds
    .map((id) => byId.get(id))
    .filter((member): member is NotifiableStaff => member !== undefined);
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/rental-application.service.test.ts`
Expected: PASS (9 tests — los 4 de la Task 2 + 5 nuevos).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/rental-application.service.ts apps/api/src/services/rental-application.service.test.ts
git commit -m "feat: resolve which staff member to notify about an application"
```

---

### Task 4: Completar el showing y mandar el link al prospecto

**Files:**
- Modify: `apps/api/src/services/rental-application.service.ts`
- Modify: `apps/api/src/services/rental-application.service.test.ts`
- Modify: `apps/api/src/routes/showings.ts`

**Interfaces:**
- Consumes: `createRentalApplication` (Task 2); `getReplyAddressFromConversation` y `sendWithRetry` de `./chatbot.service.js` (ya exportadas); `MessagingAdapter`/`ChatChannel` de `@property-manager/adapters`; `getEnv` de `../config/env.js`.
- Produces: desde `rental-application.service.ts`:
  ```typescript
  export type CompleteShowingResult =
    | { ok: false; status: 404 | 409; error: string }
    | { ok: true; applicationId: string; linkDelivered: boolean; applicationUrl: string };

  export async function completeShowingAndInvite(
    input: { showingId: string; tenantId: string; actorUserId: string },
    deps: { messaging: Record<ChatChannel, MessagingAdapter> },
  ): Promise<CompleteShowingResult>
  ```
  Consumida por la ruta `POST /showings/:id/complete`.

- [ ] **Step 1: Escribir el test (la función aún no existe)**

En `apps/api/src/services/rental-application.service.test.ts`, agregar al bloque de imports:

```typescript
import type { ChatChannel, MessagingAdapter, OutboundMessage } from '@property-manager/adapters';
```

y agregar `completeShowingAndInvite` al import existente de `./rental-application.service.js`.

Agregar el helper y los tests al final del archivo:

```typescript
function fakeMessaging(options: { shouldFail?: boolean } = {}) {
  const sent: OutboundMessage[] = [];
  const adapter: MessagingAdapter = {
    channel: 'telegram',
    async send(message: OutboundMessage) {
      if (options.shouldFail) throw new Error('simulated send failure');
      sent.push(message);
      return { messageId: `msg_${sent.length}` };
    },
    async parseWebhook() {
      throw new Error('not used in this test');
    },
  };
  // `email` tiene que estar aquí aunque este test no lo use: la Task 5
  // reutiliza este helper y su ruta de notificación llama a
  // `messaging.email.send`. Sin él, ese acceso reventaría con TypeError
  // dentro de un try/catch y el test pasaría por la razón equivocada.
  return {
    sent,
    messaging: { telegram: adapter, web: adapter, email: adapter } as unknown as Record<ChatChannel, MessagingAdapter>,
  };
}

async function seedShowingWithConversation(channel: 'telegram' | 'web') {
  const { lead, showing } = await seedShowing();
  await prisma.chatConversation.create({
    data: {
      tenantId: TENANT_ID,
      externalId: `${channel}:900100`,
      channel,
      state: 'handoff',
      leadId: lead.id,
    },
  });
  return { lead, showing };
}

describe('completeShowingAndInvite', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('marks the showing completed, creates the application, and sends the link', async () => {
    const { showing } = await seedShowingWithConversation('telegram');
    const { sent, messaging } = fakeMessaging();

    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' },
      { messaging },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.linkDelivered).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain(result.applicationUrl);

    const updated = await prisma.showing.findUniqueOrThrow({ where: { id: showing.id } });
    expect(updated.status).toBe('completed');
    const application = await prisma.rentalApplication.findFirst({ where: { showingId: showing.id } });
    expect(application?.status).toBe('invited');
  });

  it('still completes the showing and creates the application when the channel is web (no outbound push)', async () => {
    const { showing } = await seedShowingWithConversation('web');
    const { sent, messaging } = fakeMessaging();

    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' },
      { messaging },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.linkDelivered).toBe(false);
    expect(sent).toHaveLength(0);
    const application = await prisma.rentalApplication.findFirst({ where: { showingId: showing.id } });
    expect(application).not.toBeNull();
  });

  it('still creates the application when the lead has no conversation at all', async () => {
    const { showing } = await seedShowing();
    const { messaging } = fakeMessaging();

    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' },
      { messaging },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.linkDelivered).toBe(false);
    const application = await prisma.rentalApplication.findFirst({ where: { showingId: showing.id } });
    expect(application).not.toBeNull();
  });

  it('still completes the showing when the send throws', async () => {
    const { showing } = await seedShowingWithConversation('telegram');
    const { messaging } = fakeMessaging({ shouldFail: true });

    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' },
      { messaging },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.linkDelivered).toBe(false);
    const updated = await prisma.showing.findUniqueOrThrow({ where: { id: showing.id } });
    expect(updated.status).toBe('completed');
  });

  it('rejects a showing that is already completed', async () => {
    const { showing } = await seedShowingWithConversation('telegram');
    const { messaging } = fakeMessaging();
    await completeShowingAndInvite({ showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' }, { messaging });

    const second = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' },
      { messaging },
    );

    expect(second).toEqual({ ok: false, status: 409, error: 'Showing cannot be completed from status: completed' });
    expect(await prisma.rentalApplication.count({ where: { showingId: showing.id } })).toBe(1);
  });

  it('rejects a cancelled showing', async () => {
    const { showing } = await seedShowingWithConversation('telegram');
    await prisma.showing.update({ where: { id: showing.id }, data: { status: 'cancelled' } });
    const { messaging } = fakeMessaging();

    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' },
      { messaging },
    );

    expect(result).toEqual({ ok: false, status: 409, error: 'Showing cannot be completed from status: cancelled' });
  });

  it('returns 404 for a showing that does not belong to the tenant', async () => {
    const { showing } = await seedShowingWithConversation('telegram');
    const { messaging } = fakeMessaging();

    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: 'tenant_someone_else', actorUserId: 'u_broker' },
      { messaging },
    );

    expect(result).toEqual({ ok: false, status: 404, error: 'Showing not found' });
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/rental-application.service.test.ts`
Expected: FAIL — `completeShowingAndInvite is not exported`.

- [ ] **Step 3: Implementar la función**

En `apps/api/src/services/rental-application.service.ts`, agregar al bloque de imports del archivo:

```typescript
import type { ChatChannel, MessagingAdapter } from '@property-manager/adapters';
import { getEnv } from '../config/env.js';
import { getReplyAddressFromConversation, sendWithRetry } from './chatbot.service.js';
```

y agregar al final del archivo:

```typescript
export type CompleteShowingResult =
  | { ok: false; status: 404 | 409; error: string }
  | { ok: true; applicationId: string; linkDelivered: boolean; applicationUrl: string };

function canCompleteShowingStatus(status: string): boolean {
  return status === 'scheduled' || status === 'confirmed';
}

/**
 * Devuelve un resultado discriminado en vez de lanzar: el error handler
 * global de app.ts convierte cualquier throw en 500, y aquí necesitamos
 * distinguir 404 de 409.
 */
export async function completeShowingAndInvite(
  input: { showingId: string; tenantId: string; actorUserId: string },
  deps: { messaging: Record<ChatChannel, MessagingAdapter> },
): Promise<CompleteShowingResult> {
  const showing = await prisma.showing.findFirst({
    where: { id: input.showingId, tenantId: input.tenantId },
    include: {
      lead: {
        include: {
          conversations: { orderBy: { updatedAt: 'desc' }, take: 1 },
        },
      },
    },
  });
  if (!showing) return { ok: false, status: 404, error: 'Showing not found' };
  if (!canCompleteShowingStatus(showing.status)) {
    return { ok: false, status: 409, error: `Showing cannot be completed from status: ${showing.status}` };
  }

  await prisma.showing.update({
    where: { id: showing.id },
    data: { status: 'completed', brokerUserId: showing.brokerUserId ?? input.actorUserId },
  });

  const { application, token } = await createRentalApplication({
    tenantId: input.tenantId,
    showingId: showing.id,
    leadId: showing.leadId,
    unitId: showing.unitId,
  });

  const applicationUrl = `${getEnv().WEB_URL.replace(/\/+$/, '')}/apply/${token}`;
  const conversation = showing.lead.conversations[0];
  let linkDelivered = false;

  // El canal `web` no tiene push saliente (su adapter es un mock
  // permanente): intentar "enviar" ahí reportaría éxito sin que le llegue
  // nada al prospecto.
  if (conversation && conversation.channel !== 'web') {
    const messaging = deps.messaging[conversation.channel as ChatChannel];
    if (messaging) {
      try {
        await sendWithRetry(() => messaging.send({
          to: getReplyAddressFromConversation(conversation.externalId),
          body: `Thanks for visiting! Please complete your rental application here:\n${applicationUrl}`,
          channel: conversation.channel as ChatChannel,
        }));
        linkDelivered = true;
      } catch (error) {
        // El showing ya quedó completado y la aplicación creada: un fallo
        // de entrega se reporta para que el PM mande el link a mano, no
        // deshace el resto.
        console.error(`[RentalApplication] No se pudo entregar el link de ${application.id}:`, error);
      }
    }
  }

  return { ok: true, applicationId: application.id, linkDelivered, applicationUrl };
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/rental-application.service.test.ts`
Expected: PASS (16 tests — los 9 anteriores + 7 nuevos).

- [ ] **Step 5: Agregar la ruta**

En `apps/api/src/routes/showings.ts`, agregar al bloque de imports:

```typescript
import { getAdapters } from '../config/adapters.js';
import { completeShowingAndInvite } from '../services/rental-application.service.js';
```

y agregar la ruta después de la de `/:id/confirm`:

```typescript
showingsRouter.post(
  '/:id/complete',
  requireAuth,
  requireRole('property_manager', 'broker'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const result = await completeShowingAndInvite(
        { showingId: req.params.id, tenantId: user.tenantId, actorUserId: user.userId },
        { messaging: getAdapters().messaging },
      );
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({
        status: 'completed',
        applicationId: result.applicationId,
        applicationUrl: result.applicationUrl,
        linkDelivered: result.linkDelivered,
      });
    } catch (err) {
      next(err);
    }
  },
);
```

Actualizar también el comentario de encabezado del archivo, agregando la ruta nueva a la lista:

```typescript
 *  POST /showings/:id/complete - broker marks the showing as done; invites the application
```

- [ ] **Step 6: Verificar la suite completa y el typecheck**

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — toda la suite.

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/rental-application.service.ts apps/api/src/services/rental-application.service.test.ts apps/api/src/routes/showings.ts
git commit -m "feat: complete a showing and invite the prospect to apply"
```

---

### Task 5: Recibir el formulario y notificar al staff

**Files:**
- Modify: `apps/api/src/services/rental-application.service.ts`
- Modify: `apps/api/src/services/rental-application.service.test.ts`
- Modify: `apps/api/src/routes/leads.ts` (rutas públicas — ahí vive el `publicRouter`)

**Interfaces:**
- Consumes: `getPublicRentalApplication` (Task 2), `resolveApplicationNotifyTargets` (Task 3); `buildDocumentStorageKey`, `createLocalDocumentStorage`, `decodeBase64Payload` de `./document-storage.service.js`.
- Produces: desde `rental-application.service.ts`:
  ```typescript
  export interface SubmitApplicationInput {
    annualIncome?: number | null;
    employerName?: string | null;
    references?: string | null;
    applicantFullName: string;
    consentApplication: boolean;
    consentCreditCheck: boolean;
    consentPoliceCheck: boolean;
    idDocumentFilename?: string | null;
    idDocumentMimeType?: string | null;
    idDocumentBase64?: string | null;
  }

  export type SubmitApplicationResult =
    | { ok: false; status: 400 | 404 | 409; error: string }
    | { ok: true; applicationId: string };

  export async function submitRentalApplication(
    token: string,
    input: SubmitApplicationInput,
    deps: { messaging: Record<ChatChannel, MessagingAdapter> },
  ): Promise<SubmitApplicationResult>
  ```

- [ ] **Step 1: Escribir los tests (la función aún no existe)**

En `apps/api/src/services/rental-application.service.test.ts`, agregar `submitRentalApplication` al import existente de `./rental-application.service.js`, y agregar al final del archivo:

```typescript
function validSubmission() {
  return {
    annualIncome: 82000,
    employerName: 'Acme Corp',
    references: 'Jane Doe — previous landlord — 604-555-0111',
    applicantFullName: 'Carlos Duran',
    consentApplication: true,
    consentCreditCheck: true,
    consentPoliceCheck: true,
    idDocumentFilename: 'id.png',
    idDocumentMimeType: 'image/png',
    idDocumentBase64: Buffer.from('fake-image-bytes').toString('base64'),
  };
}

async function seedInvitedApplication() {
  const { lead, showing } = await seedShowing();
  const { application, token } = await createRentalApplication({
    tenantId: TENANT_ID,
    showingId: showing.id,
    leadId: lead.id,
  });
  return { lead, showing, application, token };
}

describe('submitRentalApplication', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('stores every field and all three consent timestamps', async () => {
    const { token, application } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication(token, validSubmission(), { messaging });

    expect(result).toEqual({ ok: true, applicationId: application.id });
    const saved = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: application.id } });
    expect(saved.status).toBe('submitted');
    expect(saved.submittedAt).not.toBeNull();
    expect(saved.annualIncome).toBe(82000);
    expect(saved.employerName).toBe('Acme Corp');
    expect(saved.applicantFullName).toBe('Carlos Duran');
    expect(saved.idDocumentStorageKey).toBeTruthy();
    expect(saved.consentApplicationAt).not.toBeNull();
    expect(saved.consentCreditCheckAt).not.toBeNull();
    expect(saved.consentPoliceCheckAt).not.toBeNull();
  });

  it.each([
    ['consentApplication'],
    ['consentCreditCheck'],
    ['consentPoliceCheck'],
  ])('rejects the submission when %s is missing', async (missing) => {
    const { token } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication(
      token,
      { ...validSubmission(), [missing]: false },
      { messaging },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.status).toBe(400);
    expect(result.error).toContain(missing);
  });

  it('rejects a submission without a name', async () => {
    const { token } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication(
      token,
      { ...validSubmission(), applicantFullName: '   ' },
      { messaging },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.status).toBe(400);
  });

  it('rejects a submission with no ID document', async () => {
    const { token } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication(
      token,
      { ...validSubmission(), idDocumentBase64: null, idDocumentFilename: null, idDocumentMimeType: null },
      { messaging },
    );

    expect(result).toEqual({ ok: false, status: 400, error: 'A photo ID document is required' });
  });

  it('rejects an ID document above the size cap', async () => {
    const { token } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication(
      token,
      { ...validSubmission(), idDocumentBase64: 'A'.repeat(1_500_001) },
      { messaging },
    );

    expect(result).toEqual({ ok: false, status: 400, error: 'The ID document is too large' });
  });

  it('returns 404 for an unknown token', async () => {
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication('not-a-real-token', validSubmission(), { messaging });

    expect(result).toEqual({ ok: false, status: 404, error: 'Application not found or expired' });
  });

  it('rejects a second submission without overwriting the first', async () => {
    const { token, application } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();
    await submitRentalApplication(token, validSubmission(), { messaging });

    const second = await submitRentalApplication(
      token,
      { ...validSubmission(), employerName: 'Somewhere Else' },
      { messaging },
    );

    expect(second).toEqual({ ok: false, status: 409, error: 'Application already submitted' });
    const saved = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: application.id } });
    expect(saved.employerName).toBe('Acme Corp');
  });

  it('saves the application even when every notification channel fails', async () => {
    const { token, application } = await seedInvitedApplication();
    await prisma.user.create({
      data: {
        id: 'u_pm_notify_fail',
        tenantId: TENANT_ID,
        email: 'pm-notify-fail@test.ca',
        passwordHash: 'x',
        firstName: 'Pat',
        lastName: 'Manager',
        role: 'property_manager',
      },
    });
    const { messaging } = fakeMessaging({ shouldFail: true });

    const result = await submitRentalApplication(token, validSubmission(), { messaging });

    expect(result.ok).toBe(true);
    const saved = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: application.id } });
    expect(saved.status).toBe('submitted');

    await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  });
});
```

Nota: el `cleanup` de este archivo debe borrar también los usuarios del tenant de prueba. Actualiza la función `cleanup` existente agregando, antes del borrado de `showing`:

```typescript
  await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/rental-application.service.test.ts`
Expected: FAIL — `submitRentalApplication is not exported`.

- [ ] **Step 3: Implementar la función**

En `apps/api/src/services/rental-application.service.ts`, agregar al bloque de imports:

```typescript
import path from 'node:path';
import {
  buildDocumentStorageKey,
  createLocalDocumentStorage,
  decodeBase64Payload,
} from './document-storage.service.js';
```

y agregar al final del archivo:

```typescript
export interface SubmitApplicationInput {
  annualIncome?: number | null;
  employerName?: string | null;
  references?: string | null;
  applicantFullName: string;
  consentApplication: boolean;
  consentCreditCheck: boolean;
  consentPoliceCheck: boolean;
  idDocumentFilename?: string | null;
  idDocumentMimeType?: string | null;
  idDocumentBase64?: string | null;
}

export type SubmitApplicationResult =
  | { ok: false; status: 400 | 404 | 409; error: string }
  | { ok: true; applicationId: string };

// Mismo tope que `fileBase64` en routes/documents.ts (~1.1 MB de archivo
// real una vez decodificado el base64).
const MAX_ID_DOCUMENT_BASE64_LENGTH = 1_500_000;

export async function submitRentalApplication(
  token: string,
  input: SubmitApplicationInput,
  deps: { messaging: Record<ChatChannel, MessagingAdapter> },
): Promise<SubmitApplicationResult> {
  const application = await getPublicRentalApplication(token);
  if (!application) return { ok: false, status: 404, error: 'Application not found or expired' };
  if (application.status === 'submitted') {
    return { ok: false, status: 409, error: 'Application already submitted' };
  }

  const missingConsents = [
    ...(input.consentApplication ? [] : ['consentApplication']),
    ...(input.consentCreditCheck ? [] : ['consentCreditCheck']),
    ...(input.consentPoliceCheck ? [] : ['consentPoliceCheck']),
  ];
  if (missingConsents.length > 0) {
    return { ok: false, status: 400, error: `Missing required consent: ${missingConsents.join(', ')}` };
  }
  if (!input.applicantFullName.trim()) {
    return { ok: false, status: 400, error: 'applicantFullName is required' };
  }
  if (!input.idDocumentBase64 || !input.idDocumentFilename || !input.idDocumentMimeType) {
    return { ok: false, status: 400, error: 'A photo ID document is required' };
  }
  if (input.idDocumentBase64.length > MAX_ID_DOCUMENT_BASE64_LENGTH) {
    return { ok: false, status: 400, error: 'The ID document is too large' };
  }

  const env = getEnv();
  const storage = createLocalDocumentStorage({
    rootDir: path.resolve(env.DOCUMENT_STORAGE_DIR),
    publicBaseUrl: env.DOCUMENT_STORAGE_PUBLIC_BASE_URL || undefined,
  });
  const stored = await storage.putObject({
    key: buildDocumentStorageKey({
      tenantId: application.tenantId,
      documentId: application.id,
      filename: input.idDocumentFilename,
    }),
    body: decodeBase64Payload(input.idDocumentBase64),
    contentType: input.idDocumentMimeType,
  });
  const idDocumentStorageKey = stored.storageKey;

  const now = new Date();
  await prisma.rentalApplication.update({
    where: { id: application.id },
    data: {
      status: 'submitted',
      submittedAt: now,
      annualIncome: input.annualIncome ?? null,
      employerName: input.employerName ?? null,
      references: input.references ?? null,
      applicantFullName: input.applicantFullName.trim(),
      idDocumentStorageKey,
      consentApplicationAt: now,
      consentCreditCheckAt: now,
      consentPoliceCheckAt: now,
    },
  });

  await notifyStaffOfApplication(application.id, application.tenantId, deps);

  return { ok: true, applicationId: application.id };
}

/**
 * Best-effort: la aplicación del prospecto ya quedó guardada, así que un
 * fallo de notificación se loguea y nunca se propaga — si lo hiciera, el
 * prospecto vería un error y reintentaría, duplicando el envío.
 */
async function notifyStaffOfApplication(
  applicationId: string,
  tenantId: string,
  deps: { messaging: Record<ChatChannel, MessagingAdapter> },
): Promise<void> {
  try {
    const application = await prisma.rentalApplication.findUniqueOrThrow({
      where: { id: applicationId },
      include: { showing: { select: { brokerUserId: true } }, lead: { select: { assignedUserId: true } } },
    });
    const staff = await prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, email: true, role: true, notificationChannel: true, notificationAddress: true },
    });
    const targets = resolveApplicationNotifyTargets({
      brokerUserId: application.showing.brokerUserId,
      assignedUserId: application.lead.assignedUserId,
      staff: staff.map((member) => ({
        id: member.id,
        email: member.email,
        notificationChannel: member.notificationChannel,
        notificationAddress: member.notificationAddress,
      })),
      propertyManagerIds: staff.filter((member) => member.role === 'property_manager').map((member) => member.id),
    });

    const body = `New rental application received from ${application.applicantFullName ?? 'a prospect'}.`;

    for (const target of targets) {
      // Email y chat son independientes: que falle uno no debe impedir el otro.
      try {
        await deps.messaging.email.send({
          to: target.email,
          body,
          channel: 'email',
          subject: 'New rental application',
        });
      } catch (error) {
        console.error(`[RentalApplication] Email a ${target.id} falló:`, error);
      }

      if (target.notificationChannel && target.notificationAddress) {
        try {
          const channel = target.notificationChannel as ChatChannel;
          await deps.messaging[channel].send({ to: target.notificationAddress, body, channel });
        } catch (error) {
          console.error(`[RentalApplication] Chat a ${target.id} falló:`, error);
        }
      }
    }
  } catch (error) {
    console.error(`[RentalApplication] No se pudo notificar la aplicación ${applicationId}:`, error);
  }
}
```

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/rental-application.service.test.ts`
Expected: PASS (26 tests — los 16 anteriores + 10 nuevos, contando los 3 casos del `it.each`).

- [ ] **Step 5: Agregar las rutas públicas**

En `apps/api/src/routes/leads.ts`, agregar al bloque de imports:

```typescript
import {
  getPublicRentalApplication,
  submitRentalApplication,
} from '../services/rental-application.service.js';
```

y agregar las rutas después del bloque de rutas públicas del shortlist:

```typescript
publicRouter.get('/applications/:token', async (req, res, next) => {
  try {
    const application = await getPublicRentalApplication(req.params.token);
    if (!application) return void res.status(404).json({ error: 'Application not found or expired' });
    res.json({
      status: application.status,
      tenantName: application.tenant.name,
      showingAt: application.showing.scheduledAt,
      unit: application.unit
        ? {
          name: application.unit.name,
          property: application.unit.property,
        }
        : null,
    });
  } catch (error) { next(error); }
});

publicRouter.post('/applications/:token', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const result = await submitRentalApplication(
      req.params.token,
      {
        annualIncome: typeof body.annualIncome === 'number' ? body.annualIncome : null,
        employerName: typeof body.employerName === 'string' ? body.employerName : null,
        references: typeof body.references === 'string' ? body.references : null,
        applicantFullName: typeof body.applicantFullName === 'string' ? body.applicantFullName : '',
        consentApplication: body.consentApplication === true,
        consentCreditCheck: body.consentCreditCheck === true,
        consentPoliceCheck: body.consentPoliceCheck === true,
        idDocumentFilename: typeof body.idDocumentFilename === 'string' ? body.idDocumentFilename : null,
        idDocumentMimeType: typeof body.idDocumentMimeType === 'string' ? body.idDocumentMimeType : null,
        idDocumentBase64: typeof body.idDocumentBase64 === 'string' ? body.idDocumentBase64 : null,
      },
      { messaging: getAdapters().messaging },
    );
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
```

- [ ] **Step 6: Agregar la ruta autenticada para el dashboard**

En `apps/api/src/routes/showings.ts`, agregar la ruta al final del archivo:

```typescript
showingsRouter.get('/:id/application', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const application = await prisma.rentalApplication.findFirst({
      where: { showingId: req.params.id, tenantId: user.tenantId },
    });
    if (!application) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    res.json({ application });
  } catch (err) {
    next(err);
  }
});
```

Agregando también el import de `prisma` al archivo si no está:

```typescript
import { prisma } from '../config/db.js';
```

- [ ] **Step 7: Verificar la suite completa y el typecheck**

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — toda la suite.

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/rental-application.service.ts apps/api/src/services/rental-application.service.test.ts apps/api/src/routes/leads.ts apps/api/src/routes/showings.ts
git commit -m "feat: accept the rental application form and notify staff"
```

---

### Task 6: Página pública del formulario y botón "Completar" en el dashboard

**Files:**
- Create: `apps/web/src/pages/ApplyPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/pages/ShowingsPage.tsx`

**Interfaces:**
- Consumes: `GET /public/applications/:token`, `POST /public/applications/:token`, `POST /showings/:id/complete` (Tasks 4-5); `apiFetch` de `../lib/apiClient`.

Este task no tiene ciclo TDD (el frontend de este repo no tiene tests unitarios — se verifica con el typecheck del paquete web y una revisión manual en el navegador).

- [ ] **Step 1: Crear la página pública**

Crear `apps/web/src/pages/ApplyPage.tsx`:

```tsx
import { type FormEvent, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';

type ApplicationSummary = {
  status: string;
  tenantName: string;
  showingAt: string;
  unit: { name: string; property: { name: string; address: string; city: string; province: string } } | null;
};

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Export nombrado, no default: es la convención de las páginas de este
// repo (ver ShortlistPage).
export function ApplyPage() {
  const { token = '' } = useParams();
  const [idFile, setIdFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useQuery<ApplicationSummary>({
    queryKey: ['application', token],
    queryFn: () => apiFetch(`/public/applications/${token}`),
    retry: false,
  });

  const submit = useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      apiFetch(`/public/applications/${token}`, { method: 'POST', body: JSON.stringify(payload) }),
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const payload: Record<string, unknown> = {
      annualIncome: form.get('annualIncome') ? Number(form.get('annualIncome')) : null,
      employerName: form.get('employerName') || null,
      references: form.get('references') || null,
      applicantFullName: String(form.get('applicantFullName') ?? ''),
      consentApplication: form.get('consentApplication') === 'on',
      consentCreditCheck: form.get('consentCreditCheck') === 'on',
      consentPoliceCheck: form.get('consentPoliceCheck') === 'on',
    };
    if (idFile) {
      payload.idDocumentFilename = idFile.name;
      payload.idDocumentMimeType = idFile.type;
      payload.idDocumentBase64 = await fileToBase64(idFile);
    }
    try {
      await submit.mutateAsync(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit your application');
    }
  }

  if (summary.isLoading) {
    return <div className="p-8 text-center text-slate-500">Loading…</div>;
  }
  if (summary.isError || !summary.data) {
    return (
      <div className="p-8 text-center text-slate-600">
        This application link is no longer valid. Please contact your property manager.
      </div>
    );
  }
  if (summary.data.status === 'submitted' || submit.isSuccess) {
    return (
      <div className="p-8 text-center text-slate-700">
        Thanks! Your application has been submitted. We&apos;ll be in touch shortly.
      </div>
    );
  }

  const unit = summary.data.unit;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Rental application</h1>
      <p className="mt-1 text-sm text-slate-600">
        {summary.data.tenantName}
        {unit ? ` — ${unit.property.name}, ${unit.name}` : ''}
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Annual income (CAD)</span>
          <input name="annualIncome" type="number" min="0" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Employer</span>
          <input name="employerName" type="text" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">References</span>
          <textarea name="references" rows={3} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Photo ID</span>
          <input
            type="file"
            required
            accept="image/*,application/pdf"
            onChange={(event) => setIdFile(event.target.files?.[0] ?? null)}
            className="mt-1 w-full text-sm"
          />
        </label>

        <fieldset className="space-y-2 rounded-md border border-slate-200 p-4">
          <legend className="px-1 text-sm font-medium text-slate-700">Authorizations (all required)</legend>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input name="consentApplication" type="checkbox" required className="mt-0.5" />
            I confirm the information above is accurate and authorize its use to process this application.
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input name="consentCreditCheck" type="checkbox" required className="mt-0.5" />
            I authorize a credit check.
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input name="consentPoliceCheck" type="checkbox" required className="mt-0.5" />
            I authorize a criminal record (police) check.
          </label>
        </fieldset>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Full legal name (acts as your signature)</span>
          <input name="applicantFullName" type="text" required className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submit.isPending}
          className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {submit.isPending ? 'Submitting…' : 'Submit application'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Registrar la ruta pública**

En `apps/web/src/App.tsx`, agregar el import junto al de `ShortlistPage` (línea ~22). Nota que este repo usa **exports nombrados** para las páginas, no default:

```tsx
import { ApplyPage } from './pages/ApplyPage';
```

y agregar la ruta justo después de la del shortlist (línea ~84):

```tsx
          <Route path="/apply/:token" element={<ApplyPage />} />
```

- [ ] **Step 3: Agregar el botón "Mark as completed" al dashboard**

En `apps/web/src/pages/ShowingsPage.tsx`, agregar la mutación junto a `confirmMutation`/`cancelMutation`:

```tsx
  const completeMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/showings/${id}/complete`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['showings'] }),
  });
```

Y dentro del bloque `{showing.status === 'confirmed' && (...)}`, agregar el botón junto al de cancelar:

```tsx
                          <button
                            onClick={() => completeMutation.mutate(showing.id)}
                            disabled={completeMutation.isPending}
                            className="inline-flex items-center justify-center gap-1 rounded-md bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
                          >
                            <Icon name="document" size={14} />
                            Mark as completed
                          </button>
```

- [ ] **Step 4: Verificar el typecheck del frontend**

Run: `pnpm --filter @property-manager/web exec tsc --noEmit`
Expected: sin errores.

- [ ] **Step 5: Verificación manual en el navegador**

Con Postgres/Redis arriba, la API (`pnpm --filter @property-manager/api dev`) y el web (`pnpm --filter @property-manager/web dev`) corriendo:

1. Entra al dashboard, ve a Showings, y confirma un showing que esté en `scheduled`.
2. En ese mismo showing ya `confirmed`, haz clic en "Mark as completed".
3. Copia el `applicationUrl` que devolvió la respuesta (visible en la pestaña de red del navegador) y ábrelo.
4. Confirma que el formulario carga con el nombre del tenant y la unidad, que no deja enviar sin marcar los 3 checkboxes, y que al enviarlo aparece el mensaje de agradecimiento.

Expected: los 4 pasos funcionan sin errores en consola.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/ApplyPage.tsx apps/web/src/App.tsx apps/web/src/pages/ShowingsPage.tsx
git commit -m "feat: add the public rental application page and the complete-showing action"
```

---

### Task 7: Regresión completa

**Files:** ninguno nuevo — solo verificación.

- [ ] **Step 1: Typecheck de todo el monorepo**

Run: `pnpm -r exec tsc --noEmit`
Expected: sin errores en ningún paquete.

- [ ] **Step 2: Suite completa**

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — todos los tests (los existentes + los de Fase 2A).

Run: `pnpm --filter @property-manager/adapters exec vitest run`
Expected: PASS.

- [ ] **Step 3: Commit (solo si algún ajuste fue necesario)**

Si los steps 1-2 no requirieron cambios, no hay nada que comitear — este task solo confirma el estado verde acumulado de los Tasks 1-6.
