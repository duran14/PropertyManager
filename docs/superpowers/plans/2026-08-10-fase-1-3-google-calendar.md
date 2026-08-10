# Fase 1.3 — Auto-booking contra Google Calendar: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar la disponibilidad inventada del `ShowMojoMockAdapter` por el calendario real de la agencia en Google Calendar, y escribir el evento de vuelta ahí al agendar.

**Architecture:** Tres capas con fronteras nítidas. `packages/core/src/availability.ts` es un motor **puro** que resta bloques ocupados de un horario laboral (sin red, sin base, sin reloj implícito). `packages/adapters/…/google-calendar.real.ts` solo hace HTTP con Google y no sabe de la base de datos. `apps/api/src/services/*` guarda, descifra y refresca tokens, y orquesta la reserva.

**Tech Stack:** TypeScript, Node 20, Express, Prisma + PostgreSQL, Zod, Vitest, React + Vite + TanStack Query. `fetch` nativo — **cero dependencias nuevas**.

**Spec:** [`docs/superpowers/specs/2026-08-10-fase-1-3-google-calendar-design.md`](../specs/2026-08-10-fase-1-3-google-calendar-design.md)

## Global Constraints

Vinculantes para **todas** las tareas:

1. **Cero dependencias nuevas.** Ni `googleapis`, ni librerías de fechas, ni de OAuth. `packages/adapters` solo depende de `zod`. Se usa `fetch` nativo e `Intl.DateTimeFormat`.
2. **Errores por valor de retorno, no por excepción.** El manejador global de `apps/api/src/app.ts` convierte cualquier `throw` en un 500. Todo error esperado se devuelve como resultado discriminado `{ ok: false; ... }` y la ruta lo mapea al status. Precedentes: `TwilioClaimResult` en `apps/api/src/routes/webhooks.ts` y `closeOwnerStatement` en `apps/api/src/services/owner-statement.service.ts`.
3. **Nunca reportar como hecho algo que no ocurrió.** Sin calendario conectado, o si Google falla, el bot **no** ofrece horarios y **no** crea showings. Jamás cae al mock de ShowMojo.
4. **Zona horaria del negocio: `America/Vancouver`**, ya exportada como `BUSINESS_TIME_ZONE` desde `packages/core/src/period.ts`. Los datos IANA actuales indican que Vancouver deja de observar horario de verano después de 2026. **Las pruebas afirman propiedades locales** ("este instante se renderiza como 09:00 en esa zona"), **nunca** constantes UTC quemadas.
5. **Credenciales cifradas en reposo.** Tokens de Google con `encrypt()` / `decrypt()` de `apps/api/src/config/crypto.ts` (AES-256-GCM). Nunca en texto plano, nunca en logs, nunca en payloads de auditoría.
6. **Las uniques de base son la red de concurrencia**, no los `if`. Un `catch` de Prisma se estrecha al código `P2002`; cualquier otro error se relanza.
7. **Aislamiento por tenant.** Toda consulta filtra por `tenantId`.
8. **Dinero en centavos enteros.** No aplica directamente aquí, pero sigue vigente si se toca algo monetario.
9. **El repo se queda verde.** No se commitea con una prueba en rojo. Si una prueba no pasa, se reporta como BLOCKED en vez de commitear.

### Seguridad de la base de datos — leer antes de tocar Prisma

- **NUNCA** ejecutar `prisma migrate reset`, `prisma db push`, ni `migrate dev` con `--force-reset`. La base de desarrollo tiene datos sembrados que el usuario usa.
- **NUNCA** pasar `$DATABASE_URL` como `--shadow-database-url`. Prisma **borra y recrea** la base de shadow. Ya destruyó los datos de demo una vez en este proyecto.
- La base de shadow correcta es `postgresql://pm_dev:pm_dev_password@127.0.0.1:5433/property_manager_shadow?schema=public` y ya existe.
- El comando de migración es:
  ```bash
  pnpm --filter @property-manager/api exec prisma migrate dev --name <nombre>
  ```

### Comandos de verificación

```bash
pnpm -r exec tsc --noEmit                    # typecheck de todo el monorepo
pnpm --filter @property-manager/core test     # 58 pruebas hoy
pnpm --filter @property-manager/adapters test # 39 pruebas hoy
pnpm --filter @property-manager/api test      # 576 pruebas hoy
```

### Convenciones de estilo del repo

- Comentarios en español, código y nombres en inglés.
- Los comentarios explican **por qué**, no **qué**. No narrar lo que el código ya dice.
- Los adapters reales reciben `fetchImpl` por constructor para poder simularlo en pruebas (ver `packages/adapters/src/real/twilio.real.ts`).
- Las pruebas de servicio corren contra la base real, con `cleanup()` en `beforeEach`/`afterEach` y un `TENANT_ID` propio del archivo (ver `apps/api/src/services/owner-statement.service.test.ts`).

---

## Estructura de archivos

**Crear:**

| Archivo | Responsabilidad |
|---|---|
| `packages/core/src/availability.ts` | Motor puro de huecos, tipos de horario semanal, esquema zod y `DEFAULT_WEEKLY_HOURS` |
| `packages/core/src/availability.test.ts` | Pruebas del motor |
| `packages/adapters/src/mocks/calendar.mock.ts` | `CalendarMockAdapter` determinista |
| `packages/adapters/src/real/google-calendar.real.ts` | `GoogleCalendarRealAdapter` |
| `packages/adapters/src/real/google-calendar.real.test.ts` | Pruebas del adapter con `fetch` simulado |
| `apps/api/src/services/calendar-connection.service.ts` | Guardar/leer conexión, ciclo de vida del access token, `state` firmado |
| `apps/api/src/services/calendar-connection.service.test.ts` | Pruebas de lo anterior |
| `apps/api/src/services/scheduling-config.service.ts` | Leer/crear/actualizar `SchedulingConfig` |
| `apps/api/src/services/scheduling-config.service.test.ts` | Pruebas de lo anterior |
| `apps/api/src/routes/integrations.google-calendar.ts` | Rutas OAuth y de configuración |
| `apps/api/src/routes/integrations.google-calendar.test.ts` | Pruebas de las rutas |
| `apps/web/src/components/CalendarSettingsCard.tsx` | Tarjeta de conexión y configuración |
| `docs/GOOGLE_CALENDAR_SETUP.md` | Guía de setup en Google Cloud |

**Modificar:**

| Archivo | Cambio |
|---|---|
| `apps/api/prisma/schema.prisma` | `CalendarConnection`, `SchedulingConfig`, dos enums, tres campos en `Showing`, relaciones en `Tenant` y `User` |
| `packages/core/src/period.ts` | Exportar `zonedDateTimeToUtc`, reescribir `monthBoundsUtc` encima |
| `packages/core/src/index.ts` | Exportar `availability.js` |
| `packages/config/src/env.ts` | Tres variables de Google, `IntegrationKey` gana `google_calendar` |
| `packages/adapters/src/contracts.ts` | Contrato `CalendarAdapter` y sus tipos |
| `packages/adapters/src/factory.ts` | Campo `calendar` en `Adapters`, selección mock/real |
| `apps/api/src/services/scheduling.service.ts` | `getSchedulingAvailability`, `bookShowingFromCalendar`, borrar `scheduleTour`/`getAvailableSlots`/`resolveShowingBooking`, cambiar `formatSlotLabel`, extender `cancelShowing` y `createManualShowingFromConversation` |
| `apps/api/src/services/chatbot.service.ts` | Estado `scheduling` contra el calendario; quitar `showmojo` de `deps` |
| `apps/api/src/routes/leads.ts` | Dos rutas de slots/booking al camino nuevo; quitar `showmojo` de `deps` |
| `apps/api/src/routes/chat.ts`, `apps/api/src/routes/webhooks.ts`, `apps/api/src/jobs/telegram-poller.ts` | Quitar `showmojo` de `deps` |
| `apps/api/src/app.ts` | Montar el router nuevo |
| `apps/web/src/pages/ShowingsPage.tsx` | Insertar la tarjeta, advertencia de "sin bloquear en calendario", leer `?calendar=` |
| `apps/web/src/lib/types.ts` | Tipos de la conexión y la configuración |
| `docs/PRODUCT_ROADMAP.md` | Marcar §1.3 entregada |

---

## Task 1: Esquema de base de datos

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_calendar_connections/migration.sql` (lo genera Prisma)

**Interfaces:**
- Consumes: nada.
- Produces: modelos `CalendarConnection` y `SchedulingConfig`; enums `CalendarProvider` y `CalendarConnectionStatus`; campos `Showing.googleEventId`, `Showing.googleCalendarId`, `Showing.calendarSlotKey` con `@@unique([tenantId, calendarSlotKey])`.

- [ ] **Step 1: Agregar los modelos al schema**

En `apps/api/prisma/schema.prisma`, después del bloque de `Showing`/`ShowingStatus`:

```prisma
// =============================================================================
// Fase 1.3 — Calendario de la agencia (Google) y configuración de agenda
// =============================================================================

model CalendarConnection {
  id                   String                   @id @default(cuid())
  tenantId             String
  provider             CalendarProvider         @default(google)
  // Dueño de la conexión. Hoy siempre null (nivel agencia). La fase
  // por-broker lo llena sin migrar la tabla.
  userId               String?
  // Derivado en la misma escritura: "tenant" cuando userId es null,
  // "user:<id>" cuando no. Existe porque en Postgres dos NULL se consideran
  // distintos entre sí: una unique sobre userId nulo NO impediría dos
  // conexiones de agencia para el mismo tenant.
  ownerKey             String
  // Solo para mostrar en la UI de quién es la cuenta conectada.
  accountEmail         String
  // Calendario secundario que crea la app; ahí viven los showings.
  showingsCalendarId   String
  // Cifrados con apps/api/src/config/crypto.ts (AES-256-GCM).
  refreshTokenEnc      String
  accessTokenEnc       String?
  accessTokenExpiresAt DateTime?
  status               CalendarConnectionStatus @default(active)
  lastError            String?
  lastErrorAt          DateTime?
  createdAt            DateTime                 @default(now())
  updatedAt            DateTime                 @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user   User?  @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([tenantId, ownerKey])
  @@index([tenantId, status])
  @@map("calendar_connections")
}

enum CalendarProvider {
  google
}

enum CalendarConnectionStatus {
  active
  revoked
}

model SchedulingConfig {
  id                     String   @id @default(cuid())
  tenantId               String   @unique
  // Formato en packages/core/src/availability.ts (WeeklyHoursSchema).
  // Sin @default a propósito: el valor por defecto lo escribe el servicio
  // desde DEFAULT_WEEKLY_HOURS, para que exista una sola definición.
  weeklyHours            Json
  timeZone               String   @default("America/Vancouver")
  showingDurationMinutes Int      @default(30)
  bufferMinutes          Int      @default(30)
  minNoticeHours         Int      @default(4)
  maxAdvanceDays         Int      @default(14)
  slotGranularityMinutes Int      @default(30)
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@map("scheduling_configs")
}
```

- [ ] **Step 2: Agregar los campos a `Showing`**

Dentro de `model Showing`, junto a `activeProspectSlotKey`:

```prisma
  // Evento en Google Calendar que bloquea este horario. Nulo cuando el
  // showing existe pero no quedó bloqueado en ningún calendario: la
  // pantalla de Showings lo marca con advertencia.
  googleEventId         String?
  googleCalendarId      String?
  // Red de concurrencia: "<ownerKey>:<startAt ISO>". Se limpia al cancelar
  // para que el hueco vuelva a ofrecerse.
  calendarSlotKey       String?
```

Y en el bloque de índices de `Showing`, junto a las uniques existentes:

```prisma
  @@unique([tenantId, calendarSlotKey])
```

- [ ] **Step 3: Agregar las relaciones inversas**

En `model Tenant`, junto a las demás relaciones:

```prisma
  calendarConnections CalendarConnection[]
  schedulingConfig    SchedulingConfig?
```

En `model User`, junto a `assignedLeads`:

```prisma
  calendarConnections CalendarConnection[]
```

- [ ] **Step 4: Generar la migración**

```bash
pnpm --filter @property-manager/api exec prisma migrate dev --name add_calendar_connections
```

Esperado: crea el directorio de migración y aplica el SQL. **No** debe pedir reset. Si lo pide, algo está mal en el schema: parar y reportar BLOCKED sin aceptar.

- [ ] **Step 5: Verificar que la migración declara lo esperado**

```bash
grep -E "calendar_connections|scheduling_configs|calendarSlotKey|calendar_slot_key" apps/api/prisma/migrations/*_add_calendar_connections/migration.sql
```

Esperado: aparecen `CREATE TABLE "calendar_connections"`, `CREATE TABLE "scheduling_configs"` y un `CREATE UNIQUE INDEX` sobre `(tenantId, calendarSlotKey)`. Confirmar además que **no** hay ningún `DROP TABLE` de tablas existentes.

- [ ] **Step 6: Typecheck**

```bash
pnpm -r exec tsc --noEmit
```

Esperado: sin errores.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat: schema de conexión de calendario y configuración de agenda"
```

---

## Task 2: `zonedDateTimeToUtc` en `period.ts`

**Files:**
- Modify: `packages/core/src/period.ts`
- Test: `packages/core/src/period.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `export function zonedDateTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date` — el instante UTC que corresponde a esa fecha y hora **locales** en esa zona. `month` es 1-12.

Este archivo ya calcula offsets de zona por dentro para los límites de mes contable. La Tarea 3 necesita exactamente esa pieza, así que se extrae y se exporta en vez de duplicarla.

- [ ] **Step 1: Escribir la prueba que falla**

Agregar a `packages/core/src/period.test.ts`:

```ts
describe('zonedDateTimeToUtc', () => {
  // Se afirma la PROPIEDAD (cómo se renderiza en esa zona), no una
  // constante UTC: los datos IANA de Vancouver cambian con los años.
  function renderInZone(date: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  it('devuelve el instante que se ve como esa hora local en enero', () => {
    const utc = zonedDateTimeToUtc(2026, 1, 15, 9, 0, 'America/Vancouver');
    expect(renderInZone(utc, 'America/Vancouver')).toContain('09:00');
    expect(renderInZone(utc, 'America/Vancouver')).toContain('2026-01-15');
  });

  it('devuelve el instante que se ve como esa hora local en julio', () => {
    const utc = zonedDateTimeToUtc(2026, 7, 15, 9, 0, 'America/Vancouver');
    expect(renderInZone(utc, 'America/Vancouver')).toContain('09:00');
    expect(renderInZone(utc, 'America/Vancouver')).toContain('2026-07-15');
  });

  it('funciona igual en una zona con offset positivo', () => {
    const utc = zonedDateTimeToUtc(2026, 3, 20, 14, 30, 'Europe/Madrid');
    expect(renderInZone(utc, 'Europe/Madrid')).toContain('14:30');
  });

  it('monthBoundsUtc sigue dando la medianoche local del día 1', () => {
    const { periodStart } = monthBoundsUtc(2026, 3, 'America/Vancouver');
    expect(renderInZone(periodStart, 'America/Vancouver')).toContain('00:00');
    expect(renderInZone(periodStart, 'America/Vancouver')).toContain('2026-03-01');
  });
});
```

Actualizar el import del archivo de prueba para incluir `zonedDateTimeToUtc`.

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/core test -- period
```

Esperado: FAIL — `zonedDateTimeToUtc is not a function`.

- [ ] **Step 3: Implementar**

En `packages/core/src/period.ts`, reemplazar `zonedMonthStart` por el helper exportado y reescribir `monthBoundsUtc` encima:

```ts
/**
 * Instante UTC que corresponde a esa fecha y hora LOCALES en la zona dada.
 *
 * Se parte del mismo reloj interpretado como UTC y se corrige por el offset
 * vigente EN ESE instante, así cada fecha usa su propio offset de horario de
 * verano en vez de uno compartido para todo el rango.
 *
 * `month` es 1-12.
 */
export function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsetMs = timeZoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess + offsetMs);
}
```

Y `monthBoundsUtc` pasa a:

```ts
export function monthBoundsUtc(
  year: number,
  month: number,
  timeZone: string = BUSINESS_TIME_ZONE,
): { periodStart: Date; periodEnd: Date } {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    periodStart: zonedDateTimeToUtc(year, month, 1, 0, 0, timeZone),
    periodEnd: zonedDateTimeToUtc(nextYear, nextMonth, 1, 0, 0, timeZone),
  };
}
```

Borrar la función privada `zonedMonthStart`, que ya no se usa. Dejar `timeZoneOffsetMs` como está.

- [ ] **Step 4: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/core test -- period
```

