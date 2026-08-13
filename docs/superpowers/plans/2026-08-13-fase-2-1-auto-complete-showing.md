# Auto-Complete Showing (Fase 2.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enviar automáticamente la invitación de solicitud de renta 2 horas después de que termina un showing, sin depender de que un staff member apriete el botón manual.

**Architecture:** Un worker `setInterval` (mismo patrón que `shortlist-reminders.ts`) sondea cada 15 minutos los showings vencidos y reutiliza `completeShowingAndInvite` (la misma función que ya usa el botón manual) para completarlos e invitar al prospecto — sin cola BullMQ, sin campo nuevo en el schema.

**Tech Stack:** TypeScript, Prisma, Vitest — sin dependencias nuevas.

## Global Constraints

- El botón manual (`POST /showings/:id/complete`) sigue funcionando exactamente igual — este plan no lo modifica, solo hace más permisivo el tipo de `actorUserId` que la función subyacente acepta.
- Un showing solo se auto-completa si `status` es `'scheduled'` o `'confirmed'` — nunca `'cancelled'`/`'no_show'`/`'completed'`.
- El sondeo automático nunca trata un `409` de `completeShowingAndInvite` (alguien ya lo completó, por el botón o por otro ciclo del sondeo) como un error — es el camino normal de una carrera ganada por otro lado.
- Showings cuyo "vencimiento" (fin del showing + 2h) cayó hace más de 48h no se auto-completan — evita un envío retroactivo masivo al desplegar esta feature sobre showings viejos.
- Si algo falla (test rojo, tsc), reporta BLOCKED — no commitees en rojo.

---

### Task 1: `completeShowingAndInvite` acepta `actorUserId: string | null`

**Files:**
- Modify: `apps/api/src/services/rental-application.service.ts:73-106`
- Test: `apps/api/src/services/rental-application.service.test.ts`

**Interfaces:**
- Produces: `completeShowingAndInvite(input: { showingId: string; tenantId: string; actorUserId: string | null }, deps): Promise<CompleteShowingResult>` — el tipo de `actorUserId` es lo único que cambia; `CompleteShowingResult` y el resto del comportamiento quedan idénticos. Consumido por la Tarea 2.

- [ ] **Step 1: Escribir el test que falla**

En `apps/api/src/services/rental-application.service.test.ts`, agregar al `describe('completeShowingAndInvite', ...)` existente (buscar dónde vive ese describe block en el archivo — junto a los demás tests de esta función):

```ts
it('completa el showing con actorUserId null cuando el showing no tiene brokerUserId', async () => {
  const { showing } = await seedShowing();
  expect(showing.brokerUserId).toBeNull();

  const result = await completeShowingAndInvite(
    { showingId: showing.id, tenantId: TENANT_ID, actorUserId: null },
    { messaging: mockMessaging },
  );

  expect(result.ok).toBe(true);
  const updated = await prisma.showing.findUniqueOrThrow({ where: { id: showing.id } });
  expect(updated.status).toBe('completed');
  expect(updated.brokerUserId).toBeNull();
});
```

(`mockMessaging` — revisa cómo los tests existentes de este mismo describe arman el objeto `deps.messaging` — probablemente ya hay una constante o un helper en este archivo; reutilízalo, no inventes uno nuevo. Si no existe uno reusable, usa el mismo patrón que el primer test del describe block existente.)

- [ ] **Step 2: Correr y verificar que falla**

```bash
pnpm --filter @property-manager/api exec vitest run rental-application.service.test.ts
```

Expected: FAIL — error de tipo, `actorUserId: null` no es asignable a `actorUserId: string`.

- [ ] **Step 3: Ampliar el tipo**

En `apps/api/src/services/rental-application.service.ts`, línea 74, reemplazar:

```ts
  input: { showingId: string; tenantId: string; actorUserId: string },
```

por:

```ts
  input: { showingId: string; tenantId: string; actorUserId: string | null },
```

Y en la línea 102, reemplazar:

```ts
    data: { status: 'completed', brokerUserId: showing.brokerUserId ?? input.actorUserId },
```

por:

```ts
    // `undefined` (no `null`) omite el campo del UPDATE cuando ni el
    // showing ni el actor tienen un brokerUserId — deja la columna como
    // estaba en vez de escribir `null` explícito.
    data: { status: 'completed', brokerUserId: showing.brokerUserId ?? input.actorUserId ?? undefined },
```