Esperado: PASS, incluidas las pruebas de `monthBoundsUtc` que ya existían.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/period.ts packages/core/src/period.test.ts
git commit -m "refactor: exportar zonedDateTimeToUtc desde period.ts"
```

---

## Task 3: Motor puro de huecos disponibles

**Files:**
- Create: `packages/core/src/availability.ts`
- Create: `packages/core/src/availability.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `zonedDateTimeToUtc(year, month, day, hour, minute, timeZone): Date` de la Tarea 2.
- Produces:
  - `type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'`
  - `interface DayRange { from: string; to: string }` — `"HH:MM"` en 24 h
  - `type WeeklyHours = Record<WeekdayKey, DayRange[]>`
  - `const WeeklyHoursSchema: z.ZodType<WeeklyHours>`
  - `const DEFAULT_WEEKLY_HOURS: WeeklyHours`
  - `interface TimeRange { start: Date; end: Date }`
  - `function computeAvailableSlots(input: ComputeAvailableSlotsInput): TimeRange[]`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `packages/core/src/availability.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  computeAvailableSlots,
  DEFAULT_WEEKLY_HOURS,
  WeeklyHoursSchema,
  type WeeklyHours,
} from './availability.js';
import { zonedDateTimeToUtc } from './period.js';

const TZ = 'America/Vancouver';

/** Cómo se ve ese instante en la zona del negocio, "HH:MM". */
function localTime(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** Horario con un solo rango, el mismo todos los días de la semana. */
function everyDay(from: string, to: string): WeeklyHours {
  return {
    mon: [{ from, to }], tue: [{ from, to }], wed: [{ from, to }],
    thu: [{ from, to }], fri: [{ from, to }], sat: [{ from, to }],
    sun: [{ from, to }],
  };
}

const EMPTY: WeeklyHours = {
  mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
};

/** Un miércoles cualquiera, lejos de cualquier cambio de horario. */
const DAY_START = zonedDateTimeToUtc(2026, 1, 14, 0, 0, TZ);
const DAY_END = zonedDateTimeToUtc(2026, 1, 15, 0, 0, TZ);

function base(overrides: Partial<Parameters<typeof computeAvailableSlots>[0]> = {}) {
  return {
    from: DAY_START,
    to: DAY_END,
    weeklyHours: everyDay('09:00', '17:00'),
    busy: [],
    timeZone: TZ,
    durationMinutes: 30,
    bufferMinutes: 0,
    granularityMinutes: 30,
    ...overrides,
  };
}

describe('computeAvailableSlots', () => {
  it('llena la ventana laboral cuando no hay nada ocupado', () => {
    const slots = computeAvailableSlots(base());
    // 09:00 a 17:00 en pasos de 30 min, con visitas de 30 min: 16 huecos.
    expect(slots).toHaveLength(16);
    expect(localTime(slots[0]!.start)).toBe('09:00');
    expect(localTime(slots[slots.length - 1]!.start)).toBe('16:30');
  });

  it('no ofrece nada en un día sin rangos configurados', () => {
    expect(computeAvailableSlots(base({ weeklyHours: EMPTY }))).toHaveLength(0);
  });

  it('no ofrece nada cuando un evento tapa toda la ventana', () => {
    const slots = computeAvailableSlots(base({
      busy: [{
        start: zonedDateTimeToUtc(2026, 1, 14, 8, 0, TZ),
        end: zonedDateTimeToUtc(2026, 1, 14, 18, 0, TZ),
      }],
    }));
    expect(slots).toHaveLength(0);
  });

  it('deja huecos antes y después de un evento parcial', () => {
    const slots = computeAvailableSlots(base({
      busy: [{
        start: zonedDateTimeToUtc(2026, 1, 14, 11, 0, TZ),
        end: zonedDateTimeToUtc(2026, 1, 14, 13, 0, TZ),
      }],
    }));
    const times = slots.map((slot) => localTime(slot.start));
    expect(times).toContain('10:30');
    expect(times).not.toContain('11:00');
    expect(times).not.toContain('12:30');
    expect(times).toContain('13:00');
  });

  it('aplica el colchón a cada lado del evento', () => {
    const slots = computeAvailableSlots(base({
      bufferMinutes: 30,
      busy: [{
        start: zonedDateTimeToUtc(2026, 1, 14, 11, 0, TZ),
        end: zonedDateTimeToUtc(2026, 1, 14, 12, 0, TZ),
      }],
    }));
    const times = slots.map((slot) => localTime(slot.start));
    // 10:30-11:00 quedaría pegado al evento: el colchón lo elimina.
    expect(times).not.toContain('10:30');
    expect(times).toContain('10:00');
    expect(times).not.toContain('12:00');
    expect(times).toContain('12:30');
  });

  it('no duplica el colchón entre dos eventos contiguos', () => {
    const slots = computeAvailableSlots(base({
      bufferMinutes: 30,
      busy: [
        {
          start: zonedDateTimeToUtc(2026, 1, 14, 11, 0, TZ),
          end: zonedDateTimeToUtc(2026, 1, 14, 12, 0, TZ),
        },
        {
          start: zonedDateTimeToUtc(2026, 1, 14, 12, 0, TZ),
          end: zonedDateTimeToUtc(2026, 1, 14, 13, 0, TZ),
        },
      ],
    }));
    const times = slots.map((slot) => localTime(slot.start));
    // Se fusionan a un solo bloque 11:00-13:00 con colchón 10:30-13:30.
    expect(times).toContain('10:00');
    expect(times).not.toContain('10:30');
    expect(times).toContain('13:30');
  });

  it('respeta la hora de comida con dos rangos en el mismo día', () => {
    const lunch: WeeklyHours = {
      ...EMPTY,
      wed: [{ from: '09:00', to: '12:00' }, { from: '13:00', to: '17:00' }],
    };
    const slots = computeAvailableSlots(base({ weeklyHours: lunch }));
    const times = slots.map((slot) => localTime(slot.start));
    expect(times).toContain('11:30');
    expect(times).not.toContain('12:00');
    expect(times).not.toContain('12:30');
    expect(times).toContain('13:00');
  });

  it('no ofrece huecos anteriores a `from`', () => {
    const slots = computeAvailableSlots(base({
      from: zonedDateTimeToUtc(2026, 1, 14, 13, 15, TZ),
    }));
    expect(localTime(slots[0]!.start)).toBe('13:30');
  });

  it('descarta el hueco que no cabe completo antes de cerrar', () => {
    const slots = computeAvailableSlots(base({
      weeklyHours: everyDay('09:00', '10:00'),
      durationMinutes: 45,
    }));
    // Solo 09:00-09:45 cabe; 09:30-10:15 se pasa del cierre.
    expect(slots).toHaveLength(1);
    expect(localTime(slots[0]!.start)).toBe('09:00');
  });

  it('respeta la granularidad de una hora', () => {
    const slots = computeAvailableSlots(base({ granularityMinutes: 60 }));
    const times = slots.map((slot) => localTime(slot.start));
    expect(times).toContain('09:00');
    expect(times).not.toContain('09:30');
    expect(slots).toHaveLength(8);
  });

  it('mantiene la hora local al cruzar un cambio de horario', () => {
    // Rango de una semana que abarca el segundo domingo de marzo, cuando
    // históricamente cambia el horario en Norteamérica. Se afirma que TODOS
    // los primeros huecos del día se ven como 09:00 hora local, sin importar
    // qué haga la zona ese año.
    const slots = computeAvailableSlots(base({
      from: zonedDateTimeToUtc(2026, 3, 6, 0, 0, TZ),
      to: zonedDateTimeToUtc(2026, 3, 13, 0, 0, TZ),
    }));
    const firstOfEachDay = new Map<string, Date>();
    for (const slot of slots) {
      const day = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(slot.start);
      if (!firstOfEachDay.has(day)) firstOfEachDay.set(day, slot.start);
    }
    expect(firstOfEachDay.size).toBe(7);
    for (const start of firstOfEachDay.values()) {
      expect(localTime(start)).toBe('09:00');
    }
  });
});

describe('WeeklyHoursSchema', () => {
  it('acepta el horario por defecto', () => {
    expect(WeeklyHoursSchema.safeParse(DEFAULT_WEEKLY_HOURS).success).toBe(true);
  });

  it('rechaza un día faltante', () => {
    const { mon, ...rest } = DEFAULT_WEEKLY_HOURS;
    expect(WeeklyHoursSchema.safeParse(rest).success).toBe(false);
  });

  it('rechaza un rango invertido', () => {
    const bad = { ...EMPTY, mon: [{ from: '17:00', to: '09:00' }] };
    expect(WeeklyHoursSchema.safeParse(bad).success).toBe(false);
  });

  it('rechaza rangos traslapados en el mismo día', () => {
    const bad = {
      ...EMPTY,
      mon: [{ from: '09:00', to: '12:00' }, { from: '11:00', to: '15:00' }],
    };
    expect(WeeklyHoursSchema.safeParse(bad).success).toBe(false);
  });

  it('rechaza una hora mal formada', () => {
    const bad = { ...EMPTY, mon: [{ from: '9:00', to: '17:00' }] };
    expect(WeeklyHoursSchema.safeParse(bad).success).toBe(false);
  });

  it('rechaza más de cuatro rangos en un día', () => {
    const bad = {
      ...EMPTY,
      mon: [
        { from: '08:00', to: '09:00' }, { from: '10:00', to: '11:00' },
        { from: '12:00', to: '13:00' }, { from: '14:00', to: '15:00' },
        { from: '16:00', to: '17:00' },
      ],
    };
    expect(WeeklyHoursSchema.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/core test -- availability
```

Esperado: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar el motor**

Crear `packages/core/src/availability.ts`:

```ts
/**
 * Motor de huecos disponibles para agendar visitas.
 *
 * Función pura: sin red, sin base de datos y sin reloj implícito — el
 * instante "ahora" entra como parámetro. Lo delicado aquí no es hablar con
 * un calendario, es restar bloques ocupados de un horario laboral
 * respetando los cambios de horario de la zona.
 */
import { z } from 'zod';
import { zonedDateTimeToUtc } from './period.js';

export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** Los días en el orden que devuelve Date.getUTCDay() sobre la fecha local. */
const WEEKDAY_KEYS: readonly WeekdayKey[] = [
  'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat',
];

export interface DayRange {
  /** "HH:MM" en 24 h. */
  from: string;
  to: string;
}

export type WeeklyHours = Record<WeekdayKey, DayRange[]>;

export interface TimeRange {
  start: Date;
  end: Date;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(time: string): number {
  const match = TIME_PATTERN.exec(time);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

const dayRangeSchema = z
  .object({
    from: z.string().regex(TIME_PATTERN, 'La hora debe ser HH:MM en 24 h'),
    to: z.string().regex(TIME_PATTERN, 'La hora debe ser HH:MM en 24 h'),
  })
  .refine((range) => toMinutes(range.from) < toMinutes(range.to), {
    message: 'El inicio del rango debe ser anterior al fin',
  });

const dayRangesSchema = z
  .array(dayRangeSchema)
  .max(4, 'Máximo 4 rangos por día')
  .refine(
    (ranges) => {
      const sorted = [...ranges].sort((a, b) => toMinutes(a.from) - toMinutes(b.from));
      return sorted.every(
        (range, index) => index === 0 || toMinutes(sorted[index - 1]!.to) <= toMinutes(range.from),
      );
    },
    { message: 'Los rangos de un mismo día no pueden traslaparse' },
  );

export const WeeklyHoursSchema = z.object({
  mon: dayRangesSchema,
  tue: dayRangesSchema,
  wed: dayRangesSchema,
  thu: dayRangesSchema,
  fri: dayRangesSchema,
  sat: dayRangesSchema,
  sun: dayRangesSchema,
});

/**
 * El horario por defecto vive AQUÍ y solo aquí: el servicio lo usa al crear
 * la configuración y la UI para el botón de restaurar. El esquema de Prisma
 * no declara default justamente para que no haya dos definiciones.
 */
export const DEFAULT_WEEKLY_HOURS: WeeklyHours = {
  mon: [{ from: '09:00', to: '17:00' }],
  tue: [{ from: '09:00', to: '17:00' }],
  wed: [{ from: '09:00', to: '17:00' }],
  thu: [{ from: '09:00', to: '17:00' }],
  fri: [{ from: '09:00', to: '17:00' }],
  sat: [],
  sun: [],
};

export interface ComputeAvailableSlotsInput {
  /** Primer instante que puede ofrecerse (ya incluye el aviso mínimo). */
  from: Date;
  /** Último instante que puede ofrecerse. */
  to: Date;
  weeklyHours: WeeklyHours;
  /** Bloques ocupados tal como los reporta el proveedor de calendario. */
  busy: TimeRange[];
  timeZone: string;
  durationMinutes: number;
  bufferMinutes: number;
  granularityMinutes: number;
}

export function computeAvailableSlots(input: ComputeAvailableSlotsInput): TimeRange[] {
  const windows = expandWorkingWindows(input);
  const blocked = inflate(merge(input.busy), input.bufferMinutes);

  const durationMs = input.durationMinutes * 60_000;
  const stepMs = input.granularityMinutes * 60_000;
  const slots: TimeRange[] = [];

  for (const window of windows) {
    for (let t = window.start.getTime(); t + durationMs <= window.end.getTime(); t += stepMs) {
      if (t < input.from.getTime()) continue;
      if (t + durationMs > input.to.getTime()) break;
      const candidate = { start: new Date(t), end: new Date(t + durationMs) };
      if (blocked.some((block) => overlaps(candidate, block))) continue;
      slots.push(candidate);
    }
  }

  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Convierte el horario semanal en ventanas concretas de UTC, un día local a
 * la vez. Cada límite se calcula con su propio offset, así una ventana que
 * cae después de un cambio de horario no se corre una hora.
 */
function expandWorkingWindows(input: ComputeAvailableSlotsInput): TimeRange[] {
  const windows: TimeRange[] = [];
  // Se empieza un día antes del inicio del rango porque la ventana laboral
  // de ese día puede seguir viva a la hora de `from`.
  const cursor = new Date(input.from.getTime() - 24 * 60 * 60_000);

  while (cursor.getTime() <= input.to.getTime()) {
    const { year, month, day, weekday } = localDateParts(cursor, input.timeZone);
    for (const range of input.weeklyHours[weekday]) {
      const [fromHour, fromMinute] = splitTime(range.from);
      const [toHour, toMinute] = splitTime(range.to);
      windows.push({
        start: zonedDateTimeToUtc(year, month, day, fromHour, fromMinute, input.timeZone),
        end: zonedDateTimeToUtc(year, month, day, toHour, toMinute, input.timeZone),
      });
    }
    cursor.setTime(cursor.getTime() + 24 * 60 * 60_000);
  }

  return windows
    .filter((window) => window.end > input.from && window.start < input.to)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

function splitTime(time: string): [number, number] {
  const [hour, minute] = time.split(':');
  return [Number(hour), Number(minute)];
}

function localDateParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; weekday: WeekdayKey } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const weekdayLabel = get('weekday').toLowerCase().slice(0, 3);
  const weekday = (WEEKDAY_KEYS.find((key) => key === weekdayLabel) ?? 'mon') as WeekdayKey;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday,
  };
}

/** Ordena y fusiona los bloques que se traslapan o se tocan. */
function merge(ranges: TimeRange[]): TimeRange[] {
  const sorted = [...ranges]
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start.getTime() <= last.end.getTime()) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ start: new Date(range.start), end: new Date(range.end) });
    }
  }
  return merged;
}

/**
 * Agrega el colchón de traslado a cada lado. Se infla DESPUÉS de fusionar:
 * si se hiciera antes, dos eventos contiguos generarían un colchón doble en
 * medio, donde en realidad no hay que trasladarse a ningún lado.
 */
function inflate(ranges: TimeRange[], bufferMinutes: number): TimeRange[] {
  if (bufferMinutes <= 0) return ranges;
  const bufferMs = bufferMinutes * 60_000;
  return ranges.map((range) => ({
    start: new Date(range.start.getTime() - bufferMs),
    end: new Date(range.end.getTime() + bufferMs),
  }));
}

function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}
```

- [ ] **Step 4: Exportar desde el índice**

En `packages/core/src/index.ts`, agregar al final:

```ts
export * from './availability.js';
```

- [ ] **Step 5: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/core test
```

Esperado: PASS — las 58 pruebas previas más las nuevas.

- [ ] **Step 6: Typecheck**

```bash
pnpm -r exec tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/availability.ts packages/core/src/availability.test.ts packages/core/src/index.ts
git commit -m "feat: motor puro de huecos disponibles"
```

---

## Task 4: Contrato `CalendarAdapter`, mock, entorno y factory

**Files:**
- Modify: `packages/adapters/src/contracts.ts`
- Create: `packages/adapters/src/mocks/calendar.mock.ts`
- Modify: `packages/adapters/src/factory.ts`
- Modify: `packages/config/src/env.ts`
- Test: `packages/adapters/src/factory.test.ts`

**Interfaces:**
- Consumes: nada de tareas previas.
- Produces: el contrato `CalendarAdapter` completo (ver Step 1), `CalendarMockAdapter`, `Adapters.calendar`, `IntegrationKey` con `'google_calendar'`, y las variables `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`.

- [ ] **Step 1: Agregar el contrato**

En `packages/adapters/src/contracts.ts`, al final:

```ts
// -----------------------------------------------------------------------------
// Calendario — disponibilidad y eventos de showings
//
// El adapter NO sabe de la base de datos: recibe un access token ya válido y
// hace la llamada. Quien guarda, descifra y refresca tokens es el servicio.
// -----------------------------------------------------------------------------