- [ ] **Step 4: Correr y verificar que pasa**

```bash
pnpm --filter @property-manager/api exec vitest run rental-application.service.test.ts
```

Expected: PASS — todos los tests de este archivo, incluido el nuevo.

- [ ] **Step 5: Verificar que el call site existente sigue compilando**

```bash
pnpm --filter @property-manager/api exec tsc --noEmit
```

Expected: sin errores. `apps/api/src/routes/showings.ts:72` pasa `actorUserId: user.userId` (un `string` real) — sigue siendo válido para el tipo ampliado `string | null` sin ningún cambio en ese archivo.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/rental-application.service.ts apps/api/src/services/rental-application.service.test.ts
git commit -m "feat: completeShowingAndInvite acepta actorUserId null para disparo sin actor humano"
```

---

### Task 2: Worker de auto-completado + arranque

**Files:**
- Create: `apps/api/src/jobs/showing-auto-complete.ts`
- Test: `apps/api/src/jobs/showing-auto-complete.test.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `completeShowingAndInvite(input: {showingId, tenantId, actorUserId: string | null}, deps): Promise<CompleteShowingResult>` (Tarea 1), `getAdapters()` de `../config/adapters.js` (ya existente, mismo import directo que usa `shortlist-reminders.ts`).
- Produces: `findShowingsDueForAutoComplete(now: Date): Promise<DueShowing[]>`, `runShowingAutoCompleteSweep(deps?): Promise<{completed: number; skipped: number}>`, `startShowingAutoCompleteWorker(): void` — el último se llama una vez desde `server.ts`.

- [ ] **Step 1: Escribir el test que falla — `findShowingsDueForAutoComplete`**

Crear `apps/api/src/jobs/showing-auto-complete.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';
import { findShowingsDueForAutoComplete, runShowingAutoCompleteSweep } from './showing-auto-complete.js';

const TENANT_ID = 'tenant_test_showing_auto_complete';
const TWO_HOURS_MS = 2 * 60 * 60_000;

async function seedShowing(overrides: {
  scheduledAt: Date;
  durationMinutes?: number;
  status?: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  brokerUserId?: string | null;
}) {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Showing Auto-Complete Test Tenant', province: 'BC' },
  });
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, phone: `+1604555${Math.floor(Math.random() * 9000 + 1000)}`, source: 'web', status: 'new_' },
  });
  const showing = await prisma.showing.create({
    data: {
      tenantId: TENANT_ID,
      leadId: lead.id,
      scheduledAt: overrides.scheduledAt,
      durationMinutes: overrides.durationMinutes ?? 30,
      status: overrides.status ?? 'confirmed',
      brokerUserId: overrides.brokerUserId ?? null,
    },
  });
  return { lead, showing };
}

async function cleanup() {
  await prisma.rentalApplication.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
}

describe('findShowingsDueForAutoComplete', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('incluye un showing cuyo fin + 2h ya pasó', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    // scheduledAt + 30min + 2h = 12:30 + 2h = 14:30, antes de las 15:00 -> vencido.
    const { showing } = await seedShowing({ scheduledAt: new Date('2026-08-13T12:00:00Z') });

    const due = await findShowingsDueForAutoComplete(now);

    expect(due.map((s) => s.id)).toContain(showing.id);
  });

  it('excluye un showing cuyo fin + 2h todavía no llega', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    // scheduledAt + 30min + 2h = 14:30 + 2h = 17:00, después de las 15:00 -> no vencido.
    const { showing } = await seedShowing({ scheduledAt: new Date('2026-08-13T14:00:00Z') });

    const due = await findShowingsDueForAutoComplete(now);

    expect(due.map((s) => s.id)).not.toContain(showing.id);
  });

  it('excluye un showing ya completado', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    const { showing } = await seedShowing({ scheduledAt: new Date('2026-08-13T12:00:00Z'), status: 'completed' });

    const due = await findShowingsDueForAutoComplete(now);

    expect(due.map((s) => s.id)).not.toContain(showing.id);
  });

  it('excluye un showing cancelado', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    const { showing } = await seedShowing({ scheduledAt: new Date('2026-08-13T12:00:00Z'), status: 'cancelled' });

    const due = await findShowingsDueForAutoComplete(now);

    expect(due.map((s) => s.id)).not.toContain(showing.id);
  });

  it('excluye un showing tan viejo que su vencimiento cayó hace más de 48h (protección anti-blast retroactivo)', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    // Vencimiento: hace 49 horas.
    const staleScheduledAt = new Date(now.getTime() - 49 * 60 * 60_000 - TWO_HOURS_MS - 30 * 60_000);
    const { showing } = await seedShowing({ scheduledAt: staleScheduledAt });

    const due = await findShowingsDueForAutoComplete(now);

    expect(due.map((s) => s.id)).not.toContain(showing.id);
  });
});

describe('runShowingAutoCompleteSweep', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('completa los showings vencidos y cuenta el resultado', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    await seedShowing({ scheduledAt: new Date('2026-08-13T12:00:00Z') });
    await seedShowing({ scheduledAt: new Date('2026-08-13T11:00:00Z') });
    const send = vi.fn().mockResolvedValue({ messageId: 'x' });
    const messaging = new Proxy({}, { get: () => ({ send }) }) as any;

    const result = await runShowingAutoCompleteSweep({ messaging, now });

    expect(result).toEqual({ completed: 2, skipped: 0 });
    const rows = await prisma.showing.findMany({ where: { tenantId: TENANT_ID } });
    expect(rows.every((s) => s.status === 'completed')).toBe(true);
  });

  it('cuenta como skipped un showing que otro proceso ya completó (carrera)', async () => {
    const now = new Date('2026-08-13T15:00:00Z');
    const { showing } = await seedShowing({ scheduledAt: new Date('2026-08-13T12:00:00Z') });
    // Simula que el botón manual ganó la carrera justo antes de que corra el sondeo.
    await prisma.showing.update({ where: { id: showing.id }, data: { status: 'completed' } });
    const send = vi.fn().mockResolvedValue({ messageId: 'x' });
    const messaging = new Proxy({}, { get: () => ({ send }) }) as any;

    const result = await runShowingAutoCompleteSweep({ messaging, now });

    expect(result).toEqual({ completed: 0, skipped: 1 });
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
pnpm --filter @property-manager/api exec vitest run showing-auto-complete.test.ts
```

Expected: FAIL — el archivo `showing-auto-complete.ts` todavía no existe.

- [ ] **Step 3: Implementar**

Crear `apps/api/src/jobs/showing-auto-complete.ts`:

```ts
/**
 * Fase 2.1: el roadmap pide que la invitación de solicitud de renta se
 * mande sola 2 horas después de que termina el showing, sin depender de
 * que el staff apriete el botón manual (`POST /showings/:id/complete`,
 * que sigue existiendo y sigue funcionando igual). Este sondeo reutiliza
 * la MISMA función (`completeShowingAndInvite`) que ese botón — nunca hay
 * dos formas distintas de "completar un showing e invitar".
 */
import type { ChatChannel, MessagingAdapter } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { getAdapters } from '../config/adapters.js';
import { completeShowingAndInvite } from '../services/rental-application.service.js';

const CHECK_INTERVAL_MS = 15 * 60_000;
const TWO_HOURS_MS = 2 * 60 * 60_000;
// Protección contra un envío retroactivo masivo la primera vez que esto
// se despliega: un showing cuyo vencimiento (fin + 2h) cayó hace más de
// 48h no se auto-completa — el prospecto ya se enfrió, y el staff puede
// completarlo a mano con el botón si de verdad hace falta.
const STALE_CUTOFF_MS = 48 * 60 * 60_000;

export interface DueShowing {
  id: string;
  tenantId: string;
  brokerUserId: string | null;
}

export function startShowingAutoCompleteWorker(): void {
  setInterval(() => {
    void runShowingAutoCompleteSweep().catch((error) => {
      console.error('[ShowingAutoComplete] Sondeo falló:', error);
    });
  }, CHECK_INTERVAL_MS).unref();
}

/**
 * `durationMinutes` es un campo por fila -- Prisma no puede expresar
 * `scheduledAt + durationMinutes <= X` en un `where` type-safe sin SQL
 * crudo. Se sobre-consulta con un filtro simple y seguro (2h es mucho más
 * grande que cualquier `durationMinutes` real, que son minutos) y se
 * filtra con precisión en código.
 */
export async function findShowingsDueForAutoComplete(now: Date): Promise<DueShowing[]> {
  const conservativeCutoff = new Date(now.getTime() - TWO_HOURS_MS);
  const candidates = await prisma.showing.findMany({
    where: { status: { in: ['scheduled', 'confirmed'] }, scheduledAt: { lte: conservativeCutoff } },
    select: { id: true, tenantId: true, scheduledAt: true, durationMinutes: true, brokerUserId: true },
  });
  return candidates
    .filter((showing) => {
      const dueAt = showing.scheduledAt.getTime() + showing.durationMinutes * 60_000 + TWO_HOURS_MS;
      return dueAt <= now.getTime() && now.getTime() - dueAt <= STALE_CUTOFF_MS;
    })
    .map((showing) => ({ id: showing.id, tenantId: showing.tenantId, brokerUserId: showing.brokerUserId }));
}

export async function runShowingAutoCompleteSweep(deps?: {
  messaging?: Record<ChatChannel, MessagingAdapter>;
  now?: Date;
}): Promise<{ completed: number; skipped: number }> {
  const now = deps?.now ?? new Date();
  const messaging = deps?.messaging ?? getAdapters().messaging;
  const due = await findShowingsDueForAutoComplete(now);

  let completed = 0;
  let skipped = 0;
  // Uno por vez, no Promise.all: el volumen esperado entre sondeos de 15
  // min es bajo (decenas, no miles), y secuencial evita saturar el
  // adapter de mensajería o el pool de Prisma sin necesidad real.
  for (const showing of due) {
    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: showing.tenantId, actorUserId: showing.brokerUserId },
      { messaging },
    );
    // Un 409 acá es el camino NORMAL, no un error: alguien ya lo completó
    // (el botón manual sigue vivo) o un ciclo anterior del sondeo lo
    // ganó primero -- el guard de `updateMany` de completeShowingAndInvite
    // ya resuelve la carrera, este código solo cuenta el resultado.
    if (result.ok) {
      completed += 1;
    } else {
      skipped += 1;
    }
  }
  return { completed, skipped };
}
```