export interface CalendarBusyInterval {
  startAt: IsoDate;
  endAt: IsoDate;
}

export interface CalendarEventInput {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  startAt: IsoDate;
  endAt: IsoDate;
  timeZone: string;
  /** Si viene vacío o ausente, el evento se crea sin invitados. */
  attendeeEmails?: string[];
}

export type CalendarRefreshResult =
  | { ok: true; accessToken: string; expiresInSeconds: number }
  | { ok: false; reason: 'revoked' | 'provider_error'; detail: string };

export interface CalendarAdapter {
  readonly name: 'google_calendar' | 'calendar_mock';

  /** Construye la URL de consentimiento. `state` va tal cual. */
  buildAuthorizeUrl(input: { redirectUri: string; state: string }): string;

  exchangeAuthorizationCode(input: { code: string; redirectUri: string }): Promise<{
    refreshToken: string;
    accessToken: string;
    expiresInSeconds: number;
    accountEmail: string;
  }>;

  /**
   * Discriminado a propósito: distinguir "el manager revocó el acceso" de
   * "Google está caído" cambia lo que hace el sistema — lo primero apaga la
   * conexión, lo segundo es transitorio.
   */
  refreshAccessToken(input: { refreshToken: string }): Promise<CalendarRefreshResult>;

  /** Crea el calendario "Property Showings" si no existe. Idempotente. */
  ensureShowingsCalendar(input: {
    accessToken: string;
    timeZone: string;
  }): Promise<{ calendarId: string }>;

  getBusy(input: {
    accessToken: string;
    calendarIds: string[];
    from: IsoDate;
    to: IsoDate;
  }): Promise<CalendarBusyInterval[]>;

  createEvent(
    input: { accessToken: string } & CalendarEventInput,
  ): Promise<{ eventId: string; htmlLink?: string }>;

  deleteEvent(input: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<void>;
}
```

- [ ] **Step 2: Escribir el mock**

Crear `packages/adapters/src/mocks/calendar.mock.ts`:

```ts
/**
 * Mock de calendario para desarrollo y pruebas.
 *
 * Determinista: guarda en memoria los eventos que crea y los reporta como
 * ocupados, así el flujo completo (ofrecer, agendar, no volver a ofrecer ese
 * hueco) se puede ejercitar sin red.
 *
 * OJO: que este mock esté activo NO significa que el bot ofrezca horarios.
 * Sin una CalendarConnection en la base, el servicio pasa a handoff sin
 * importar qué adapter esté seleccionado.
 */
import type {
  CalendarAdapter,
  CalendarBusyInterval,
  CalendarEventInput,
  CalendarRefreshResult,
} from '../contracts.js';

export class CalendarMockAdapter implements CalendarAdapter {
  readonly name = 'calendar_mock' as const;

  private events = new Map<string, { calendarId: string; startAt: string; endAt: string }>();
  private counter = 0;

  /**
   * `getAdapters()` cachea un único set de adapters por proceso, así que este
   * mock sobrevive de una prueba a la siguiente y los eventos de una se
   * reportarían como ocupados en la otra. Las pruebas lo limpian en beforeEach.
   */
  reset(): void {
    this.events.clear();
    this.counter = 0;
  }

  buildAuthorizeUrl(input: { redirectUri: string; state: string }): string {
    const params = new URLSearchParams({
      redirect_uri: input.redirectUri,
      state: input.state,
      mock: 'true',
    });
    return `https://mock.calendar.local/authorize?${params.toString()}`;
  }

  async exchangeAuthorizationCode(): Promise<{
    refreshToken: string;
    accessToken: string;
    expiresInSeconds: number;
    accountEmail: string;
  }> {
    return {
      refreshToken: 'mock_refresh_token',
      accessToken: 'mock_access_token',
      expiresInSeconds: 3600,
      accountEmail: 'calendar-mock@example.com',
    };
  }

  async refreshAccessToken(): Promise<CalendarRefreshResult> {
    return { ok: true, accessToken: 'mock_access_token', expiresInSeconds: 3600 };
  }

  async ensureShowingsCalendar(): Promise<{ calendarId: string }> {
    return { calendarId: 'mock_showings_calendar' };
  }

  async getBusy(input: {
    accessToken: string;
    calendarIds: string[];
    from: string;
    to: string;
  }): Promise<CalendarBusyInterval[]> {
    const fromMs = new Date(input.from).getTime();
    const toMs = new Date(input.to).getTime();
    return [...this.events.values()]
      .filter((event) => input.calendarIds.includes(event.calendarId))
      .filter((event) => new Date(event.endAt).getTime() > fromMs
        && new Date(event.startAt).getTime() < toMs)
      .map((event) => ({ startAt: event.startAt, endAt: event.endAt }));
  }

  async createEvent(
    input: { accessToken: string } & CalendarEventInput,
  ): Promise<{ eventId: string; htmlLink?: string }> {
    const eventId = `mock_event_${++this.counter}`;
    this.events.set(eventId, {
      calendarId: input.calendarId,
      startAt: input.startAt,
      endAt: input.endAt,
    });
    return { eventId, htmlLink: `https://mock.calendar.local/event/${eventId}` };
  }

  async deleteEvent(input: { eventId: string }): Promise<void> {
    this.events.delete(input.eventId);
  }
}
```

- [ ] **Step 3: Agregar las variables de entorno**

En `packages/config/src/env.ts`, dentro de `envSchema`, junto a las demás integraciones:

```ts
  // --- Google Calendar (Fase 1.3). Sin client id/secret → mock. ---
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  // Si queda vacía se arma como `${API_URL}/integrations/google-calendar/callback`.
  // Debe coincidir CARÁCTER POR CARÁCTER con la registrada en Google Cloud.
  GOOGLE_OAUTH_REDIRECT_URI: z
    .union([z.string().url(), z.literal('')])
    .default(''),
```

En el tipo `IntegrationKey`, agregar `| 'google_calendar'`. En `isIntegrationConfigured`, agregar el caso:

```ts
    case 'google_calendar':
      return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
```

- [ ] **Step 4: Cablear el factory**

En `packages/adapters/src/factory.ts`:

- Importar `CalendarAdapter` de `./contracts.js` y `CalendarMockAdapter` de `./mocks/calendar.mock.js`.
- Agregar `calendar: CalendarAdapter;` a la interfaz `Adapters`.
- Construirlo junto a los demás. Hasta la Tarea 5 el real no existe, así que por ahora siempre el mock:

```ts
  // El adapter real llega en la tarea siguiente; hasta entonces el mock
  // cubre ambos casos y el flag solo alimenta mockModes.
  const calendar: CalendarAdapter = new CalendarMockAdapter();
```

- Agregar `google_calendar: !isIntegrationConfigured(env, 'google_calendar')` al objeto `mockModes`, y `calendar` al objeto devuelto.

- [ ] **Step 5: Escribir la prueba del factory**

Agregar a `packages/adapters/src/factory.test.ts`:

Ese archivo tiene una constante `baseEnv: Env` literal con todas las variables. Agregarle las tres nuevas (`GOOGLE_CLIENT_ID: ''`, `GOOGLE_CLIENT_SECRET: ''`, `GOOGLE_OAUTH_REDIRECT_URI: ''`) — sin eso `tsc` va a fallar, porque `Env` ahora las exige — y agregar:

```ts
it('cae al mock de calendario sin credenciales de Google', () => {
  const adapters = createAdapters(baseEnv);
  expect(adapters.calendar.name).toBe('calendar_mock');
  expect(adapters.mockModes.google_calendar).toBe(true);
});
```

El caso de "usa el adapter real cuando hay credenciales" **no** se escribe aquí: el adapter real no existe todavía y una prueba saltada es una prueba muerta. Lo agrega la Tarea 5, junto con el adapter.

- [ ] **Step 6: Escribir la prueba del mock**

Crear `packages/adapters/src/mocks/calendar.mock.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CalendarMockAdapter } from './calendar.mock.js';

describe('CalendarMockAdapter', () => {
  it('reporta como ocupado un evento que acaba de crear', async () => {
    const adapter = new CalendarMockAdapter();
    const { eventId } = await adapter.createEvent({
      accessToken: 'token',
      calendarId: 'cal_1',
      summary: 'Showing',
      startAt: '2026-01-14T18:00:00.000Z',
      endAt: '2026-01-14T18:30:00.000Z',
      timeZone: 'America/Vancouver',
    });

    const busy = await adapter.getBusy({
      accessToken: 'token',
      calendarIds: ['cal_1'],
      from: '2026-01-14T00:00:00.000Z',
      to: '2026-01-15T00:00:00.000Z',
    });
    expect(busy).toEqual([
      { startAt: '2026-01-14T18:00:00.000Z', endAt: '2026-01-14T18:30:00.000Z' },
    ]);

    await adapter.deleteEvent({ accessToken: 'token', calendarId: 'cal_1', eventId });
    const after = await adapter.getBusy({
      accessToken: 'token',
      calendarIds: ['cal_1'],
      from: '2026-01-14T00:00:00.000Z',
      to: '2026-01-15T00:00:00.000Z',
    });
    expect(after).toEqual([]);
  });

  it('ignora eventos de calendarios que no se piden', async () => {
    const adapter = new CalendarMockAdapter();
    await adapter.createEvent({
      accessToken: 'token',
      calendarId: 'otro',
      summary: 'Showing',
      startAt: '2026-01-14T18:00:00.000Z',
      endAt: '2026-01-14T18:30:00.000Z',
      timeZone: 'America/Vancouver',
    });
    const busy = await adapter.getBusy({
      accessToken: 'token',
      calendarIds: ['cal_1'],
      from: '2026-01-14T00:00:00.000Z',
      to: '2026-01-15T00:00:00.000Z',
    });
    expect(busy).toEqual([]);
  });
});
```

- [ ] **Step 7: Correr las pruebas**

```bash
pnpm --filter @property-manager/adapters test
pnpm -r exec tsc --noEmit
```

Esperado: PASS, sin errores de tipos.

- [ ] **Step 8: Commit**

```bash
git add packages/adapters/src packages/config/src/env.ts
git commit -m "feat: contrato CalendarAdapter, mock y cableado en el factory"
```

---

## Task 5: `GoogleCalendarRealAdapter`

**Files:**
- Create: `packages/adapters/src/real/google-calendar.real.ts`
- Create: `packages/adapters/src/real/google-calendar.real.test.ts`
- Modify: `packages/adapters/src/factory.ts`

**Interfaces:**
- Consumes: el contrato `CalendarAdapter` de la Tarea 4.
- Produces: `class GoogleCalendarRealAdapter implements CalendarAdapter`, con constructor
  `constructor(config: { clientId: string; clientSecret: string; fetchImpl?: typeof fetch })`.

Los scopes son exactamente estos tres, en este orden:

```
https://www.googleapis.com/auth/calendar.freebusy
https://www.googleapis.com/auth/calendar.app.created
openid email
```

`calendar.app.created` da acceso **solo a los calendarios que la app creó** — por eso los showings viven en un calendario secundario propio y por eso hay que consultar `primary` **y** el de showings al pedir disponibilidad.

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `packages/adapters/src/real/google-calendar.real.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { GoogleCalendarRealAdapter } from './google-calendar.real.js';

const CONFIG = { clientId: 'client-123', clientSecret: 'secret-456' };

/** id_token de mentiras: solo el payload importa, la firma no se verifica. */
function fakeIdToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url');
  return `header.${payload}.signature`;
}

describe('GoogleCalendarRealAdapter', () => {
  it('arma la URL de consentimiento con offline access y los tres scopes', () => {
    const adapter = new GoogleCalendarRealAdapter(CONFIG);
    const url = new URL(adapter.buildAuthorizeUrl({
      redirectUri: 'https://api.example.com/integrations/google-calendar/callback',
      state: 'signed-state',
    }));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/calendar.freebusy '
      + 'https://www.googleapis.com/auth/calendar.app.created openid email',
    );
  });

  it('canjea el código y saca el correo del id_token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'at_1',
      refresh_token: 'rt_1',
      expires_in: 3599,
      id_token: fakeIdToken('manager@agencia.com'),
    }), { status: 200 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    const result = await adapter.exchangeAuthorizationCode({
      code: 'auth-code',
      redirectUri: 'https://api.example.com/cb',
    });

    expect(result).toEqual({
      accessToken: 'at_1',
      refreshToken: 'rt_1',
      expiresInSeconds: 3599,
      accountEmail: 'manager@agencia.com',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('refresca el access token', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'at_2', expires_in: 3599 }),
      { status: 200 },
    ));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    expect(await adapter.refreshAccessToken({ refreshToken: 'rt_1' })).toEqual({
      ok: true, accessToken: 'at_2', expiresInSeconds: 3599,
    });
  });

  it('reporta revoked cuando Google devuelve invalid_grant', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      { status: 400 },
    ));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    const result = await adapter.refreshAccessToken({ refreshToken: 'rt_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });

  it('reporta provider_error cuando Google falla con 500', async () => {
    const fetchMock = vi.fn(async () => new Response('upstream boom', { status: 500 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    const result = await adapter.refreshAccessToken({ refreshToken: 'rt_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('provider_error');
  });

  it('reutiliza el calendario de showings si ya existe', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      items: [
        { id: 'cal_personal', summary: 'Personal' },
        { id: 'cal_showings', summary: 'Property Showings' },
      ],
    }), { status: 200 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    const result = await adapter.ensureShowingsCalendar({
      accessToken: 'at_1', timeZone: 'America/Vancouver',
    });

    expect(result).toEqual({ calendarId: 'cal_showings' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no crea uno nuevo
  });

  it('crea el calendario de showings cuando no existe', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'cal_nuevo' }), { status: 200 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    expect(await adapter.ensureShowingsCalendar({
      accessToken: 'at_1', timeZone: 'America/Vancouver',
    })).toEqual({ calendarId: 'cal_nuevo' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fusiona los bloques ocupados de todos los calendarios pedidos', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      calendars: {
        primary: { busy: [{ start: '2026-01-14T18:00:00Z', end: '2026-01-14T19:00:00Z' }] },
        cal_showings: { busy: [{ start: '2026-01-14T21:00:00Z', end: '2026-01-14T21:30:00Z' }] },
      },
    }), { status: 200 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    const busy = await adapter.getBusy({
      accessToken: 'at_1',
      calendarIds: ['primary', 'cal_showings'],
      from: '2026-01-14T00:00:00Z',
      to: '2026-01-15T00:00:00Z',
    });

    expect(busy).toHaveLength(2);
    expect(busy[0]).toEqual({ startAt: '2026-01-14T18:00:00Z', endAt: '2026-01-14T19:00:00Z' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).items).toEqual([{ id: 'primary' }, { id: 'cal_showings' }]);
  });

  it('crea el evento con invitado y pide que Google le avise', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ id: 'evt_1', htmlLink: 'https://calendar.google.com/evt_1' }),
      { status: 200 },
    ));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    const result = await adapter.createEvent({
      accessToken: 'at_1',
      calendarId: 'cal_showings',
      summary: 'Showing — Ana — Pacific Ridge · 101',
      startAt: '2026-01-14T18:00:00.000Z',
      endAt: '2026-01-14T18:30:00.000Z',
      timeZone: 'America/Vancouver',
      attendeeEmails: ['ana@example.com'],
    });

    expect(result).toEqual({ eventId: 'evt_1', htmlLink: 'https://calendar.google.com/evt_1' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/calendars/cal_showings/events');
    expect(url).toContain('sendUpdates=all');
    expect(JSON.parse(String(init.body)).attendees).toEqual([{ email: 'ana@example.com' }]);
  });

  it('crea el evento sin invitados cuando no hay correo', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'evt_2' }), { status: 200 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    await adapter.createEvent({
      accessToken: 'at_1',
      calendarId: 'cal_showings',
      summary: 'Showing',
      startAt: '2026-01-14T18:00:00.000Z',
      endAt: '2026-01-14T18:30:00.000Z',
      timeZone: 'America/Vancouver',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('sendUpdates=none');
    expect(JSON.parse(String(init.body)).attendees).toBeUndefined();
  });

  it('trata un 410 al borrar como éxito, porque el evento ya no está', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 410 }));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    await expect(adapter.deleteEvent({
      accessToken: 'at_1', calendarId: 'cal_showings', eventId: 'evt_1',
    })).resolves.toBeUndefined();
  });

  it('lanza con detalle cuando Google rechaza la creación del evento', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'Insufficient permission' } }),
      { status: 403 },
    ));
    const adapter = new GoogleCalendarRealAdapter({ ...CONFIG, fetchImpl: fetchMock });

    await expect(adapter.createEvent({
      accessToken: 'at_1',
      calendarId: 'cal_showings',
      summary: 'Showing',
      startAt: '2026-01-14T18:00:00.000Z',
      endAt: '2026-01-14T18:30:00.000Z',
      timeZone: 'America/Vancouver',
    })).rejects.toThrow(/Insufficient permission/);
  });
});
```

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/adapters test -- google-calendar
```

Esperado: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar el adapter**

Crear `packages/adapters/src/real/google-calendar.real.ts`:

```ts
/**
 * Adapter real de Google Calendar. Solo HTTP: no sabe de la base de datos ni
 * de dónde salieron los tokens.
 *
 * Los scopes son deliberadamente estrechos. `calendar.freebusy` deja ver
 * CUÁNDO está ocupado el manager, nunca DE QUÉ; `calendar.app.created` limita
 * la escritura a los calendarios que esta app creó. Con eso, el token que
 * guardamos no alcanza para leer el detalle de ningún evento personal.
 */
import type {
  CalendarAdapter,
  CalendarBusyInterval,
  CalendarEventInput,
  CalendarRefreshResult,
} from '../contracts.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.app.created',
  'openid email',
].join(' ');

const SHOWINGS_CALENDAR_SUMMARY = 'Property Showings';

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

export class GoogleCalendarRealAdapter implements CalendarAdapter {
  readonly name = 'google_calendar' as const;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GoogleCalendarConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  buildAuthorizeUrl(input: { redirectUri: string; state: string }): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: SCOPES,
      // Sin estos dos Google no entrega refresh token en reconexiones.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: input.state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeAuthorizationCode(input: { code: string; redirectUri: string }): Promise<{
    refreshToken: string;
    accessToken: string;
    expiresInSeconds: number;
    accountEmail: string;
  }> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Google rechazó el canje del código: ${describeError(body, res.status)}`);
    }
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
    if (!refreshToken) {
      // Pasa cuando la cuenta ya autorizó antes y Google no vuelve a mandarlo.
      // Sin refresh token la conexión moriría en una hora, así que es un error.
      throw new Error('Google no devolvió refresh_token; revoca el acceso y vuelve a conectar');
    }
    return {
      refreshToken,
      accessToken: String(body.access_token ?? ''),
      expiresInSeconds: Number(body.expires_in ?? 0),
      accountEmail: emailFromIdToken(body.id_token),
    };
  }

  async refreshAccessToken(input: { refreshToken: string }): Promise<CalendarRefreshResult> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: input.refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (res.ok) {
      const body = (await res.json()) as { access_token: string; expires_in: number };
      return {
        ok: true,
        accessToken: body.access_token,
        expiresInSeconds: Number(body.expires_in ?? 0),
      };
    }
    const raw = await res.text().catch(() => '');
    // invalid_grant es la señal de Google para "ese refresh token ya no sirve":
    // el manager revocó el acceso, o caducó por estar la app en modo Testing.
    const revoked = res.status === 400 && raw.includes('invalid_grant');
    return {
      ok: false,
      reason: revoked ? 'revoked' : 'provider_error',
      detail: raw.slice(0, 500),
    };
  }

  async ensureShowingsCalendar(input: {
    accessToken: string;
    timeZone: string;
  }): Promise<{ calendarId: string }> {
    const listed = await this.request<{ items?: Array<{ id: string; summary?: string }> }>(
      input.accessToken,
      `${CALENDAR_API}/users/me/calendarList`,
      { method: 'GET' },
    );
    const existing = listed.items?.find((item) => item.summary === SHOWINGS_CALENDAR_SUMMARY);
    if (existing) return { calendarId: existing.id };

    const created = await this.request<{ id: string }>(
      input.accessToken,
      `${CALENDAR_API}/calendars`,
      {
        method: 'POST',
        body: JSON.stringify({
          summary: SHOWINGS_CALENDAR_SUMMARY,
          timeZone: input.timeZone,
        }),
      },
    );
    return { calendarId: created.id };
  }

  async getBusy(input: {
    accessToken: string;
    calendarIds: string[];
    from: string;
    to: string;
  }): Promise<CalendarBusyInterval[]> {
    const body = await this.request<{
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
    }>(input.accessToken, `${CALENDAR_API}/freeBusy`, {
      method: 'POST',
      body: JSON.stringify({
        timeMin: input.from,
        timeMax: input.to,
        items: input.calendarIds.map((id) => ({ id })),
      }),
    });

    const intervals: CalendarBusyInterval[] = [];
    for (const calendar of Object.values(body.calendars ?? {})) {
      for (const slot of calendar.busy ?? []) {
        intervals.push({ startAt: slot.start, endAt: slot.end });
      }
    }
    return intervals;
  }

  async createEvent(
    input: { accessToken: string } & CalendarEventInput,
  ): Promise<{ eventId: string; htmlLink?: string }> {
    const attendees = (input.attendeeEmails ?? []).filter((email) => email.length > 0);
    // sendUpdates=all hace que Google mande la invitación y el recordatorio
    // al prospecto; sin invitados no hay a quién avisarle.
    const sendUpdates = attendees.length > 0 ? 'all' : 'none';
    const created = await this.request<{ id: string; htmlLink?: string }>(
      input.accessToken,
      `${CALENDAR_API}/calendars/${encodeURIComponent(input.calendarId)}/events`
      + `?sendUpdates=${sendUpdates}`,
      {
        method: 'POST',
        body: JSON.stringify({
          summary: input.summary,
          description: input.description,
          location: input.location,
          start: { dateTime: input.startAt, timeZone: input.timeZone },
          end: { dateTime: input.endAt, timeZone: input.timeZone },
          ...(attendees.length > 0
            ? { attendees: attendees.map((email) => ({ email })) }
            : {}),
        }),
      },
    );
    return { eventId: created.id, htmlLink: created.htmlLink };
  }

  async deleteEvent(input: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<void> {
    const res = await this.fetchImpl(
      `${CALENDAR_API}/calendars/${encodeURIComponent(input.calendarId)}`
      + `/events/${encodeURIComponent(input.eventId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${input.accessToken}` },
      },
    );
    // 404/410 significan que el evento ya no está: el objetivo se cumplió.
    if (res.ok || res.status === 404 || res.status === 410) return;
    throw new Error(`Google rechazó el borrado del evento: ${res.status} ${await res.text()}`);
  }

  private async request<T>(accessToken: string, url: string, init: RequestInit): Promise<T> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Google Calendar respondió ${res.status}: ${describeError(body, res.status)}`);
    }
    return body as T;
  }
}

function describeError(body: Record<string, unknown>, status: number): string {
  const error = body.error;
  if (typeof error === 'string') return `${error} ${String(body.error_description ?? '')}`.trim();
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return `HTTP ${status}`;
}

/**
 * Saca el correo del payload del id_token. No se verifica la firma a
 * propósito: el token llegó directo del endpoint de Google sobre TLS, no de
 * un tercero, así que no hay nada que autenticar.
 */
function emailFromIdToken(idToken: unknown): string {
  if (typeof idToken !== 'string') return '';
  const payload = idToken.split('.')[1];
  if (!payload) return '';
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof decoded.email === 'string' ? decoded.email : '';
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Seleccionarlo en el factory**

En `packages/adapters/src/factory.ts`, importar `GoogleCalendarRealAdapter` y reemplazar la construcción provisional de la Tarea 4 por:

```ts
  const calendar: CalendarAdapter = isIntegrationConfigured(env, 'google_calendar')
    ? new GoogleCalendarRealAdapter({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    })
    : new CalendarMockAdapter();
```

Y agregar a `packages/adapters/src/factory.test.ts` el caso que la Tarea 4 no podía escribir todavía:

```ts
it('usa el adapter real cuando hay client id y secret', () => {
  const adapters = createAdapters({
    ...baseEnv,
    GOOGLE_CLIENT_ID: 'client-123',
    GOOGLE_CLIENT_SECRET: 'secret-456',
  });
  expect(adapters.calendar.name).toBe('google_calendar');
  expect(adapters.mockModes.google_calendar).toBe(false);
});
```

- [ ] **Step 5: Correr las pruebas**

```bash
pnpm --filter @property-manager/adapters test
pnpm -r exec tsc --noEmit
```

Esperado: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src
git commit -m "feat: GoogleCalendarRealAdapter con freebusy y calendario propio"
```

---

## Task 6: Servicio de conexión y ciclo de vida del token

**Files:**
- Create: `apps/api/src/services/calendar-connection.service.ts`
- Create: `apps/api/src/services/calendar-connection.service.test.ts`

**Interfaces:**
- Consumes: `CalendarAdapter` y `CalendarRefreshResult` (Tarea 4/5); `encrypt`/`decrypt` de `apps/api/src/config/crypto.ts`; `getEnv()` de `apps/api/src/config/env.ts`; `getAdapters()` de `apps/api/src/config/adapters.js`.
- Produces:
  - `function tenantOwnerKey(userId?: string | null): string`
  - `function signOAuthState(payload: { tenantId: string; userId: string }): string`
  - `function verifyOAuthState(state: string, now?: Date): { ok: true; tenantId: string; userId: string } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' }`
  - `function resolveRedirectUri(): string`
  - `type UsableAccessToken = { ok: true; accessToken: string; connection: { showingsCalendarId: string; ownerKey: string } } | { ok: false; reason: 'not_connected' | 'revoked' | 'provider_error' }`
  - `function getUsableAccessToken(tenantId: string): Promise<UsableAccessToken>`
  - `function saveCalendarConnection(input: { tenantId: string; userId?: string | null; accountEmail: string; showingsCalendarId: string; refreshToken: string; accessToken: string; expiresInSeconds: number }): Promise<void>`
  - `function getCalendarConnectionStatus(tenantId: string): Promise<{ connected: boolean; accountEmail?: string; status?: 'active' | 'revoked'; lastError?: string | null; lastErrorAt?: Date | null }>`
  - `function disconnectCalendar(tenantId: string): Promise<void>`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `apps/api/src/services/calendar-connection.service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';
import { decrypt } from '../config/crypto.js';
import {
  disconnectCalendar,
  getCalendarConnectionStatus,
  getUsableAccessToken,
  saveCalendarConnection,
  signOAuthState,
  tenantOwnerKey,
  verifyOAuthState,
} from './calendar-connection.service.js';

const TENANT_ID = 'tenant_test_calendar_connection';

async function cleanup() {
  await prisma.calendarConnection.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.tenant.create({
    data: { id: TENANT_ID, name: 'Calendar Connection Test', province: 'BC' },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('tenantOwnerKey', () => {
  it('distingue la conexión de agencia de la de un usuario', () => {
    expect(tenantOwnerKey(null)).toBe('tenant');
    expect(tenantOwnerKey('user_1')).toBe('user:user_1');
  });
});

describe('el state firmado del OAuth', () => {
  it('va y vuelve intacto', () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: 'user_1' });
    const result = verifyOAuthState(state);
    expect(result).toEqual({ ok: true, tenantId: TENANT_ID, userId: 'user_1' });
  });

  it('rechaza un state con la firma alterada', () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: 'user_1' });
    const tampered = `${state.split('.')[0]}.deadbeef`;
    const result = verifyOAuthState(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rechaza un state con el payload alterado', () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: 'user_1' });
    const forged = Buffer.from(
      JSON.stringify({ tenantId: 'otro_tenant', userId: 'user_1', exp: Date.now() + 60_000 }),
    ).toString('base64url');
    const result = verifyOAuthState(`${forged}.${state.split('.')[1]}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rechaza un state expirado', () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: 'user_1' });
    const later = new Date(Date.now() + 11 * 60_000);
    const result = verifyOAuthState(state, later);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rechaza basura', () => {
    expect(verifyOAuthState('no-es-un-state').ok).toBe(false);
  });
});

describe('saveCalendarConnection', () => {
  it('guarda los tokens cifrados, nunca en claro', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_super_secreto',
      accessToken: 'at_super_secreto',
      expiresInSeconds: 3600,
    });

    const row = await prisma.calendarConnection.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
    expect(row.refreshTokenEnc).not.toContain('rt_super_secreto');
    expect(decrypt(row.refreshTokenEnc)).toBe('rt_super_secreto');
    expect(decrypt(row.accessTokenEnc!)).toBe('at_super_secreto');
    expect(row.ownerKey).toBe('tenant');
    expect(row.status).toBe('active');
  });

  it('reconectar reemplaza la conexión en vez de crear otra', async () => {
    const input = {
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_1',
      expiresInSeconds: 3600,
    };
    await saveCalendarConnection(input);
    await saveCalendarConnection({ ...input, refreshToken: 'rt_2', accountEmail: 'otro@agencia.com' });

    const rows = await prisma.calendarConnection.findMany({ where: { tenantId: TENANT_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountEmail).toBe('otro@agencia.com');
    expect(decrypt(rows[0]!.refreshTokenEnc)).toBe('rt_2');
  });
});