- [ ] **Step 4: Correr y verificar que pasa**

```bash
pnpm --filter @property-manager/api exec vitest run showing-auto-complete.test.ts
```

Expected: PASS — los 7 tests (5 de `findShowingsDueForAutoComplete`, 2 de `runShowingAutoCompleteSweep`).

- [ ] **Step 5: Arrancar el worker en `server.ts`**

En `apps/api/src/server.ts`, agregar el import junto a los otros workers de intervalo (línea 9-10):

```ts
import { startShowingAutoCompleteWorker } from './jobs/showing-auto-complete.js';
```

Y agregar la llamada junto a `startShortlistReminderWorker()`/`startMessageDeliveryRetryWorker()` (línea 29-30):

```ts
  startShowingAutoCompleteWorker();
```

- [ ] **Step 6: Verificar compilación de todo el paquete**

```bash
pnpm --filter @property-manager/api exec tsc --noEmit
pnpm --filter @property-manager/api test
```

Expected: sin errores; toda la suite de `api` en verde.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/showing-auto-complete.ts apps/api/src/jobs/showing-auto-complete.test.ts apps/api/src/server.ts
git commit -m "feat: sondeo automático que completa showings vencidos e invita al prospecto 2h después"
```

---

### Task 3: Roadmap y regresión completa

**Files:**
- Modify: `docs/PRODUCT_ROADMAP.md`

- [ ] **Step 1: Actualizar el roadmap**

En `docs/PRODUCT_ROADMAP.md`, sección 2.1 ("Post-Showing Form Trigger"), agregar una nota indicando que el trigger automático (2h después del fin del showing, sondeo cada 15 min) ya está entregado, y que el botón manual de completar sigue disponible como alternativa/override.

- [ ] **Step 2: Regresión completa del monorepo**

```bash
pnpm -r exec tsc --noEmit
pnpm -r run test
```

Expected: todo verde en los 4 paquetes. Si algo falla, no commitear: reportar BLOCKED.

- [ ] **Step 3: Commit**

```bash
git add docs/PRODUCT_ROADMAP.md
git commit -m "docs: disparo automático post-showing entregado en el roadmap"
```