describe('getUsableAccessToken', () => {
  it('devuelve not_connected cuando no hay conexión', async () => {
    const result = await getUsableAccessToken(TENANT_ID);
    expect(result).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('reutiliza el access token vigente sin llamar a Google', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_vigente',
      expiresInSeconds: 3600,
    });
    const { getAdapters } = await import('../config/adapters.js');
    const spy = vi.spyOn(getAdapters().calendar, 'refreshAccessToken');

    const result = await getUsableAccessToken(TENANT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accessToken).toBe('at_vigente');
    expect(spy).not.toHaveBeenCalled();
  });

  it('refresca cuando el access token está por vencer y guarda el nuevo', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_viejo',
      expiresInSeconds: 10, // dentro del margen de 60 s
    });
    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().calendar, 'refreshAccessToken').mockResolvedValue({
      ok: true, accessToken: 'at_nuevo', expiresInSeconds: 3600,
    });

    const result = await getUsableAccessToken(TENANT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accessToken).toBe('at_nuevo');

    const row = await prisma.calendarConnection.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
    expect(decrypt(row.accessTokenEnc!)).toBe('at_nuevo');
  });

  it('apaga la conexión cuando Google dice que el permiso fue revocado', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_viejo',
      expiresInSeconds: 10,
    });
    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().calendar, 'refreshAccessToken').mockResolvedValue({
      ok: false, reason: 'revoked', detail: 'invalid_grant',
    });

    expect(await getUsableAccessToken(TENANT_ID)).toEqual({ ok: false, reason: 'revoked' });

    const row = await prisma.calendarConnection.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
    expect(row.status).toBe('revoked');
    expect(row.lastError).toContain('invalid_grant');
  });

  it('NO apaga la conexión cuando el fallo es transitorio', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_viejo',
      expiresInSeconds: 10,
    });
    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().calendar, 'refreshAccessToken').mockResolvedValue({
      ok: false, reason: 'provider_error', detail: 'HTTP 500',
    });

    expect(await getUsableAccessToken(TENANT_ID)).toEqual({ ok: false, reason: 'provider_error' });

    const row = await prisma.calendarConnection.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
    expect(row.status).toBe('active');
  });

  it('devuelve revoked sin llamar a Google si la conexión ya está apagada', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_1',
      expiresInSeconds: 3600,
    });
    await prisma.calendarConnection.updateMany({
      where: { tenantId: TENANT_ID }, data: { status: 'revoked' },
    });
    const { getAdapters } = await import('../config/adapters.js');
    const spy = vi.spyOn(getAdapters().calendar, 'refreshAccessToken');

    expect(await getUsableAccessToken(TENANT_ID)).toEqual({ ok: false, reason: 'revoked' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('estado y desconexión', () => {
  it('reporta desconectado cuando no hay fila', async () => {
    expect(await getCalendarConnectionStatus(TENANT_ID)).toEqual({ connected: false });
  });

  it('reporta la cuenta conectada y borra al desconectar', async () => {
    await saveCalendarConnection({
      tenantId: TENANT_ID,
      accountEmail: 'manager@agencia.com',
      showingsCalendarId: 'cal_showings',
      refreshToken: 'rt_1',
      accessToken: 'at_1',
      expiresInSeconds: 3600,
    });

    const status = await getCalendarConnectionStatus(TENANT_ID);
    expect(status.connected).toBe(true);
    expect(status.accountEmail).toBe('manager@agencia.com');

    await disconnectCalendar(TENANT_ID);
    expect(await getCalendarConnectionStatus(TENANT_ID)).toEqual({ connected: false });
  });
});
```

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/api test -- calendar-connection
```

Esperado: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

Crear `apps/api/src/services/calendar-connection.service.ts`:

```ts
/**
 * Conexión de la agencia con Google Calendar: guardar, leer y mantener vivo
 * el access token.
 *
 * El adapter hace HTTP y nada más; aquí vive todo lo que toca la base de
 * datos y el cifrado de credenciales.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '../config/db.js';
import { decrypt, encrypt } from '../config/crypto.js';
import { getEnv } from '../config/env.js';
import { writeAudit } from './audit.service.js';

/** Margen antes de considerar vencido un access token. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** Vigencia del `state` del OAuth. */
const STATE_TTL_MS = 10 * 60_000;

/**
 * Llave de unicidad de la conexión. En Postgres dos NULL se consideran
 * distintos entre sí, así que una unique sobre `userId` nulo no impediría dos
 * conexiones de agencia: esta llave sintética sí.
 */
export function tenantOwnerKey(userId?: string | null): string {
  return userId ? `user:${userId}` : 'tenant';
}

export function resolveRedirectUri(): string {
  const env = getEnv();
  return env.GOOGLE_OAUTH_REDIRECT_URI
    || `${env.API_URL}/integrations/google-calendar/callback`;
}

function stateSignature(payload: string): string {
  return createHmac('sha256', getEnv().JWT_ACCESS_SECRET).update(payload).digest('base64url');
}

export function signOAuthState(input: { tenantId: string; userId: string }): string {
  const payload = Buffer.from(JSON.stringify({
    tenantId: input.tenantId,
    userId: input.userId,
    exp: Date.now() + STATE_TTL_MS,
  })).toString('base64url');
  return `${payload}.${stateSignature(payload)}`;
}

export type OAuthStateResult =
  | { ok: true; tenantId: string; userId: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyOAuthState(state: string, now: Date = new Date()): OAuthStateResult {
  const [payload, signature] = state.split('.');
  if (!payload || !signature) return { ok: false, reason: 'malformed' };

  const expected = Buffer.from(stateSignature(payload));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'bad_signature' };
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      tenantId?: unknown; userId?: unknown; exp?: unknown;
    };
    if (typeof decoded.tenantId !== 'string' || typeof decoded.userId !== 'string') {
      return { ok: false, reason: 'malformed' };
    }
    if (typeof decoded.exp !== 'number' || decoded.exp < now.getTime()) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, tenantId: decoded.tenantId, userId: decoded.userId };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

export async function saveCalendarConnection(input: {
  tenantId: string;
  userId?: string | null;
  accountEmail: string;
  showingsCalendarId: string;
  refreshToken: string;
  accessToken: string;
  expiresInSeconds: number;
}): Promise<void> {
  const ownerKey = tenantOwnerKey(input.userId);
  const data = {
    userId: input.userId ?? null,
    accountEmail: input.accountEmail,
    showingsCalendarId: input.showingsCalendarId,
    refreshTokenEnc: encrypt(input.refreshToken),
    accessTokenEnc: encrypt(input.accessToken),
    accessTokenExpiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    status: 'active' as const,
    lastError: null,
    lastErrorAt: null,
  };

  await prisma.calendarConnection.upsert({
    where: { tenantId_ownerKey: { tenantId: input.tenantId, ownerKey } },
    update: data,
    create: { tenantId: input.tenantId, ownerKey, provider: 'google', ...data },
  });

  // Nunca se auditan tokens, solo con qué cuenta quedó conectada.
  await writeAudit({
    tenantId: input.tenantId,
    actorId: input.userId ?? 'system',
    actorType: input.userId ? 'user' : 'system',
    action: 'calendar.connected',
    entityType: 'calendar_connection',
    entityId: ownerKey,
    payload: { accountEmail: input.accountEmail, showingsCalendarId: input.showingsCalendarId },
  });
}

export type UsableAccessToken =
  | {
    ok: true;
    accessToken: string;
    connection: { showingsCalendarId: string; ownerKey: string };
  }
  | { ok: false; reason: 'not_connected' | 'revoked' | 'provider_error' };

export async function getUsableAccessToken(tenantId: string): Promise<UsableAccessToken> {
  const connection = await prisma.calendarConnection.findUnique({
    where: { tenantId_ownerKey: { tenantId, ownerKey: tenantOwnerKey(null) } },
  });
  if (!connection) return { ok: false, reason: 'not_connected' };
  if (connection.status === 'revoked') return { ok: false, reason: 'revoked' };

  const stillValid = connection.accessTokenEnc
    && connection.accessTokenExpiresAt
    && connection.accessTokenExpiresAt.getTime() - Date.now() > TOKEN_EXPIRY_MARGIN_MS;
  if (stillValid) {
    return {
      ok: true,
      accessToken: decrypt(connection.accessTokenEnc!),
      connection: {
        showingsCalendarId: connection.showingsCalendarId,
        ownerKey: connection.ownerKey,
      },
    };
  }

  const { getAdapters } = await import('../config/adapters.js');
  const refreshed = await getAdapters().calendar.refreshAccessToken({
    refreshToken: decrypt(connection.refreshTokenEnc),
  });

  if (!refreshed.ok) {
    if (refreshed.reason === 'revoked') {
      await prisma.calendarConnection.update({
        where: { id: connection.id },
        data: { status: 'revoked', lastError: refreshed.detail, lastErrorAt: new Date() },
      });
      return { ok: false, reason: 'revoked' };
    }
    // Transitorio: la conexión se queda encendida a propósito.
    await prisma.calendarConnection.update({
      where: { id: connection.id },
      data: { lastError: refreshed.detail, lastErrorAt: new Date() },
    });
    return { ok: false, reason: 'provider_error' };
  }

  await prisma.calendarConnection.update({
    where: { id: connection.id },
    data: {
      accessTokenEnc: encrypt(refreshed.accessToken),
      accessTokenExpiresAt: new Date(Date.now() + refreshed.expiresInSeconds * 1000),
      lastError: null,
      lastErrorAt: null,
    },
  });

  return {
    ok: true,
    accessToken: refreshed.accessToken,
    connection: {
      showingsCalendarId: connection.showingsCalendarId,
      ownerKey: connection.ownerKey,
    },
  };
}

export async function getCalendarConnectionStatus(tenantId: string): Promise<{
  connected: boolean;
  accountEmail?: string;
  status?: 'active' | 'revoked';
  lastError?: string | null;
  lastErrorAt?: Date | null;
}> {
  const connection = await prisma.calendarConnection.findUnique({
    where: { tenantId_ownerKey: { tenantId, ownerKey: tenantOwnerKey(null) } },
  });
  if (!connection) return { connected: false };
  return {
    connected: true,
    accountEmail: connection.accountEmail,
    status: connection.status,
    lastError: connection.lastError,
    lastErrorAt: connection.lastErrorAt,
  };
}

export async function disconnectCalendar(tenantId: string): Promise<void> {
  await prisma.calendarConnection.deleteMany({
    where: { tenantId, ownerKey: tenantOwnerKey(null) },
  });
  await writeAudit({
    tenantId,
    actorId: 'system',
    actorType: 'system',
    action: 'calendar.disconnected',
    entityType: 'calendar_connection',
    entityId: tenantOwnerKey(null),
    payload: {},
  });
}
```

- [ ] **Step 4: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/api test -- calendar-connection
```

Esperado: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/calendar-connection.service.ts apps/api/src/services/calendar-connection.service.test.ts
git commit -m "feat: servicio de conexión de calendario con tokens cifrados"
```

---

## Task 7: Configuración de agenda

**Files:**
- Create: `apps/api/src/services/scheduling-config.service.ts`
- Create: `apps/api/src/services/scheduling-config.service.test.ts`

**Interfaces:**
- Consumes: `WeeklyHoursSchema`, `DEFAULT_WEEKLY_HOURS`, `WeeklyHours` de `@property-manager/core`; `normalizeShowingDuration` de `./scheduling.service.js`.
- Produces:
  - `interface SchedulingConfigView { weeklyHours: WeeklyHours; timeZone: string; showingDurationMinutes: number; bufferMinutes: number; minNoticeHours: number; maxAdvanceDays: number; slotGranularityMinutes: number }`
  - `function getSchedulingConfig(tenantId: string): Promise<SchedulingConfigView>`
  - `type UpdateSchedulingConfigResult = { ok: true; config: SchedulingConfigView } | { ok: false; status: 400; error: string }`
  - `function updateSchedulingConfig(tenantId: string, input: unknown): Promise<UpdateSchedulingConfigResult>`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `apps/api/src/services/scheduling-config.service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WEEKLY_HOURS } from '@property-manager/core';
import { prisma } from '../config/db.js';
import { getSchedulingConfig, updateSchedulingConfig } from './scheduling-config.service.js';

const TENANT_ID = 'tenant_test_scheduling_config';

async function cleanup() {
  await prisma.schedulingConfig.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.tenant.create({
    data: { id: TENANT_ID, name: 'Scheduling Config Test', province: 'BC' },
  });
});

afterEach(cleanup);

describe('getSchedulingConfig', () => {
  it('crea la fila con los valores por defecto la primera vez', async () => {
    const config = await getSchedulingConfig(TENANT_ID);
    expect(config.weeklyHours).toEqual(DEFAULT_WEEKLY_HOURS);
    expect(config.timeZone).toBe('America/Vancouver');
    expect(config.showingDurationMinutes).toBe(30);
    expect(config.bufferMinutes).toBe(30);
    expect(config.minNoticeHours).toBe(4);
    expect(config.maxAdvanceDays).toBe(14);
    expect(config.slotGranularityMinutes).toBe(30);

    expect(await prisma.schedulingConfig.count({ where: { tenantId: TENANT_ID } })).toBe(1);
  });

  it('no duplica la fila al leerla dos veces', async () => {
    await getSchedulingConfig(TENANT_ID);
    await getSchedulingConfig(TENANT_ID);
    expect(await prisma.schedulingConfig.count({ where: { tenantId: TENANT_ID } })).toBe(1);
  });

  it('vuelve a los valores por defecto si la fila tiene un horario corrupto', async () => {
    await getSchedulingConfig(TENANT_ID);
    await prisma.schedulingConfig.updateMany({
      where: { tenantId: TENANT_ID },
      data: { weeklyHours: { basura: true } },
    });
    const config = await getSchedulingConfig(TENANT_ID);
    expect(config.weeklyHours).toEqual(DEFAULT_WEEKLY_HOURS);
  });
});

describe('updateSchedulingConfig', () => {
  it('guarda un horario válido', async () => {
    const weeklyHours = {
      ...DEFAULT_WEEKLY_HOURS,
      sat: [{ from: '10:00', to: '14:00' }],
    };
    const result = await updateSchedulingConfig(TENANT_ID, {
      weeklyHours,
      timeZone: 'America/Vancouver',
      showingDurationMinutes: 45,
      bufferMinutes: 15,
      minNoticeHours: 2,
      maxAdvanceDays: 21,
      slotGranularityMinutes: 15,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.weeklyHours.sat).toEqual([{ from: '10:00', to: '14:00' }]);
      expect(result.config.showingDurationMinutes).toBe(45);
    }
  });

  it('rechaza una duración que no es 15/30/45/60', async () => {
    const result = await updateSchedulingConfig(TENANT_ID, {
      weeklyHours: DEFAULT_WEEKLY_HOURS,
      timeZone: 'America/Vancouver',
      showingDurationMinutes: 37,
      bufferMinutes: 30,
      minNoticeHours: 4,
      maxAdvanceDays: 14,
      slotGranularityMinutes: 30,
    });
    expect(result).toEqual({ ok: false, status: 400, error: expect.any(String) });
  });

  it('rechaza rangos traslapados', async () => {
    const result = await updateSchedulingConfig(TENANT_ID, {
      weeklyHours: {
        ...DEFAULT_WEEKLY_HOURS,
        mon: [{ from: '09:00', to: '12:00' }, { from: '11:00', to: '15:00' }],
      },
      timeZone: 'America/Vancouver',
      showingDurationMinutes: 30,
      bufferMinutes: 30,
      minNoticeHours: 4,
      maxAdvanceDays: 14,
      slotGranularityMinutes: 30,
    });
    expect(result.ok).toBe(false);
  });

  it('rechaza una zona horaria que no existe', async () => {
    const result = await updateSchedulingConfig(TENANT_ID, {
      weeklyHours: DEFAULT_WEEKLY_HOURS,
      timeZone: 'Marte/Olympus',
      showingDurationMinutes: 30,
      bufferMinutes: 30,
      minNoticeHours: 4,
      maxAdvanceDays: 14,
      slotGranularityMinutes: 30,
    });
    expect(result.ok).toBe(false);
  });

  it('rechaza valores fuera de rango', async () => {
    const base = {
      weeklyHours: DEFAULT_WEEKLY_HOURS,
      timeZone: 'America/Vancouver',
      showingDurationMinutes: 30,
      bufferMinutes: 30,
      minNoticeHours: 4,
      maxAdvanceDays: 14,
      slotGranularityMinutes: 30,
    };
    expect((await updateSchedulingConfig(TENANT_ID, { ...base, bufferMinutes: 121 })).ok).toBe(false);
    expect((await updateSchedulingConfig(TENANT_ID, { ...base, minNoticeHours: 73 })).ok).toBe(false);
    expect((await updateSchedulingConfig(TENANT_ID, { ...base, maxAdvanceDays: 0 })).ok).toBe(false);
    expect((await updateSchedulingConfig(TENANT_ID, { ...base, slotGranularityMinutes: 45 })).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/api test -- scheduling-config
```

Esperado: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

Crear `apps/api/src/services/scheduling-config.service.ts`:

```ts
/**
 * Configuración de agenda por tenant: cuándo se puede agendar, con qué
 * duración, colchón y ventana.
 *
 * Google dice cuándo el manager está OCUPADO; esto dice cuándo TRABAJA.
 */
import { z } from 'zod';
import {
  DEFAULT_WEEKLY_HOURS,
  WeeklyHoursSchema,
  type WeeklyHours,
} from '@property-manager/core';
import { prisma } from '../config/db.js';

export interface SchedulingConfigView {
  weeklyHours: WeeklyHours;
  timeZone: string;
  showingDurationMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxAdvanceDays: number;
  slotGranularityMinutes: number;
}

function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const updateSchema = z.object({
  weeklyHours: WeeklyHoursSchema,
  timeZone: z.string().refine(isKnownTimeZone, 'Zona horaria desconocida'),
  showingDurationMinutes: z.union([
    z.literal(15), z.literal(30), z.literal(45), z.literal(60),
  ]),
  bufferMinutes: z.number().int().min(0).max(120),
  minNoticeHours: z.number().int().min(0).max(72),
  maxAdvanceDays: z.number().int().min(1).max(60),
  slotGranularityMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
});

export async function getSchedulingConfig(tenantId: string): Promise<SchedulingConfigView> {
  const row = await prisma.schedulingConfig.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId, weeklyHours: DEFAULT_WEEKLY_HOURS },
  });

  // Si el JSON guardado no cumple el esquema (edición manual en la base,
  // migración a medias), se cae a los valores por defecto en vez de romper
  // el agendamiento entero.
  const parsed = WeeklyHoursSchema.safeParse(row.weeklyHours);

  return {
    weeklyHours: parsed.success ? parsed.data : DEFAULT_WEEKLY_HOURS,
    timeZone: row.timeZone,
    showingDurationMinutes: row.showingDurationMinutes,
    bufferMinutes: row.bufferMinutes,
    minNoticeHours: row.minNoticeHours,
    maxAdvanceDays: row.maxAdvanceDays,
    slotGranularityMinutes: row.slotGranularityMinutes,
  };
}

export type UpdateSchedulingConfigResult =
  | { ok: true; config: SchedulingConfigView }
  | { ok: false; status: 400; error: string };

export async function updateSchedulingConfig(
  tenantId: string,
  input: unknown,
): Promise<UpdateSchedulingConfigResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    };
  }

  const data = parsed.data;
  await prisma.schedulingConfig.upsert({
    where: { tenantId },
    update: { ...data, weeklyHours: data.weeklyHours },
    create: { tenantId, ...data, weeklyHours: data.weeklyHours },
  });

  return { ok: true, config: data };
}
```

- [ ] **Step 4: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/api test -- scheduling-config
```

Esperado: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/scheduling-config.service.ts apps/api/src/services/scheduling-config.service.test.ts
git commit -m "feat: configuración de agenda por tenant"
```

---

## Task 8: Disponibilidad y reserva contra el calendario

**Files:**
- Modify: `apps/api/src/services/scheduling.service.ts`
- Create: `apps/api/src/services/scheduling-calendar.service.test.ts`
- Modify: `apps/api/src/services/scheduling.service.test.ts` (quitar el caso de `resolveShowingBooking`)

El archivo de pruebas existente es puro (sin base de datos) y así se queda. Lo nuevo toca Prisma, así que va en un archivo aparte con su propio `TENANT_ID` y su propia limpieza, igual que `owner-statement.service.test.ts`.

**Interfaces:**
- Consumes: `getUsableAccessToken` (Tarea 6), `getSchedulingConfig` (Tarea 7), `computeAvailableSlots` (Tarea 3), `getAdapters().calendar` (Tarea 4/5).
- Produces:
  - `interface AvailableSlot { index: number; startAt: string; endAt: string; label: string }`
  - `type SchedulingAvailabilityResult = { ok: true; slots: AvailableSlot[] } | { ok: false; reason: 'not_connected' | 'revoked' | 'provider_error' | 'no_slots' | 'unit_not_found' }`
  - `function getSchedulingAvailability(tenantId: string, unitId: string): Promise<SchedulingAvailabilityResult>`
  - `type BookShowingResult = { ok: true; showingId: string; scheduledAt: string; googleEventId: string } | { ok: false; status: 404; error: 'unit_not_found' | 'lead_not_found' } | { ok: false; status: 409; error: 'slot_taken' | 'slot_no_longer_offered' | 'prospect_double_booked' } | { ok: false; status: 503; error: 'calendar_unavailable' }`
  - `function bookShowingFromCalendar(input: BookShowingInput): Promise<BookShowingResult>`
  - `function formatSlotLabel(input: { startAt: string; timeZone: string }): string`
- Elimina: `scheduleTour`, `getAvailableSlots`, `resolveShowingBooking` y `notifyBroker` (solo la usaba `scheduleTour`), junto con sus pruebas.

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `apps/api/src/services/scheduling-calendar.service.test.ts`. Encabezado, limpieza y sembrado:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zonedDateTimeToUtc } from '@property-manager/core';
import { prisma } from '../config/db.js';
import { saveCalendarConnection } from './calendar-connection.service.js';
import {
  bookShowingFromCalendar,
  cancelShowing,
  getSchedulingAvailability,
} from './scheduling.service.js';

const TENANT_ID = 'tenant_test_scheduling_calendar';

async function cleanup() {
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.conversationEvent.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.unit.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.property.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.calendarConnection.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.schedulingConfig.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

async function seed() {
  await prisma.tenant.create({
    data: { id: TENANT_ID, name: 'Scheduling Calendar Test', province: 'BC' },
  });
  const user = await prisma.user.create({
    data: {
      tenantId: TENANT_ID,
      email: `pm-${TENANT_ID}@example.com`,
      passwordHash: 'x',
      firstName: 'Pat',
      lastName: 'Manager',
      role: 'property_manager',
    },
  });
  const property = await prisma.property.create({
    data: {
      tenantId: TENANT_ID,
      name: 'Pacific Ridge',
      address: '100 Test St',
      city: 'Vancouver',
      province: 'BC',
    },
  });
  const unit = await prisma.unit.create({
    data: {
      tenantId: TENANT_ID,
      propertyId: property.id,
      name: 'Unit 101',
      rentCents: 200_000,
      slug: `unit-101-${TENANT_ID}`,
    },
  });
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, name: 'Ana Prospect', phone: '+16045550111', status: 'contacted' },
  });
  const secondLead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, name: 'Beto Prospect', phone: '+16045550222', status: 'contacted' },
  });
  return {
    unitId: unit.id,
    leadId: lead.id,
    secondLeadId: secondLead.id,
    userId: user.id,
  };
}

/** Conecta el calendario por el servicio real, no escribiendo la fila a mano. */
async function connectCalendar() {
  await saveCalendarConnection({
    tenantId: TENANT_ID,
    accountEmail: 'manager@agencia.com',
    showingsCalendarId: 'mock_showings_calendar',
    refreshToken: 'rt_test',
    accessToken: 'at_test',
    expiresInSeconds: 3600,
  });
}

beforeEach(async () => {
  await cleanup();
  // getAdapters() cachea un único set por proceso: sin esto, los eventos que
  // cree una prueba se reportan como ocupados en la siguiente.
  const { getAdapters } = await import('../config/adapters.js');
  const calendar = getAdapters().calendar as { reset?: () => void };
  calendar.reset?.();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});
```

Los campos exactos de `Lead`, `Unit` y `Property` deben confirmarse contra `apps/api/prisma/schema.prisma` antes de escribir: si alguno es obligatorio y no está arriba, agregarlo.

Y los casos:

```ts
describe('getSchedulingAvailability', () => {
  it('devuelve not_connected cuando la agencia no conectó su calendario', async () => {
    const { unitId } = await seed();
    expect(await getSchedulingAvailability(TENANT_ID, unitId)).toEqual({
      ok: false, reason: 'not_connected',
    });
  });

  it('devuelve revoked cuando el permiso fue retirado', async () => {
    const { unitId } = await seed();
    await connectCalendar();
    await prisma.calendarConnection.updateMany({
      where: { tenantId: TENANT_ID }, data: { status: 'revoked' },
    });
    expect(await getSchedulingAvailability(TENANT_ID, unitId)).toEqual({
      ok: false, reason: 'revoked',
    });
  });

  it('devuelve provider_error cuando Google falla al pedir disponibilidad', async () => {
    const { unitId } = await seed();
    await connectCalendar();
    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().calendar, 'getBusy').mockRejectedValue(new Error('boom'));

    expect(await getSchedulingAvailability(TENANT_ID, unitId)).toEqual({
      ok: false, reason: 'provider_error',
    });
  });

  it('ofrece a lo más 6 huecos, etiquetados en la zona configurada', async () => {
    const { unitId } = await seed();
    await connectCalendar();

    const result = await getSchedulingAvailability(TENANT_ID, unitId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slots.length).toBeGreaterThan(0);
      expect(result.slots.length).toBeLessThanOrEqual(6);
      expect(result.slots[0]!.index).toBe(0);
      expect(result.slots[0]!.label).toMatch(/\d/);
    }
  });

  it('devuelve no_slots cuando el horario laboral está vacío', async () => {
    const { unitId } = await seed();
    await connectCalendar();
    await prisma.schedulingConfig.upsert({
      where: { tenantId: TENANT_ID },
      update: { weeklyHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } },
      create: {
        tenantId: TENANT_ID,
        weeklyHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
      },
    });

    expect(await getSchedulingAvailability(TENANT_ID, unitId)).toEqual({
      ok: false, reason: 'no_slots',
    });
  });
});

describe('bookShowingFromCalendar', () => {
  it('crea el showing y el evento de Google', async () => {
    const { unitId, leadId } = await seed();
    await connectCalendar();
    const available = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!available.ok) throw new Error('se esperaban huecos');

    const result = await bookShowingFromCalendar({
      tenantId: TENANT_ID,
      unitId,
      leadId,
      startAt: new Date(available.slots[0]!.startAt),
      prospectName: 'Ana Prospect',
      prospectEmail: 'ana@example.com',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const showing = await prisma.showing.findUniqueOrThrow({ where: { id: result.showingId } });
    expect(showing.googleEventId).toBe(result.googleEventId);
    expect(showing.calendarSlotKey).toContain('tenant:');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status)
      .toBe('tour_scheduled');
  });

  it('rechaza un horario que ya no se está ofreciendo', async () => {
    const { unitId, leadId } = await seed();
    await connectCalendar();

    const result = await bookShowingFromCalendar({
      tenantId: TENANT_ID,
      unitId,
      leadId,
      // Un domingo a las 3 de la mañana: nunca está en el horario laboral.
      startAt: zonedDateTimeToUtc(2026, 1, 11, 3, 0, 'America/Vancouver'),
      prospectName: 'Ana Prospect',
    });

    expect(result).toEqual({ ok: false, status: 409, error: 'slot_no_longer_offered' });
  });

  it('con dos reservas simultáneas del mismo horario, crea exactamente un showing', async () => {
    const { unitId, leadId, secondLeadId } = await seed();
    await connectCalendar();
    const available = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!available.ok) throw new Error('se esperaban huecos');
    const startAt = new Date(available.slots[0]!.startAt);

    const [first, second] = await Promise.all([
      bookShowingFromCalendar({
        tenantId: TENANT_ID, unitId, leadId, startAt, prospectName: 'Ana',
      }),
      bookShowingFromCalendar({
        tenantId: TENANT_ID, unitId, leadId: secondLeadId, startAt, prospectName: 'Beto',
      }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);

    // Cuál de los dos 409 sale depende de si el segundo alcanzó a leer la
    // disponibilidad antes o después de que el primero creara su evento. Lo
    // que NO depende de la carrera, y es lo que importa, es que solo quede un
    // showing: esa garantía la da la unique de base, no el orden.
    const rejected = outcomes.find((outcome) => !outcome.ok);
    expect(rejected && !rejected.ok && rejected.error)
      .toMatch(/^(slot_taken|slot_no_longer_offered)$/);
    expect(await prisma.showing.count({ where: { tenantId: TENANT_ID } })).toBe(1);
  });

  it('no deja ningún showing si Google rechaza el evento', async () => {
    const { unitId, leadId } = await seed();
    await connectCalendar();
    const available = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!available.ok) throw new Error('se esperaban huecos');
    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().calendar, 'createEvent').mockRejectedValue(new Error('403'));

    const result = await bookShowingFromCalendar({
      tenantId: TENANT_ID,
      unitId,
      leadId,
      startAt: new Date(available.slots[0]!.startAt),
      prospectName: 'Ana Prospect',
    });

    expect(result).toEqual({ ok: false, status: 503, error: 'calendar_unavailable' });
    expect(await prisma.showing.count({ where: { tenantId: TENANT_ID } })).toBe(0);
  });

  it('el hueco reservado deja de ofrecerse', async () => {
    const { unitId, leadId } = await seed();
    await connectCalendar();
    const before = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!before.ok) throw new Error('se esperaban huecos');
    const startAt = before.slots[0]!.startAt;

    await bookShowingFromCalendar({
      tenantId: TENANT_ID, unitId, leadId, startAt: new Date(startAt), prospectName: 'Ana',
    });

    const after = await getSchedulingAvailability(TENANT_ID, unitId);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.slots.map((slot) => slot.startAt)).not.toContain(startAt);
  });
});

describe('cancelShowing', () => {
  it('borra el evento de Google y libera el hueco', async () => {
    const { unitId, leadId, userId } = await seed();
    await connectCalendar();
    const available = await getSchedulingAvailability(TENANT_ID, unitId);
    if (!available.ok) throw new Error('se esperaban huecos');
    const booked = await bookShowingFromCalendar({
      tenantId: TENANT_ID, unitId, leadId,
      startAt: new Date(available.slots[0]!.startAt), prospectName: 'Ana',
    });
    if (!booked.ok) throw new Error('la reserva debió funcionar');

    const { getAdapters } = await import('../config/adapters.js');
    const deleteSpy = vi.spyOn(getAdapters().calendar, 'deleteEvent');

    await cancelShowing(booked.showingId, TENANT_ID, userId, 'el prospecto canceló');

    expect(deleteSpy).toHaveBeenCalled();
    const showing = await prisma.showing.findUniqueOrThrow({ where: { id: booked.showingId } });
    expect(showing.status).toBe('cancelled');
    expect(showing.calendarSlotKey).toBeNull();
  });
});
```

`connectCalendar()` usa el `mock_showings_calendar` que devuelve el `CalendarMockAdapter`, así que los eventos que cree la reserva se reportan de vuelta como ocupados y la prueba de "el hueco reservado deja de ofrecerse" funciona de punta a punta sin red.

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/api test -- scheduling-calendar
```

Esperado: FAIL — las funciones nuevas no existen.

- [ ] **Step 3: Implementar `getSchedulingAvailability` y el etiquetado**

En `apps/api/src/services/scheduling.service.ts`, agregar los imports:

```ts
import { computeAvailableSlots } from '@property-manager/core';
import { getUsableAccessToken } from './calendar-connection.service.js';
import { getSchedulingConfig } from './scheduling-config.service.js';
```

Reemplazar el `formatSlotLabel` actual (que recibe un `ShowMojoSlot` y formatea en la zona del servidor) por:

```ts
/**
 * Etiqueta legible del hueco, formateada EN LA ZONA DE LA CONFIGURACIÓN.
 * Formatear en la del servidor le diría al prospecto la hora equivocada
 * en cuanto la API corra en UTC.
 */
export function formatSlotLabel(input: { startAt: string; timeZone: string }): string {
  const start = new Date(input.startAt);
  const day = start.toLocaleDateString('en-CA', {
    timeZone: input.timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const time = start.toLocaleTimeString('en-CA', {
    timeZone: input.timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${day} at ${time}`;
}
```

Y agregar:

```ts
export interface AvailableSlot {
  index: number;
  startAt: string;
  endAt: string;
  label: string;
}

export type SchedulingAvailabilityResult =
  | { ok: true; slots: AvailableSlot[] }
  | {
    ok: false;
    reason: 'not_connected' | 'revoked' | 'provider_error' | 'no_slots' | 'unit_not_found';
  };

/** Cuántas opciones caben en un mensaje de chat sin abrumar. */
const MAX_OFFERED_SLOTS = 6;

export async function getSchedulingAvailability(
  tenantId: string,
  unitId: string,
): Promise<SchedulingAvailabilityResult> {
  const unit = await prisma.unit.findFirst({ where: { id: unitId, tenantId } });
  if (!unit) return { ok: false, reason: 'unit_not_found' };

  const token = await getUsableAccessToken(tenantId);
  if (!token.ok) return { ok: false, reason: token.reason };

  const config = await getSchedulingConfig(tenantId);
  const now = Date.now();
  const from = new Date(now + config.minNoticeHours * 60 * 60_000);
  const to = new Date(now + config.maxAdvanceDays * 24 * 60 * 60_000);

  const { getAdapters } = await import('../config/adapters.js');
  let busy;
  try {
    busy = await getAdapters().calendar.getBusy({
      accessToken: token.accessToken,
      // Los dos: el principal y el nuestro. Sin el nuestro, el bot ofrecería
      // un horario donde ya hay otro showing.
      calendarIds: ['primary', token.connection.showingsCalendarId],
      from: from.toISOString(),
      to: to.toISOString(),
    });
  } catch {
    return { ok: false, reason: 'provider_error' };
  }

  const slots = computeAvailableSlots({
    from,
    to,
    weeklyHours: config.weeklyHours,
    busy: busy.map((interval) => ({
      start: new Date(interval.startAt),
      end: new Date(interval.endAt),
    })),
    timeZone: config.timeZone,
    durationMinutes: config.showingDurationMinutes,
    bufferMinutes: config.bufferMinutes,
    granularityMinutes: config.slotGranularityMinutes,
  });

  if (slots.length === 0) return { ok: false, reason: 'no_slots' };

  return {
    ok: true,
    slots: slots.slice(0, MAX_OFFERED_SLOTS).map((slot, index) => ({
      index,
      startAt: slot.start.toISOString(),
      endAt: slot.end.toISOString(),
      label: formatSlotLabel({ startAt: slot.start.toISOString(), timeZone: config.timeZone }),
    })),
  };
}
```

- [ ] **Step 4: Implementar `bookShowingFromCalendar`**

```ts
export interface BookShowingInput {
  tenantId: string;
  unitId: string;
  leadId: string;
  startAt: Date;
  prospectName: string;
  prospectEmail?: string;
  prospectPhone?: string;
  conversationId?: string;
}

export type BookShowingResult =
  | { ok: true; showingId: string; scheduledAt: string; googleEventId: string }
  | { ok: false; status: 404; error: 'unit_not_found' | 'lead_not_found' }
  | {
    ok: false;
    status: 409;
    error: 'slot_taken' | 'slot_no_longer_offered' | 'prospect_double_booked';
  }
  | { ok: false; status: 503; error: 'calendar_unavailable' };

export async function bookShowingFromCalendar(
  input: BookShowingInput,
): Promise<BookShowingResult> {
  const lead = await prisma.lead.findFirst({
    where: { id: input.leadId, tenantId: input.tenantId },
  });
  if (!lead) return { ok: false, status: 404, error: 'lead_not_found' };

  const unit = await prisma.unit.findFirst({
    where: { id: input.unitId, tenantId: input.tenantId },
    include: { property: true },
  });
  if (!unit) return { ok: false, status: 404, error: 'unit_not_found' };

  // Se recalcula a propósito: los pending_slots guardados en la conversación
  // pueden tener media hora de viejos.
  const availability = await getSchedulingAvailability(input.tenantId, input.unitId);
  if (!availability.ok) {
    return availability.reason === 'no_slots'
      ? { ok: false, status: 409, error: 'slot_no_longer_offered' }
      : { ok: false, status: 503, error: 'calendar_unavailable' };
  }
  const startIso = input.startAt.toISOString();
  const chosen = availability.slots.find((slot) => slot.startAt === startIso);
  if (!chosen) return { ok: false, status: 409, error: 'slot_no_longer_offered' };

  const token = await getUsableAccessToken(input.tenantId);
  if (!token.ok) return { ok: false, status: 503, error: 'calendar_unavailable' };

  const config = await getSchedulingConfig(input.tenantId);
  const calendarSlotKey = `${token.connection.ownerKey}:${startIso}`;

  // Primero la base: el INSERT es el paso que reserva el hueco de forma
  // atómica. Al revés, dos reservas simultáneas crearían ambas su evento
  // antes de chocar entre sí.
  let showingId: string;
  try {
    showingId = await prisma.$transaction(async (tx) => {
      const showing = await tx.showing.create({
        data: {
          tenantId: input.tenantId,
          leadId: input.leadId,
          unitId: input.unitId,
          scheduledAt: input.startAt,
          durationMinutes: config.showingDurationMinutes,
          status: 'scheduled',
          calendarSlotKey,
          activeSlotKey: `${input.leadId}:${startIso}`,
          activeProspectSlotKey: buildProspectSlotKey(
            { leadId: input.leadId, email: input.prospectEmail, phone: input.prospectPhone },
            input.startAt,
          ),
        },
      });
      await tx.lead.update({
        where: { id: input.leadId },
        data: { unitId: input.unitId, status: 'tour_scheduled' },
      });
      if (input.conversationId) {
        await tx.chatConversation.updateMany({
          where: { id: input.conversationId, tenantId: input.tenantId },
          data: { unitId: input.unitId },
        });
      }
      return showing.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'calendarSlotKey')) {
      return { ok: false, status: 409, error: 'slot_taken' };
    }
    if (isUniqueViolation(error, 'activeProspectSlotKey')
      || isUniqueViolation(error, 'activeSlotKey')) {
      return { ok: false, status: 409, error: 'prospect_double_booked' };
    }
    throw error;
  }

  const { getAdapters } = await import('../config/adapters.js');
  try {
    const event = await getAdapters().calendar.createEvent({
      accessToken: token.accessToken,
      calendarId: token.connection.showingsCalendarId,
      summary: `Showing — ${input.prospectName} — ${unit.property.name} · ${unit.name}`,
      description: [
        `Prospect: ${input.prospectName}`,
        input.prospectPhone ? `Phone: ${input.prospectPhone}` : null,
        input.prospectEmail ? `Email: ${input.prospectEmail}` : null,
        `Lead: ${getEnv().WEB_URL}/leads/${input.leadId}`,
      ].filter(Boolean).join('\n'),
      location: `${unit.property.address}, ${unit.property.city}, ${unit.property.province}`,
      startAt: startIso,
      endAt: chosen.endAt,
      timeZone: config.timeZone,
      attendeeEmails: input.prospectEmail ? [input.prospectEmail] : [],
    });

    await prisma.showing.update({
      where: { id: showingId },
      data: {
        googleEventId: event.eventId,
        googleCalendarId: token.connection.showingsCalendarId,
      },
    });

    await writeAudit({
      tenantId: input.tenantId,
      actorId: 'chatbot_agent',
      actorType: 'ai_agent',
      action: 'showing.scheduled',
      entityType: 'showing',
      entityId: showingId,
      payload: {
        leadId: input.leadId,
        unitId: input.unitId,
        scheduledAt: startIso,
        googleEventId: event.eventId,
      },
    });

    return { ok: true, showingId, scheduledAt: startIso, googleEventId: event.eventId };
  } catch (error) {
    // Compensación: un showing que no quedó bloqueado en ningún calendario
    // es exactamente la mentira que este sistema no puede contar.
    await prisma.showing.deleteMany({ where: { id: showingId } }).catch(() => undefined);
    await writeAudit({
      tenantId: input.tenantId,
      actorId: 'scheduling_service',
      actorType: 'system',
      action: 'showing.calendar_event_failed',
      entityType: 'showing',
      entityId: showingId,
      payload: {
        leadId: input.leadId,
        scheduledAt: startIso,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    });
    return { ok: false, status: 503, error: 'calendar_unavailable' };
  }
}

/** True solo si es P2002 y el índice violado incluye ese campo. */
function isUniqueViolation(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === 'string' && target.includes(field);
}
```

Agregar los imports que faltan al inicio del archivo: `import { Prisma } from '@prisma/client';` y `import { getEnv } from '../config/env.js';`.

- [ ] **Step 5: Extender `cancelShowing` y `createManualShowingFromConversation`**

En `cancelShowing`, después de la comprobación de estado y antes del `update`:

```ts
  if (showing.googleEventId && showing.googleCalendarId) {
    const token = await getUsableAccessToken(tenantId);
    if (token.ok) {
      try {
        await adapters.calendar.deleteEvent({
          accessToken: token.accessToken,
          calendarId: showing.googleCalendarId,
          eventId: showing.googleEventId,
        });
      } catch (error) {
        // Mejor esfuerzo: la cancelación en la app no se bloquea porque
        // Google no responda, pero queda registrada.
        await writeAudit({
          tenantId,
          actorId: 'scheduling_service',
          actorType: 'system',
          action: 'showing.calendar_event_delete_failed',
          entityType: 'showing',
          entityId: showingId,
          payload: { error: error instanceof Error ? error.message : 'Unknown error' },
        });
      }
    }
  }
```

Y en el `update` de estado, agregar `calendarSlotKey: null` junto a los otros dos que ya se limpian.

En `createManualShowingFromConversation`, después de crear el showing en la transacción, agregar el mismo bloque de creación de evento en Google que usa `bookShowingFromCalendar`, pero **sin** compensación destructiva: si Google falla, el showing se queda (lo agendó una persona que ya sabía que tenía el hueco libre) y se audita `showing.calendar_event_failed`. La advertencia de la UI lo hará visible.

- [ ] **Step 6: Borrar lo que ya no se usa**

Eliminar de `scheduling.service.ts`: `scheduleTour`, `getAvailableSlots`, `resolveShowingBooking`, `notifyBroker`, `AvailableSlotsResult`, y el import de `ShowMojoAdapter` / `ShowMojoSlot`.

En `apps/api/src/services/scheduling.service.test.ts`, quitar el import de `resolveShowingBooking` y el caso `'treats a repeat booking for the same unit as idempotent and blocks a different unit at that time'`, que solo ejercitaba esa función. Los otros cinco casos de ese archivo se quedan intactos.

- [ ] **Step 7: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/api test -- scheduling
pnpm -r exec tsc --noEmit
```

Esperado: las pruebas de scheduling pasan. `tsc` **va a fallar** en `chatbot.service.ts` y `leads.ts` porque todavía llaman a las funciones borradas — eso lo arregla la Tarea 9. Si `tsc` falla **solo** en esos archivos y por esa razón, seguir; cualquier otro error hay que arreglarlo aquí.

- [ ] **Step 8: Commit**

No commitear todavía: el repo no compila hasta la Tarea 9, y la restricción global 9 exige verde. **Continuar directo a la Tarea 9 y commitear al final de ella.**

---

## Task 9: Cablear el chatbot y las rutas de leads

**Files:**
- Modify: `apps/api/src/services/chatbot.service.ts`
- Modify: `apps/api/src/routes/leads.ts`
- Modify: `apps/api/src/routes/chat.ts`
- Modify: `apps/api/src/routes/webhooks.ts`
- Modify: `apps/api/src/jobs/telegram-poller.ts`
- Test: `apps/api/src/services/chatbot.routing.test.ts`

**Interfaces:**
- Consumes: `getSchedulingAvailability`, `bookShowingFromCalendar` (Tarea 8).
- Produces: `handleInboundMessage` con `deps: { glm: GlmAdapter; messaging: MessagingAdapter }` — **sin** `showmojo`.

- [ ] **Step 1: Escribir las pruebas que fallan**

En `apps/api/src/services/chatbot.routing.test.ts` ya existen los helpers `seedTenant()`, `cleanup()`, `glmReturning()` y `seedConversationWithSlots(externalId, state, slots)`. Extender `cleanup()` para que también borre `conversationEvent`, `showing`, `unit`, `property`, `calendarConnection` y `schedulingConfig` de `TENANT_ID`, y agregar:

```ts
/**
 * Deja una conversación de renta lista para que el siguiente turno entre al
 * estado `scheduling`: unidad seleccionada y lead vinculado.
 */
async function seedReadyToSchedule(externalId: string) {
  await seedTenant();
  const property = await prisma.property.create({
    data: {
      tenantId: TENANT_ID,
      name: 'Pacific Ridge',
      address: '100 Test St',
      city: 'Vancouver',
      province: 'BC',
    },
  });
  const unit = await prisma.unit.create({
    data: {
      tenantId: TENANT_ID,
      propertyId: property.id,
      name: 'Unit 101',
      rentCents: 200_000,
      slug: `unit-101-${TENANT_ID}`,
    },
  });
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, name: 'Ana', phone: externalId, status: 'contacted' },
  });
  const conversation = await seedConversationWithSlots(externalId, 'proposing_tour', {
    transaction_intent: 'rent',
    selected_unit_id: unit.id,
  });
  await prisma.chatConversation.update({
    where: { id: conversation.id },
    data: { leadId: lead.id, unitId: unit.id },
  });
  return { conversationId: conversation.id, unitId: unit.id, leadId: lead.id };
}

it('sin calendario conectado no ofrece horarios, pasa a handoff y no crea showings', async () => {
  const { conversationId } = await seedReadyToSchedule('+16045550111');
  const { glm } = glmReturning('Sure, let us book a tour.');

  const reply = await handleInboundMessage(
    { tenantId: TENANT_ID, from: '+16045550111', body: 'quiero agendar una visita', channel: 'web' },
    { glm, messaging: new WebChatMockAdapter() },
  );

  expect(reply.text.toLowerCase()).toContain('advisor');
  expect(await prisma.showing.count({ where: { tenantId: TENANT_ID } })).toBe(0);
  expect((await prisma.chatConversation.findUniqueOrThrow({ where: { id: conversationId } })).state)
    .toBe('handoff');

  const events = await prisma.conversationEvent.findMany({
    where: { tenantId: TENANT_ID, type: 'showing.availability_unavailable' },
  });
  expect(events).toHaveLength(1);
  expect((events[0]!.payload as { reason?: string }).reason).toBe('not_connected');
});

it('nunca consulta el adapter de ShowMojo para agendar', async () => {
  await seedReadyToSchedule('+16045550222');
  const { glm } = glmReturning('Sure, let us book a tour.');
  const showmojo = new ShowMojoMockAdapter();
  const spy = vi.spyOn(showmojo, 'getAvailableSlots');

  await handleInboundMessage(
    { tenantId: TENANT_ID, from: '+16045550222', body: 'quiero agendar una visita', channel: 'web' },
    { glm, messaging: new WebChatMockAdapter() },
  );

  expect(spy).not.toHaveBeenCalled();
});
```

La segunda prueba construye un `ShowMojoMockAdapter` que ya **no** se le puede pasar a `handleInboundMessage`: ese es justo el punto — el tipo ya no lo acepta y el espía confirma que nadie lo alcanza por otra vía.

El texto exacto que se espera en `reply.text` debe coincidir con el del helper `handOffScheduling` del Step 3; si se cambia uno, cambiar el otro.

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/api test -- chatbot.routing
```

Esperado: FAIL — la firma de `handleInboundMessage` todavía exige `showmojo`.

- [ ] **Step 3: Cambiar el estado `scheduling` en `chatbot.service.ts`**

Reemplazar el bloque que llama a `getAvailableSlots` por:

```ts
      const availability = await getSchedulingAvailability(input.tenantId, unitId);
      if (availability.ok) {
        await prisma.conversationSlot.upsert({
          where: { conversationId_key: { conversationId: conversation.id, key: 'pending_slots' } },
          update: { value: JSON.stringify(availability.slots) },
          create: { conversationId: conversation.id, key: 'pending_slots', value: JSON.stringify(availability.slots) },
        });
        await prisma.conversationSlot.upsert({
          where: { conversationId_key: { conversationId: conversation.id, key: 'scheduling_unit_id' } },
          update: { value: unitId },
          create: { conversationId: conversation.id, key: 'scheduling_unit_id', value: unitId },
        });

        const slotsText = availability.slots.map((slot) => `${slot.index + 1}. ${slot.label}`).join('\n');
        finalReply =
          `Perfect. These are the available tour times:\n\n`
          + `${slotsText}\n\n`
          + `Reply with the number of the option you prefer (1-${availability.slots.length}).`;
      } else {
        finalReply = await handOffScheduling(input.tenantId, conversation.id, conversation.leadId, availability.reason);
        newState = 'handoff';
      }
```

Y agregar el helper al final del archivo:

```ts
/**
 * Sin calendario disponible no se ofrecen horarios ni se crean showings: se
 * dice la verdad y se pasa a un humano. Prometer una hora que nadie tiene
 * bloqueada es peor que no agendar.
 */
async function handOffScheduling(
  tenantId: string,
  conversationId: string,
  leadId: string | null,
  reason: string,
): Promise<string> {
  await createConversationEvent({
    tenantId,
    conversationId,
    leadId: leadId ?? undefined,
    type: 'showing.availability_unavailable',
    payload: { reason },
  });
  return 'Thanks — I have your details. One of our advisors will confirm a tour time with you shortly, right here in this conversation.';
}
```

Verificar la firma real de `createConversationEvent` en `apps/api/src/services/conversation-events.service.ts` y ajustar los campos (`label`, `detail`, `tone`) a lo que exija; ese servicio ya los deriva o los pide según el tipo.

- [ ] **Step 4: Cambiar la elección de horario**

Reemplazar el bloque que llama a `scheduleTour` por:

```ts
            const booked = await bookShowingFromCalendar({
              tenantId: input.tenantId,
              unitId: schedulingUnitId,
              leadId: lead.id,
              startAt: new Date(chosen.startAt),
              prospectName: lead.name ?? lead.phone ?? 'Prospect',
              prospectPhone: lead.phone ?? undefined,
              prospectEmail: lead.email ?? undefined,
              conversationId: conversation.id,
            });

            if (booked.ok) {
              // ...el mismo bloque de slots guardados y mensaje de
              // confirmación que ya existe, usando booked.scheduledAt
              newState = 'handoff';
            } else if (
              booked.error === 'slot_taken' || booked.error === 'slot_no_longer_offered'
            ) {
              finalReply = 'That time was just taken. Let me pull up the current options.';
              newState = 'proposing_tour';
            } else {
              finalReply = await handOffScheduling(
                input.tenantId, conversation.id, conversation.leadId, booked.error,
              );
              newState = 'handoff';
            }
```

Conservar el texto de confirmación actual tal cual, cambiando `result.scheduledAt` por `booked.scheduledAt`.

- [ ] **Step 5: Quitar `showmojo` de las firmas y de los llamadores**

En `chatbot.service.ts`, quitar `showmojo: ShowMojoAdapter;` de las dos declaraciones de `deps` y borrar el import de `ShowMojoAdapter`.

Quitar `showmojo: adapters.showmojo,` de las seis llamadas en:
`apps/api/src/routes/chat.ts` (líneas ~55 y ~90), `apps/api/src/routes/webhooks.ts` (~261 y ~437), `apps/api/src/routes/leads.ts` (~631), `apps/api/src/jobs/telegram-poller.ts` (~82).

- [ ] **Step 6: Cambiar las dos rutas de `leads.ts`**

La ruta de slots del shortlist (~108) y la de la unidad (~407) pasan a:

```ts
    const availability = await getSchedulingAvailability(tenantId, unitId);
    if (!availability.ok) {
      const status = availability.reason === 'unit_not_found' ? 404 : 503;
      res.status(status).json({ error: availability.reason });
      return;
    }
    res.json({ slots: availability.slots });
```

Las dos rutas de booking (~137 y ~444) pasan a resolver el `startAt` desde el `slotIndex` recibido, llamando primero a `getSchedulingAvailability` y tomando `slots[slotIndex]`, y luego:

```ts
    const booked = await bookShowingFromCalendar({ /* ... */ });
    if (!booked.ok) {
      res.status(booked.status).json({ error: booked.error });
      return;
    }
    res.json(booked);
```

Actualizar los imports de esas rutas: `getAvailableSlots` y `scheduleTour` ya no existen.

- [ ] **Step 7: Correr toda la suite de la API**

```bash
pnpm --filter @property-manager/api test
pnpm -r exec tsc --noEmit
```

Esperado: **todo verde**, sin errores de tipos en ningún paquete. Cualquier prueba existente que fallara porque simulaba `showmojo` para agendar hay que reescribirla contra el camino nuevo, no borrarla sin más.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src
git commit -m "feat: agendar contra el calendario real y retirar ShowMojo del flujo"
```

---

## Task 10: Rutas de integración

**Files:**
- Create: `apps/api/src/routes/integrations.google-calendar.ts`
- Create: `apps/api/src/routes/integrations.google-calendar.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: todo lo de las Tareas 6 y 7.
- Produces: `export const googleCalendarRouter: Router`, montado en `/integrations/google-calendar`, y `export async function completeGoogleCalendarConnection(input: { code: string; state: string }): Promise<{ ok: true; accountEmail: string } | { ok: false; reason: string }>`.

**Cómo se prueban las rutas en este repo:** no hay `supertest`. El patrón, que se ve en `apps/api/src/routes/webhooks.messenger.test.ts` y `webhooks.twilio.test.ts`, es sacar la lógica del handler a una función exportada del mismo módulo de rutas y probar **esa** función, dejando el handler como un mapeo delgado a status y redirecciones. Por eso el callback vive en `completeGoogleCalendarConnection` y no dentro del `router.get`.

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `apps/api/src/routes/integrations.google-calendar.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';
import { signOAuthState } from '../services/calendar-connection.service.js';
import { completeGoogleCalendarConnection } from './integrations.google-calendar.js';

const TENANT_ID = 'tenant_test_google_calendar_routes';
const USER_ID = 'user_test_google_calendar_routes';

async function cleanup() {
  await prisma.calendarConnection.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.schedulingConfig.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.tenant.create({
    data: { id: TENANT_ID, name: 'Google Calendar Routes Test', province: 'BC' },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
});

describe('completeGoogleCalendarConnection', () => {
  it('rechaza un state manipulado y no guarda nada', async () => {
    const result = await completeGoogleCalendarConnection({ code: 'x', state: 'basura' });
    expect(result).toEqual({ ok: false, reason: 'invalid_state_malformed' });
    expect(await prisma.calendarConnection.count({ where: { tenantId: TENANT_ID } })).toBe(0);
  });

  it('rechaza un state con firma alterada', async () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: USER_ID });
    const tampered = `${state.split('.')[0]}.deadbeef`;
    const result = await completeGoogleCalendarConnection({ code: 'x', state: tampered });
    expect(result).toEqual({ ok: false, reason: 'invalid_state_bad_signature' });
    expect(await prisma.calendarConnection.count({ where: { tenantId: TENANT_ID } })).toBe(0);
  });

  it('rechaza un state expirado', async () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: USER_ID });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
    const result = await completeGoogleCalendarConnection({ code: 'x', state });
    expect(result).toEqual({ ok: false, reason: 'invalid_state_expired' });
    expect(await prisma.calendarConnection.count({ where: { tenantId: TENANT_ID } })).toBe(0);
  });

  it('rechaza cuando falta el código', async () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: USER_ID });
    expect(await completeGoogleCalendarConnection({ code: '', state }))
      .toEqual({ ok: false, reason: 'missing_code' });
  });

  it('guarda la conexión con un state válido', async () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: USER_ID });
    const result = await completeGoogleCalendarConnection({ code: 'ok', state });

    expect(result).toEqual({ ok: true, accountEmail: 'calendar-mock@example.com' });
    const row = await prisma.calendarConnection.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
    expect(row.accountEmail).toBe('calendar-mock@example.com');
    expect(row.showingsCalendarId).toBe('mock_showings_calendar');
    expect(row.ownerKey).toBe('tenant');
  });

  it('no guarda nada si Google rechaza el canje', async () => {
    const state = signOAuthState({ tenantId: TENANT_ID, userId: USER_ID });
    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().calendar, 'exchangeAuthorizationCode')
      .mockRejectedValue(new Error('invalid_grant'));

    expect(await completeGoogleCalendarConnection({ code: 'malo', state }))
      .toEqual({ ok: false, reason: 'exchange_failed' });
    expect(await prisma.calendarConnection.count({ where: { tenantId: TENANT_ID } })).toBe(0);
  });
});
```

Los guardias de rol (`requireAuth`, `requireRole('property_manager')`) son el middleware que ya usan `audit.ts` y `bills.ts` y que ya está probado ahí; no se vuelve a probar aquí.

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/api test -- integrations.google-calendar
```

Esperado: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar el router**

Crear `apps/api/src/routes/integrations.google-calendar.ts`:

```ts
/**
 * Conexión de la agencia con Google Calendar.
 *
 * El callback es la ÚNICA ruta pública del router: Google redirige el
 * navegador ahí sin garantía de que lleve nuestra cookie de sesión. Su
 * autenticación es el `state` firmado, no la sesión.
 */
import { Router } from 'express';
import { requireAuth, requireRole, requireUser } from '../auth/context.js';
import { getEnv } from '../config/env.js';
import {
  disconnectCalendar,
  getCalendarConnectionStatus,
  resolveRedirectUri,
  saveCalendarConnection,
  signOAuthState,
  verifyOAuthState,
} from '../services/calendar-connection.service.js';
import {
  getSchedulingConfig,
  updateSchedulingConfig,
} from '../services/scheduling-config.service.js';

export const googleCalendarRouter = Router();

googleCalendarRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const [status, config] = await Promise.all([
      getCalendarConnectionStatus(user.tenantId),
      getSchedulingConfig(user.tenantId),
    ]);
    res.json({ ...status, config });
  } catch (err) {
    next(err);
  }
});

googleCalendarRouter.post(
  '/authorize',
  requireAuth,
  requireRole('property_manager'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { getAdapters } = await import('../config/adapters.js');
      const authorizeUrl = getAdapters().calendar.buildAuthorizeUrl({
        redirectUri: resolveRedirectUri(),
        state: signOAuthState({ tenantId: user.tenantId, userId: user.id }),
      });
      res.json({ authorizeUrl });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * La lógica del callback vive fuera del handler para poder probarla directo,
 * como `claimAndPrepareMessengerMessage` en routes/webhooks.ts. El handler
 * queda como un mapeo a redirecciones.
 */
export type CompleteConnectionResult =
  | { ok: true; accountEmail: string }
  | { ok: false; reason: string };

export async function completeGoogleCalendarConnection(input: {
  code: string;
  state: string;
}): Promise<CompleteConnectionResult> {
  if (!input.code) return { ok: false, reason: 'missing_code' };

  const verified = verifyOAuthState(input.state);
  if (!verified.ok) return { ok: false, reason: `invalid_state_${verified.reason}` };

  try {
    const { getAdapters } = await import('../config/adapters.js');
    const calendar = getAdapters().calendar;
    const tokens = await calendar.exchangeAuthorizationCode({
      code: input.code,
      redirectUri: resolveRedirectUri(),
    });
    const config = await getSchedulingConfig(verified.tenantId);
    const { calendarId } = await calendar.ensureShowingsCalendar({
      accessToken: tokens.accessToken,
      timeZone: config.timeZone,
    });

    await saveCalendarConnection({
      tenantId: verified.tenantId,
      accountEmail: tokens.accountEmail,
      showingsCalendarId: calendarId,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      expiresInSeconds: tokens.expiresInSeconds,
    });

    return { ok: true, accountEmail: tokens.accountEmail };
  } catch {
    // No se propaga: un 500 en el navegador del manager no le dice nada.
    // Se le regresa a la app con el motivo.
    return { ok: false, reason: 'exchange_failed' };
  }
}

googleCalendarRouter.get('/callback', async (req, res) => {
  const webUrl = getEnv().WEB_URL;
  const result = await completeGoogleCalendarConnection({
    code: typeof req.query.code === 'string' ? req.query.code : '',
    state: typeof req.query.state === 'string' ? req.query.state : '',
  });
  res.redirect(result.ok
    ? `${webUrl}/showings?calendar=connected`
    : `${webUrl}/showings?calendar=error&reason=${encodeURIComponent(result.reason)}`);
});

googleCalendarRouter.delete(
  '/',
  requireAuth,
  requireRole('property_manager'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      await disconnectCalendar(user.tenantId);
      res.json({ connected: false });
    } catch (err) {
      next(err);
    }
  },
);

googleCalendarRouter.put(
  '/config',
  requireAuth,
  requireRole('property_manager'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const result = await updateSchedulingConfig(user.tenantId, req.body);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ config: result.config });
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 4: Montar el router**

En `apps/api/src/app.ts`, importar `googleCalendarRouter` y montarlo junto a los demás:

```ts
  app.use('/integrations/google-calendar', googleCalendarRouter);
```

- [ ] **Step 5: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/api test
pnpm -r exec tsc --noEmit
```

Esperado: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/integrations.google-calendar.ts apps/api/src/routes/integrations.google-calendar.test.ts apps/api/src/app.ts
git commit -m "feat: rutas OAuth y de configuración de calendario"
```

---

## Task 11: Interfaz, documentación y regresión

**Files:**
- Create: `apps/web/src/components/CalendarSettingsCard.tsx`
- Modify: `apps/web/src/pages/ShowingsPage.tsx`
- Modify: `apps/web/src/lib/types.ts`
- Create: `docs/GOOGLE_CALENDAR_SETUP.md`
- Modify: `docs/PRODUCT_ROADMAP.md`

**Interfaces:**
- Consumes: las rutas de la Tarea 10 (`GET /`, `POST /authorize`, `DELETE /`, `PUT /config`), que desde el navegador se piden como `/api/integrations/google-calendar/...` porque el proxy de Vite antepone `/api`.
- Produces: nada que consuma otra tarea.

- [ ] **Step 1: Agregar los tipos**

En `apps/web/src/lib/types.ts`:

```ts
export interface SchedulingConfig {
  weeklyHours: Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun',
    Array<{ from: string; to: string }>>;
  timeZone: string;
  showingDurationMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxAdvanceDays: number;
  slotGranularityMinutes: number;
}

export interface CalendarConnectionStatus {
  connected: boolean;
  accountEmail?: string;
  status?: 'active' | 'revoked';
  lastError?: string | null;
  lastErrorAt?: string | null;
  config: SchedulingConfig;
}
```

Y agregar `googleEventId?: string | null` al tipo de `Showing` que ya exista ahí, para poder mostrar la advertencia.

- [ ] **Step 2: Escribir la tarjeta**

Crear `apps/web/src/components/CalendarSettingsCard.tsx`. El cableado de datos, que es la parte que se puede hacer mal en silencio, va exactamente así:

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';
import type { CalendarConnectionStatus, SchedulingConfig } from '../lib/types';

interface Props {
  /** Solo property_manager puede conectar, desconectar y guardar. */
  canManage: boolean;
}

export function CalendarSettingsCard({ canManage }: Props) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SchedulingConfig | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const connection = useQuery<CalendarConnectionStatus>({
    queryKey: ['calendar-connection'],
    queryFn: () => apiFetch('/integrations/google-calendar'),
  });

  const authorize = useMutation({
    mutationFn: () => apiFetch<{ authorizeUrl: string }>(
      '/integrations/google-calendar/authorize',
      { method: 'POST' },
    ),
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
  });

  const disconnect = useMutation({
    mutationFn: () => apiFetch('/integrations/google-calendar', { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['calendar-connection'] }),
  });

  const saveConfig = useMutation({
    mutationFn: (config: SchedulingConfig) => apiFetch(
      '/integrations/google-calendar/config',
      { method: 'PUT', body: JSON.stringify(config) },
    ),
    onSuccess: () => {
      setSaveError(null);
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ['calendar-connection'] });
    },
    // El 400 del servidor trae el detalle de qué regla se rompió: se muestra
    // tal cual en vez de un "algo salió mal".
    onError: (error) => setSaveError(error instanceof Error ? error.message : 'No se pudo guardar'),
  });

  // ...render
}
```

El resto del render, con las convenciones de tarjetas, colores y `role="alert"` de `apps/web/src/pages/OwnerStatementsPage.tsx` (leerlo antes de escribir):

- **Sin conectar:** título "Agenda y calendario", una línea explicando que sin calendario conectado el asistente no agenda solo, y el botón *Conectar Google Calendar* que dispara `authorize.mutate()`.
- **Conectada:** muestra `connection.data.accountEmail`, un botón *Desconectar* que pide `window.confirm` antes de `disconnect.mutate()`, y el editor.
- **Revocada** (`status === 'revoked'`): franja de advertencia con el texto de `lastError` y el botón de reconectar, que dispara el mismo `authorize.mutate()`.
- **Editor:** los siete días, cada uno con sus rangos (`from`/`to` como `<input type="time">`), botones de agregar y quitar rango, selector de duración (15/30/45/60), campos numéricos de colchón, aviso mínimo y ventana, y selector de granularidad (15/30/60). Edita sobre `draft ?? connection.data.config` y guarda con `saveConfig.mutate(draft)`.
- Todos los controles de escritura llevan `disabled={!canManage}`; con `canManage` en falso la configuración se ve pero no se toca.

- [ ] **Step 3: Insertarla en la página y mostrar la advertencia**

En `apps/web/src/pages/ShowingsPage.tsx`:

- Obtener el rol con `const { user } = useAuth();` de `../auth/AuthContext` — el mismo patrón de `AuditPage.tsx` — y renderizar arriba de la tabla:

  ```tsx
  <CalendarSettingsCard canManage={user?.role === 'property_manager'} />
  ```
- Al montar, leer `?calendar=` de la URL con `useSearchParams`: `connected` muestra un aviso de éxito, `error` muestra el `reason`. Limpiar el parámetro después de mostrarlo para que no reaparezca al recargar.
- En cada fila con `status === 'scheduled'` y `googleEventId` nulo, mostrar una insignia de advertencia con el texto **"sin bloquear en calendario"**.

- [ ] **Step 4: Verificar que la web compila y sus pruebas pasan**

```bash
pnpm --filter @property-manager/web test
pnpm -r exec tsc --noEmit
```

- [ ] **Step 5: Escribir la guía de setup**

Crear `docs/GOOGLE_CALENDAR_SETUP.md` con el mismo tono y estructura de `docs/MESSENGER_SETUP.md`. Debe cubrir, en pasos numerados:

1. Crear el proyecto en Google Cloud Console.
2. Habilitar la **Google Calendar API**.
3. Configurar la pantalla de consentimiento OAuth con exactamente estos scopes:
   `https://www.googleapis.com/auth/calendar.freebusy`,
   `https://www.googleapis.com/auth/calendar.app.created`, `openid`, `email`.
4. Crear credenciales OAuth de tipo *Aplicación web*.
5. Registrar la URI de redirección — la de la **API**, sin `/api`:
   `https://<host-de-la-api>/integrations/google-calendar/callback`, y en local
   `http://localhost:4000/integrations/google-calendar/callback`. Debe coincidir
   carácter por carácter con la que manda la app o Google rechaza el canje.
6. Pegar `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y, si aplica,
   `GOOGLE_OAUTH_REDIRECT_URI` en `apps/api/.env`.
7. Conectar desde la app en Showings → Agenda y calendario.

Con una advertencia destacada: **mientras la app esté en modo *Testing* en la
pantalla de consentimiento, Google caduca los refresh tokens a los 7 días** y el
calendario se desconectará solo cada semana. Hay que publicar la app a
producción para que dejen de caducar.

Y una nota de qué NO puede ver la app: con esos scopes solo se ven bloques de
ocupado, nunca títulos, invitados ni descripciones de los eventos personales.

- [ ] **Step 6: Actualizar el roadmap**

En `docs/PRODUCT_ROADMAP.md`, sección 1.3, marcar como entregado con una nota
corta de qué quedó fuera (calendario por broker, sync de dos vías), igual que se
hizo con las fases anteriores.

- [ ] **Step 7: Regresión completa**

```bash
pnpm -r exec tsc --noEmit
pnpm -r run test
```

Esperado: **todo verde** en los cuatro paquetes. Si algo falla, no commitear: reportar.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src docs
git commit -m "feat: pantalla de conexión de calendario y guía de setup"
```

---

## Notas para quien ejecute el plan

- **Las Tareas 8 y 9 son una unidad de compilación y se ejecutan como UNA sola tarea.** La 8 borra funciones que la 9 reemplaza en sus llamadores; entre las dos el repo no compila, así que la 8 no puede commitear ni ser revisada por separado. Quien ejecute el plan despacha ambas juntas a un mismo implementador y las revisa como un solo bloque.
- **El adapter de calendario se obtiene con `await import('../config/adapters.js')`** dentro de la función, no con un import estático arriba del archivo. Es el patrón que ya usan `confirmShowing` y `cancelShowing`, y es lo que permite que las pruebas espíen el adapter con `vi.spyOn`.
- **Cualquier prueba existente que se rompa hay que arreglarla, no borrarla**, salvo las que solo existían para ejercitar `scheduleTour` / `getAvailableSlots` contra el mock de ShowMojo, que se van con esas funciones.
- **`getAdapters()` cachea un único set de adapters por proceso.** Eso es lo que permite espiarlos con `vi.spyOn`, y también lo que obliga a llamar `reset()` en el mock de calendario en cada `beforeEach`: si no, los eventos de una prueba se reportan como ocupados en la siguiente.
- **Si una prueba no pasa, se reporta BLOCKED.** No se commitea en rojo ni se marca una tarea como completa con una prueba fallando.
