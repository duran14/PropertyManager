# Fase 3: Trust Accounting & Owner Statements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El PM puede vincular un dueño a cada propiedad, ver el desglose mensual calculado desde los movimientos que ya existen, y cerrar el mes emitiendo un estado de cuenta inmutable.

**Architecture:** El cálculo vive como funciones **puras** en `packages/core` (junto a `reconciliation.ts` y `confidence.ts`, el patrón ya establecido): sin I/O, testeables al centavo sin base de datos. `apps/api` solo junta los datos, llama al cálculo, y persiste. Nada de tabla `property_ledger`: el estado de cuenta se deriva de `Transaction`/`Bill`.

**Tech Stack:** Node.js/Express/TypeScript, Prisma, Vitest, React + Vite + TanStack Query.

Spec de referencia: [`docs/superpowers/specs/2026-08-08-fase-3-owner-statements-design.md`](../specs/2026-08-08-fase-3-owner-statements-design.md).

## Global Constraints

- **Dinero SIEMPRE en centavos enteros.** Nunca `Decimal`, `NUMERIC` ni `Float` para montos. Es la regla escrita en el encabezado de `schema.prisma`.
- **La comisión va en basis points enteros** (`managementFeePercentBps`, 1250 = 12.5%), no como decimal.
- **El pago al dueño se calcula por RESTA, no por otro redondeo.** La invariante `ingresos − gastos − comisión − reserva === pago − faltante` debe cumplirse al centavo por construcción.
- **`ownerPayoutCents` y `shortfallCents` son ambos no negativos**; en cualquier mes exactamente uno es cero.
- **ADR-005 (nunca custodio de fondos):** ningún endpoint transfiere dinero, no hay saldo de subcuenta persistido. Solo se registra la instrucción de pago.
- **El periodo es semiabierto `[periodStart, periodEnd)`**, con `periodEnd` = primer instante del mes siguiente. Nunca `<=`.
- **Zona horaria `America/Vancouver`** para los límites del mes. Sin agregar dependencias: se usa `Intl.DateTimeFormat`, que Node trae de fábrica.
- **Ingresos por `Transaction.occurredAt`; gastos por `Bill.billDate`.** No por `createdAt`.
- **Solo cuentan Bills con status `approved` o `synced_to_qbo`.**
- Los errores esperados se devuelven como **resultado discriminado** (`{ ok: false, status, error }`), nunca se lanzan: el error handler global de `app.ts` convierte todo `throw` en 500.
- Tests: Prisma real contra la DB de test + adapters mock/spy inyectados. Nunca `vi.mock` de Prisma.
- Comentarios en español, solo donde el porqué no sea obvio.
- Cada tarea deja el repo verde: `tsc --noEmit` limpio y la suite completa de `apps/api` **y** `packages/core` pasando.

---

### Task 1: Schema — dueño, configuración de propiedad, y `OwnerStatement`

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: migración de Prisma (generada en el Step 2)

**Interfaces:**
- Produces: `Property.ownerId/managementFeePercentBps/reserveFundTargetCents`, `Bill.propertyId`, y el modelo `OwnerStatement`. Consumidos por las Tasks 4-7.

- [ ] **Step 1: Editar el schema**

En `model Property`, agregar los tres campos y la relación (después de `postalCode`):

```prisma
  // Fase 3: configuración contable de la propiedad.
  ownerId                 String?
  // Comisión en basis points enteros (1250 = 12.5%): el schema prohíbe
  // float para dinero, y bps mantiene el porcentaje exacto.
  managementFeePercentBps Int      @default(1250)
  reserveFundTargetCents  Int      @default(0)
```

y en su bloque de relaciones, junto a `units Unit[]`:

```prisma
  owner      Owner?           @relation(fields: [ownerId], references: [id])
  statements OwnerStatement[]
  bills      Bill[]
```

En `model Owner`, agregar en su bloque de relaciones (junto a `tenant Tenant @relation(...)`):

```prisma
  properties Property[]
  statements OwnerStatement[]
```

En `model Bill`, agregar el campo (después de `unitId String?`):

```prisma
  propertyId        String?
```

y en su bloque de relaciones (junto a `approvalRequest ApprovalRequest? @relation(...)`):

```prisma
  property        Property?        @relation(fields: [propertyId], references: [id])
```

En `model Tenant`, agregar en su lista de relaciones (junto a `shortlists PropertyShortlist[]`):

```prisma
  ownerStatements       OwnerStatement[]
```

Y agregar el modelo nuevo al final del archivo:

```prisma
model OwnerStatement {
  id         String @id @default(cuid())
  tenantId   String
  propertyId String
  ownerId    String

  // Intervalo semiabierto [periodStart, periodEnd): periodEnd es el primer
  // instante del mes SIGUIENTE, calculado en America/Vancouver.
  periodStart DateTime
  periodEnd   DateTime

  rentIncomeCents      Int
  expensesCents        Int
  managementFeeCents   Int
  reserveWithheldCents Int
  ownerPayoutCents     Int
  shortfallCents       Int

  // Copia de la configuración vigente al cerrar: si mañana cambia la
  // comisión de la propiedad, este documento histórico no debe cambiar.
  appliedFeePercentBps Int
  reserveTargetCents   Int

  closedByUserId String
  closedAt       DateTime @default(now())
  createdAt      DateTime @default(now())

  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  property Property @relation(fields: [propertyId], references: [id], onDelete: Cascade)
  owner    Owner    @relation(fields: [ownerId], references: [id])

  // Sin campo `status`: si la fila existe, el mes está cerrado. Esta unique
  // hace imposible cerrar dos veces el mismo mes incluso ante dos
  // peticiones concurrentes.
  @@unique([propertyId, periodStart])
  @@index([tenantId, periodStart])
  @@map("owner_statements")
}
```

- [ ] **Step 2: Generar y aplicar la migración**

Con Postgres corriendo:

Run: `pnpm --filter @property-manager/api exec prisma migrate dev --name add_owner_statements`
Expected: crea `apps/api/prisma/migrations/<timestamp>_add_owner_statements/migration.sql` sin errores.

Si `migrate dev` se rehúsa por no ser un shell interactivo (ya pasó en este repo): genera el SQL con `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --shadow-database-url "postgresql://pm_dev:pm_dev_password@127.0.0.1:5433/property_manager_shadow?schema=public"`, escríbelo a mano en `apps/api/prisma/migrations/<timestamp>_add_owner_statements/migration.sql`, y aplícalo con `prisma migrate deploy`.

**NUNCA uses `$DATABASE_URL` como `--shadow-database-url`**: Prisma dropea y recrea la base que recibe como shadow. La base `property_manager_shadow` ya existe justo para esto.

- [ ] **Step 3: Verificar**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — toda la suite existente (los campos nuevos son opcionales o con default).

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat: add owner link, property accounting config, and OwnerStatement"
```

---

### Task 2: Límites del mes en `America/Vancouver`

**Files:**
- Create: `packages/core/src/period.ts`
- Create: `packages/core/src/period.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: desde `packages/core/src/period.ts` (re-exportado por `@property-manager/core`):
  - `export function parseStatementPeriod(period: string): { year: number; month: number } | null`
  - `export function monthBoundsUtc(year: number, month: number, timeZone?: string): { periodStart: Date; periodEnd: Date }`

  Consumidos por las Tasks 4-6.

- [ ] **Step 1: Escribir el test (el módulo aún no existe)**

Crear `packages/core/src/period.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { monthBoundsUtc, parseStatementPeriod } from './period.js';

describe('parseStatementPeriod', () => {
  it('parses a valid YYYY-MM string', () => {
    expect(parseStatementPeriod('2026-08')).toEqual({ year: 2026, month: 8 });
    expect(parseStatementPeriod('2026-01')).toEqual({ year: 2026, month: 1 });
    expect(parseStatementPeriod('2026-12')).toEqual({ year: 2026, month: 12 });
  });

  it.each([
    ['2026-13'],
    ['2026-00'],
    ['2026-8'],
    ['26-08'],
    ['2026/08'],
    ['not-a-period'],
    [''],
  ])('rejects the invalid period %s', (value) => {
    expect(parseStatementPeriod(value)).toBeNull();
  });
});

describe('monthBoundsUtc', () => {
  it('anchors the month to midnight in Vancouver, not UTC', () => {
    // Agosto 2026: Vancouver está en PDT (UTC-7), así que la medianoche
    // local del 1 de agosto son las 07:00 UTC del mismo día.
    const { periodStart } = monthBoundsUtc(2026, 8);
    expect(periodStart.toISOString()).toBe('2026-08-01T07:00:00.000Z');
  });

  it('uses the first instant of the next month as an exclusive end', () => {
    const { periodEnd } = monthBoundsUtc(2026, 8);
    expect(periodEnd.toISOString()).toBe('2026-09-01T07:00:00.000Z');
  });

  it('rolls over the year for December', () => {
    const { periodStart, periodEnd } = monthBoundsUtc(2026, 12);
    // Diciembre: Vancouver en PST (UTC-8) → 08:00 UTC.
    expect(periodStart.toISOString()).toBe('2026-12-01T08:00:00.000Z');
    expect(periodEnd.toISOString()).toBe('2027-01-01T08:00:00.000Z');
  });

  it('handles a month whose start and end fall on different DST offsets', () => {
    // Octubre 2026 empieza en PDT (UTC-7) y noviembre empieza en PST
    // (UTC-8), porque el horario de verano termina el 1 de noviembre a
    // las 2am. Cada límite debe usar SU propio offset, no uno compartido.
    const { periodStart, periodEnd } = monthBoundsUtc(2026, 10);
    expect(periodStart.toISOString()).toBe('2026-10-01T07:00:00.000Z');
    expect(periodEnd.toISOString()).toBe('2026-11-01T07:00:00.000Z');
  });

  it('produces a start strictly before the end for every month of a year', () => {
    for (let month = 1; month <= 12; month++) {
      const { periodStart, periodEnd } = monthBoundsUtc(2026, month);
      expect(periodStart.getTime()).toBeLessThan(periodEnd.getTime());
    }
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/core exec vitest run src/period.test.ts`
Expected: FAIL — `Cannot find module './period.js'`

- [ ] **Step 3: Implementar**

Crear `packages/core/src/period.ts`:

```typescript
/**
 * Límites de un mes contable, anclados a la zona del negocio.
 *
 * Importa la zona: un pago del 31 de julio a las 8pm en Vancouver ya es
 * 1 de agosto en UTC. Calcular los límites en UTC lo pondría en el mes
 * equivocado del estado de cuenta.
 *
 * No se agrega ninguna dependencia: `Intl.DateTimeFormat` con `timeZone`
 * viene en Node y resuelve el horario de verano correctamente.
 */

export const BUSINESS_TIME_ZONE = 'America/Vancouver';

const PERIOD_PATTERN = /^(\d{4})-(\d{2})$/;

/** Parsea "YYYY-MM". Devuelve null si el formato o el mes son inválidos. */
export function parseStatementPeriod(period: string): { year: number; month: number } | null {
  const match = PERIOD_PATTERN.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * Devuelve el intervalo semiabierto [periodStart, periodEnd) del mes dado,
 * como instantes UTC. `periodEnd` es el primer instante del mes SIGUIENTE.
 */
export function monthBoundsUtc(
  year: number,
  month: number,
  timeZone: string = BUSINESS_TIME_ZONE,
): { periodStart: Date; periodEnd: Date } {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    periodStart: zonedMonthStart(year, month, timeZone),
    periodEnd: zonedMonthStart(nextYear, nextMonth, timeZone),
  };
}

/** Instante UTC que corresponde a la medianoche del día 1 en esa zona. */
function zonedMonthStart(year: number, month: number, timeZone: string): Date {
  // Se parte de la medianoche UTC y se corrige por el offset vigente EN
  // ESE instante, así cada límite usa su propio offset de horario de
  // verano en vez de uno compartido para todo el mes.
  const guess = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  const offsetMs = timeZoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess + offsetMs);
}

/** Cuántos ms va UTC por delante de la zona en ese instante. */
function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // Intl puede devolver "24" para medianoche en algunas plataformas.
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return date.getTime() - asUtc;
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm --filter @property-manager/core exec vitest run src/period.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Exportar desde el paquete**

En `packages/core/src/index.ts`, agregar junto a las demás líneas:

```typescript
export * from './period.js';
```

- [ ] **Step 6: Verificar el paquete completo**

Run: `pnpm --filter @property-manager/core exec vitest run && pnpm --filter @property-manager/core exec tsc --noEmit`
Expected: PASS, sin errores.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/period.ts packages/core/src/period.test.ts packages/core/src/index.ts
git commit -m "feat: add Vancouver-anchored month boundaries for statement periods"
```

---

### Task 3: El motor de cálculo (función pura)

**Files:**
- Create: `packages/core/src/owner-statement.ts`
- Create: `packages/core/src/owner-statement.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: desde `packages/core/src/owner-statement.ts`:
  ```typescript
  export interface OwnerStatementInput {
    rentIncomeCents: number;
    expensesCents: number;
    managementFeePercentBps: number;
    reserveFundTargetCents: number;
    reserveAlreadyWithheldCents: number;
  }
  export interface OwnerStatementBreakdown {
    rentIncomeCents: number;
    expensesCents: number;
    managementFeeCents: number;
    reserveWithheldCents: number;
    ownerPayoutCents: number;
    shortfallCents: number;
  }
  export function calculateOwnerStatement(input: OwnerStatementInput): OwnerStatementBreakdown
  ```
  Consumido por las Tasks 4-5.

- [ ] **Step 1: Escribir el test (el módulo aún no existe)**

Crear `packages/core/src/owner-statement.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { calculateOwnerStatement, type OwnerStatementInput } from './owner-statement.js';

function input(overrides: Partial<OwnerStatementInput> = {}): OwnerStatementInput {
  return {
    rentIncomeCents: 0,
    expensesCents: 0,
    managementFeePercentBps: 1250,
    reserveFundTargetCents: 0,
    reserveAlreadyWithheldCents: 0,
    ...overrides,
  };
}

describe('calculateOwnerStatement', () => {
  it('computes a straightforward month', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 200_000,
      expensesCents: 30_000,
    }));

    expect(result.managementFeeCents).toBe(25_000); // 12.5% de 2000.00
    expect(result.reserveWithheldCents).toBe(0);
    expect(result.ownerPayoutCents).toBe(145_000);
    expect(result.shortfallCents).toBe(0);
  });

  it('rounds a fee that lands on half a cent', () => {
    // 1000.05 × 12.5% = 125.00625 → 12500.625 centavos → 12501
    const result = calculateOwnerStatement(input({ rentIncomeCents: 100_005 }));
    expect(result.managementFeeCents).toBe(12_501);
  });

  it('withholds only up to the reserve target', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 200_000,
      reserveFundTargetCents: 50_000,
      reserveAlreadyWithheldCents: 0,
    }));

    expect(result.reserveWithheldCents).toBe(50_000);
  });

  it('withholds nothing once the reserve target is already met', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 200_000,
      reserveFundTargetCents: 50_000,
      reserveAlreadyWithheldCents: 50_000,
    }));

    expect(result.reserveWithheldCents).toBe(0);
    expect(result.ownerPayoutCents).toBe(175_000);
  });

  it('tops the reserve back up after it was partially spent', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 200_000,
      reserveFundTargetCents: 50_000,
      reserveAlreadyWithheldCents: 20_000,
    }));

    expect(result.reserveWithheldCents).toBe(30_000);
  });

  it('never withholds more reserve than is available', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 100_000,
      expensesCents: 80_000,
      reserveFundTargetCents: 500_000,
    }));

    // Disponible = 100000 - 80000 - 12500 = 7500
    expect(result.reserveWithheldCents).toBe(7_500);
    expect(result.ownerPayoutCents).toBe(0);
    expect(result.shortfallCents).toBe(0);
  });

  it('reports a shortfall instead of a negative payout', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 100_000,
      expensesCents: 150_000,
    }));

    expect(result.ownerPayoutCents).toBe(0);
    expect(result.shortfallCents).toBe(62_500); // 150000 - 100000 + 12500
    expect(result.reserveWithheldCents).toBe(0);
  });

  it('handles a month with no activity at all', () => {
    const result = calculateOwnerStatement(input());

    expect(result).toEqual({
      rentIncomeCents: 0,
      expensesCents: 0,
      managementFeeCents: 0,
      reserveWithheldCents: 0,
      ownerPayoutCents: 0,
      shortfallCents: 0,
    });
  });

  it('charges no fee when the property has a 0% management fee', () => {
    const result = calculateOwnerStatement(input({
      rentIncomeCents: 200_000,
      managementFeePercentBps: 0,
    }));

    expect(result.managementFeeCents).toBe(0);
    expect(result.ownerPayoutCents).toBe(200_000);
  });

  it.each([
    [200_000, 30_000, 1250, 0, 0],
    [100_005, 33_333, 1250, 50_000, 10_000],
    [100_000, 150_000, 1250, 0, 0],
    [1, 0, 1250, 0, 0],
    [999_999, 1, 875, 100_000, 99_999],
    [0, 5_000, 1250, 20_000, 0],
    [123_457, 65_432, 1000, 33_333, 11_111],
  ])(
    'keeps the parts summing exactly for (%i, %i, %i, %i, %i)',
    (rentIncomeCents, expensesCents, managementFeePercentBps, reserveFundTargetCents, reserveAlreadyWithheldCents) => {
      const r = calculateOwnerStatement({
        rentIncomeCents,
        expensesCents,
        managementFeePercentBps,
        reserveFundTargetCents,
        reserveAlreadyWithheldCents,
      });

      // La invariante central: nada se pierde ni se inventa al redondear.
      expect(
        r.rentIncomeCents - r.expensesCents - r.managementFeeCents - r.reserveWithheldCents,
      ).toBe(r.ownerPayoutCents - r.shortfallCents);

      // Ambos lados del neto son no negativos y al menos uno es cero.
      expect(r.ownerPayoutCents).toBeGreaterThanOrEqual(0);
      expect(r.shortfallCents).toBeGreaterThanOrEqual(0);
      expect(Math.min(r.ownerPayoutCents, r.shortfallCents)).toBe(0);
      expect(r.reserveWithheldCents).toBeGreaterThanOrEqual(0);
    },
  );
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/core exec vitest run src/owner-statement.test.ts`
Expected: FAIL — `Cannot find module './owner-statement.js'`

- [ ] **Step 3: Implementar**

Crear `packages/core/src/owner-statement.ts`:

```typescript
/**
 * Cálculo del estado de cuenta mensual del dueño.
 *
 * Función pura: recibe los totales ya agregados y la configuración de la
 * propiedad, devuelve el desglose. No consulta nada — así se puede probar
 * al centavo sin base de datos.
 *
 * ADR-005: esto NO mueve dinero. Produce los montos de un documento; el
 * pago lo ejecuta un humano fuera del sistema.
 */

const BPS_DENOMINATOR = 10_000;

export interface OwnerStatementInput {
  rentIncomeCents: number;
  expensesCents: number;
  /** Comisión en basis points enteros (1250 = 12.5%). */
  managementFeePercentBps: number;
  reserveFundTargetCents: number;
  /** Suma de lo ya retenido en los estados de cuenta cerrados previos. */
  reserveAlreadyWithheldCents: number;
}

export interface OwnerStatementBreakdown {
  rentIncomeCents: number;
  expensesCents: number;
  managementFeeCents: number;
  reserveWithheldCents: number;
  /** No negativo. Cero cuando el mes cerró en rojo. */
  ownerPayoutCents: number;
  /** No negativo. Cero salvo que el mes cerrara en rojo. */
  shortfallCents: number;
}

export function calculateOwnerStatement(input: OwnerStatementInput): OwnerStatementBreakdown {
  const managementFeeCents = Math.round(
    (input.rentIncomeCents * input.managementFeePercentBps) / BPS_DENOMINATOR,
  );

  const available = input.rentIncomeCents - input.expensesCents - managementFeeCents;

  const reserveGap = Math.max(0, input.reserveFundTargetCents - input.reserveAlreadyWithheldCents);
  const reserveWithheldCents = Math.max(0, Math.min(reserveGap, available));

  // El neto se obtiene por RESTA, no por otro redondeo: así la suma de las
  // partes es exacta al centavo por construcción, que es justo el objetivo
  // de "liquidación exacta en $0.00".
  const net = available - reserveWithheldCents;

  return {
    rentIncomeCents: input.rentIncomeCents,
    expensesCents: input.expensesCents,
    managementFeeCents,
    reserveWithheldCents,
    // Se parte en dos campos no negativos: un monto negativo en el pago
    // sería un cobro al dueño, que es otra cosa y merece su propio campo.
    ownerPayoutCents: Math.max(0, net),
    shortfallCents: Math.max(0, -net),
  };
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm --filter @property-manager/core exec vitest run src/owner-statement.test.ts`
Expected: PASS (16 tests, contando los 7 casos del `it.each`).

- [ ] **Step 5: Exportar desde el paquete**

En `packages/core/src/index.ts`, agregar:

```typescript
export * from './owner-statement.js';
```

- [ ] **Step 6: Verificar**

Run: `pnpm --filter @property-manager/core exec vitest run && pnpm --filter @property-manager/core exec tsc --noEmit`
Expected: PASS, sin errores.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/owner-statement.ts packages/core/src/owner-statement.test.ts packages/core/src/index.ts
git commit -m "feat: add the pure owner-statement calculation engine"
```

---

### Task 4: Vista previa del estado de cuenta (juntar datos + calcular)

**Files:**
- Create: `apps/api/src/services/owner-statement.service.ts`
- Create: `apps/api/src/services/owner-statement.service.test.ts`

**Interfaces:**
- Consumes: `calculateOwnerStatement`, `monthBoundsUtc`, `parseStatementPeriod` de `@property-manager/core` (Tasks 2-3); `prisma` de `../config/db.js`.
- Produces: desde `apps/api/src/services/owner-statement.service.ts`:
  ```typescript
  export type StatementPreviewResult =
    | { ok: false; status: 400 | 404; error: string }
    | { ok: true; preview: StatementPreview };

  export interface StatementPreview {
    propertyId: string;
    propertyName: string;
    ownerId: string | null;
    ownerName: string | null;
    period: string;
    periodStart: Date;
    periodEnd: Date;
    appliedFeePercentBps: number;
    reserveTargetCents: number;
    reserveAlreadyWithheldCents: number;
    rentIncomeCents: number;
    expensesCents: number;
    managementFeeCents: number;
    reserveWithheldCents: number;
    ownerPayoutCents: number;
    shortfallCents: number;
    alreadyClosed: boolean;
  }

  export async function previewOwnerStatement(input: {
    tenantId: string;
    propertyId: string;
    period: string;
  }): Promise<StatementPreviewResult>
  ```
  Consumido por las Tasks 5-6.

- [ ] **Step 1: Escribir el test (el módulo aún no existe)**

Crear `apps/api/src/services/owner-statement.service.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import { previewOwnerStatement } from './owner-statement.service.js';

const TENANT_ID = 'tenant_test_owner_statement';

async function cleanup() {
  await prisma.ownerStatement.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.bill.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.transaction.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.unit.deleteMany({ where: { property: { tenantId: TENANT_ID } } });
  await prisma.property.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.owner.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

async function seed(options: {
  withOwner?: boolean;
  feeBps?: number;
  reserveTargetCents?: number;
} = {}) {
  await prisma.tenant.create({
    data: { id: TENANT_ID, name: 'Owner Statement Test', province: 'BC' },
  });
  const owner = options.withOwner === false
    ? null
    : await prisma.owner.create({
      data: { tenantId: TENANT_ID, firstName: 'Olivia', lastName: 'Owner' },
    });
  const property = await prisma.property.create({
    data: {
      tenantId: TENANT_ID,
      name: 'Pacific Ridge',
      address: '100 Test St',
      city: 'Vancouver',
      province: 'BC',
      ownerId: owner?.id ?? null,
      managementFeePercentBps: options.feeBps ?? 1250,
      reserveFundTargetCents: options.reserveTargetCents ?? 0,
    },
  });
  const unit = await prisma.unit.create({
    data: {
      tenantId: TENANT_ID,
      propertyId: property.id,
      name: 'Unit 101',
      rentCents: 200_000,
      slug: `unit-101-${Date.now()}`,
    },
  });
  return { owner, property, unit };
}

async function addRent(unitId: string, amountCents: number, occurredAt: Date, reference: string) {
  await prisma.transaction.create({
    data: {
      tenantId: TENANT_ID,
      type: 'rent_payment',
      source: 'bank',
      amountCents,
      reference,
      unitId,
      occurredAt,
    },
  });
}

async function addBill(options: {
  totalCents: number;
  billDate: Date;
  status?: 'approved' | 'synced_to_qbo' | 'pending_review';
  unitId?: string;
  propertyId?: string;
}) {
  await prisma.bill.create({
    data: {
      tenantId: TENANT_ID,
      vendorName: 'Acme',
      billDate: options.billDate,
      totalCents: options.totalCents,
      category: 'repairs',
      status: options.status ?? 'approved',
      unitId: options.unitId,
      propertyId: options.propertyId,
    },
  });
}

describe('previewOwnerStatement', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('sums rent income and expenses for the period and applies the fee', async () => {
    const { property, unit } = await seed();
    await addRent(unit.id, 200_000, new Date('2026-08-10T12:00:00Z'), 'rent-aug');
    await addBill({ totalCents: 30_000, billDate: new Date('2026-08-15T12:00:00Z'), unitId: unit.id });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID,
      propertyId: property.id,
      period: '2026-08',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.preview.rentIncomeCents).toBe(200_000);
    expect(result.preview.expensesCents).toBe(30_000);
    expect(result.preview.managementFeeCents).toBe(25_000);
    expect(result.preview.ownerPayoutCents).toBe(145_000);
    expect(result.preview.alreadyClosed).toBe(false);
  });

  it('includes property-level bills that have no unit', async () => {
    const { property } = await seed();
    await addBill({ totalCents: 40_000, billDate: new Date('2026-08-05T12:00:00Z'), propertyId: property.id });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.expensesCents).toBe(40_000);
  });

  it('excludes bills that are not approved yet', async () => {
    const { property, unit } = await seed();
    await addBill({
      totalCents: 99_000,
      billDate: new Date('2026-08-05T12:00:00Z'),
      unitId: unit.id,
      status: 'pending_review',
    });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.expensesCents).toBe(0);
  });

  it('excludes movements from other months', async () => {
    const { property, unit } = await seed();
    await addRent(unit.id, 200_000, new Date('2026-07-10T12:00:00Z'), 'rent-jul');
    await addRent(unit.id, 111_000, new Date('2026-08-10T12:00:00Z'), 'rent-aug');
    await addBill({ totalCents: 50_000, billDate: new Date('2026-09-02T12:00:00Z'), unitId: unit.id });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.rentIncomeCents).toBe(111_000);
    expect(result.preview.expensesCents).toBe(0);
  });

  it('counts a payment made late on the last day of the month in Vancouver', async () => {
    const { property, unit } = await seed();
    // 31 de agosto 20:00 en Vancouver = 1 de septiembre 03:00 UTC.
    // Debe contar en AGOSTO, no en septiembre.
    await addRent(unit.id, 77_000, new Date('2026-09-01T03:00:00Z'), 'rent-late-aug');

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.rentIncomeCents).toBe(77_000);
  });

  it('subtracts the reserve already withheld in prior closed statements', async () => {
    const { property, owner, unit } = await seed({ reserveTargetCents: 50_000 });
    await addRent(unit.id, 200_000, new Date('2026-08-10T12:00:00Z'), 'rent-aug');
    await prisma.ownerStatement.create({
      data: {
        tenantId: TENANT_ID,
        propertyId: property.id,
        ownerId: owner!.id,
        periodStart: new Date('2026-07-01T07:00:00Z'),
        periodEnd: new Date('2026-08-01T07:00:00Z'),
        rentIncomeCents: 0, expensesCents: 0, managementFeeCents: 0,
        reserveWithheldCents: 20_000, ownerPayoutCents: 0, shortfallCents: 0,
        appliedFeePercentBps: 1250, reserveTargetCents: 50_000,
        closedByUserId: 'u_test',
      },
    });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.reserveAlreadyWithheldCents).toBe(20_000);
    expect(result.preview.reserveWithheldCents).toBe(30_000);
  });

  it('flags a period that is already closed', async () => {
    const { property, owner } = await seed();
    await prisma.ownerStatement.create({
      data: {
        tenantId: TENANT_ID,
        propertyId: property.id,
        ownerId: owner!.id,
        periodStart: new Date('2026-08-01T07:00:00Z'),
        periodEnd: new Date('2026-09-01T07:00:00Z'),
        rentIncomeCents: 0, expensesCents: 0, managementFeeCents: 0,
        reserveWithheldCents: 0, ownerPayoutCents: 0, shortfallCents: 0,
        appliedFeePercentBps: 1250, reserveTargetCents: 0,
        closedByUserId: 'u_test',
      },
    });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.alreadyClosed).toBe(true);
  });

  it('previews a property with no owner assigned', async () => {
    const { property } = await seed({ withOwner: false });

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
    });

    if (!result.ok) throw new Error('expected success');
    expect(result.preview.ownerId).toBeNull();
  });

  it('rejects a malformed period', async () => {
    const { property } = await seed();

    const result = await previewOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-13',
    });

    expect(result).toEqual({ ok: false, status: 400, error: 'Invalid period; expected YYYY-MM' });
  });

  it('returns 404 for a property in another tenant', async () => {
    const { property } = await seed();

    const result = await previewOwnerStatement({
      tenantId: 'tenant_someone_else', propertyId: property.id, period: '2026-08',
    });

    expect(result).toEqual({ ok: false, status: 404, error: 'Property not found' });
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/owner-statement.service.test.ts`
Expected: FAIL — `Cannot find module './owner-statement.service.js'`

- [ ] **Step 3: Implementar**

Crear `apps/api/src/services/owner-statement.service.ts`:

```typescript
/**
 * Fase 3: estado de cuenta mensual del dueño.
 *
 * El estado de cuenta se CALCULA desde los Transaction/Bill que ya
 * registran el Financial Sentinel y el Puente Contable — no hay libro
 * mayor paralelo ni saldo acumulado en ninguna columna. ADR-005: esto no
 * mueve fondos, solo produce el documento y la instrucción de pago.
 */
import { calculateOwnerStatement, monthBoundsUtc, parseStatementPeriod } from '@property-manager/core';
import { prisma } from '../config/db.js';

/** Un gasto solo cuenta si ya pasó por su compuerta de revisión humana. */
const COUNTABLE_BILL_STATUSES = ['approved', 'synced_to_qbo'] as const;

export interface StatementPreview {
  propertyId: string;
  propertyName: string;
  ownerId: string | null;
  ownerName: string | null;
  period: string;
  periodStart: Date;
  periodEnd: Date;
  appliedFeePercentBps: number;
  reserveTargetCents: number;
  reserveAlreadyWithheldCents: number;
  rentIncomeCents: number;
  expensesCents: number;
  managementFeeCents: number;
  reserveWithheldCents: number;
  ownerPayoutCents: number;
  shortfallCents: number;
  alreadyClosed: boolean;
}

export type StatementPreviewResult =
  | { ok: false; status: 400 | 404; error: string }
  | { ok: true; preview: StatementPreview };

export async function previewOwnerStatement(input: {
  tenantId: string;
  propertyId: string;
  period: string;
}): Promise<StatementPreviewResult> {
  const parsed = parseStatementPeriod(input.period);
  if (!parsed) return { ok: false, status: 400, error: 'Invalid period; expected YYYY-MM' };

  const property = await prisma.property.findFirst({
    where: { id: input.propertyId, tenantId: input.tenantId },
    include: { owner: true, units: { select: { id: true } } },
  });
  if (!property) return { ok: false, status: 404, error: 'Property not found' };

  const { periodStart, periodEnd } = monthBoundsUtc(parsed.year, parsed.month);
  const unitIds = property.units.map((unit) => unit.id);

  const [rentAggregate, billAggregate, priorReserve, existing] = await Promise.all([
    // Los ingresos se filtran por occurredAt (cuándo se recibió), no por
    // createdAt: un pago capturado tarde pertenece al mes en que ocurrió.
    unitIds.length === 0
      ? Promise.resolve({ _sum: { amountCents: null } })
      : prisma.transaction.aggregate({
        _sum: { amountCents: true },
        where: {
          tenantId: input.tenantId,
          type: 'rent_payment',
          unitId: { in: unitIds },
          occurredAt: { gte: periodStart, lt: periodEnd },
        },
      }),
    // Los gastos se filtran por billDate (la fecha de la factura): un
    // recibo de julio subido en agosto es un gasto de julio.
    prisma.bill.aggregate({
      _sum: { totalCents: true },
      where: {
        tenantId: input.tenantId,
        status: { in: [...COUNTABLE_BILL_STATUSES] },
        billDate: { gte: periodStart, lt: periodEnd },
        OR: [
          { propertyId: property.id },
          ...(unitIds.length > 0 ? [{ unitId: { in: unitIds } }] : []),
        ],
      },
    }),
    prisma.ownerStatement.aggregate({
      _sum: { reserveWithheldCents: true },
      where: { propertyId: property.id, periodStart: { lt: periodStart } },
    }),
    prisma.ownerStatement.findUnique({
      where: { propertyId_periodStart: { propertyId: property.id, periodStart } },
      select: { id: true },
    }),
  ]);

  const rentIncomeCents = rentAggregate._sum.amountCents ?? 0;
  const expensesCents = billAggregate._sum.totalCents ?? 0;
  const reserveAlreadyWithheldCents = priorReserve._sum.reserveWithheldCents ?? 0;

  const breakdown = calculateOwnerStatement({
    rentIncomeCents,
    expensesCents,
    managementFeePercentBps: property.managementFeePercentBps,
    reserveFundTargetCents: property.reserveFundTargetCents,
    reserveAlreadyWithheldCents,
  });

  return {
    ok: true,
    preview: {
      propertyId: property.id,
      propertyName: property.name,
      ownerId: property.ownerId,
      ownerName: property.owner ? `${property.owner.firstName} ${property.owner.lastName}` : null,
      period: input.period,
      periodStart,
      periodEnd,
      appliedFeePercentBps: property.managementFeePercentBps,
      reserveTargetCents: property.reserveFundTargetCents,
      reserveAlreadyWithheldCents,
      ...breakdown,
      alreadyClosed: existing !== null,
    },
  };
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/owner-statement.service.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Verificar la suite completa y el typecheck**

Run: `pnpm --filter @property-manager/api exec vitest run && pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: PASS, sin errores.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/owner-statement.service.ts apps/api/src/services/owner-statement.service.test.ts
git commit -m "feat: preview an owner statement from existing transactions and bills"
```

---

### Task 5: Cerrar el mes

**Files:**
- Modify: `apps/api/src/services/owner-statement.service.ts`
- Modify: `apps/api/src/services/owner-statement.service.test.ts`

**Interfaces:**
- Consumes: `previewOwnerStatement` (Task 4); `writeAudit` de `./audit.service.js`.
- Produces:
  ```typescript
  export type CloseStatementResult =
    | { ok: false; status: 400 | 404 | 409; error: string }
    | { ok: true; statementId: string };

  export async function closeOwnerStatement(input: {
    tenantId: string;
    propertyId: string;
    period: string;
    actorUserId: string;
    now?: Date;
  }): Promise<CloseStatementResult>
  ```
  Consumido por la Task 6. El parámetro `now` existe solo para que los tests puedan simular "el mes ya terminó" sin depender del reloj real.

- [ ] **Step 1: Escribir los tests**

En `apps/api/src/services/owner-statement.service.test.ts`, agregar `closeOwnerStatement` al import existente y agregar al final:

```typescript
const AFTER_AUGUST = new Date('2026-09-05T12:00:00Z');

describe('closeOwnerStatement', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('persists an immutable statement and an owner_distribution record', async () => {
    const { property, unit } = await seed();
    await addRent(unit.id, 200_000, new Date('2026-08-10T12:00:00Z'), 'rent-aug');
    await addBill({ totalCents: 30_000, billDate: new Date('2026-08-15T12:00:00Z'), unitId: unit.id });

    const result = await closeOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
      actorUserId: 'u_pm', now: AFTER_AUGUST,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');

    const saved = await prisma.ownerStatement.findUniqueOrThrow({ where: { id: result.statementId } });
    expect(saved.rentIncomeCents).toBe(200_000);
    expect(saved.expensesCents).toBe(30_000);
    expect(saved.managementFeeCents).toBe(25_000);
    expect(saved.ownerPayoutCents).toBe(145_000);
    expect(saved.appliedFeePercentBps).toBe(1250);
    expect(saved.closedByUserId).toBe('u_pm');

    const distribution = await prisma.transaction.findFirst({
      where: { tenantId: TENANT_ID, type: 'owner_distribution' },
    });
    expect(distribution?.amountCents).toBe(-145_000);
  });

  it('refuses to close a month that has not ended yet', async () => {
    const { property } = await seed();

    const result = await closeOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
      actorUserId: 'u_pm', now: new Date('2026-08-15T12:00:00Z'),
    });

    expect(result).toEqual({ ok: false, status: 409, error: 'Cannot close a period that has not ended yet' });
    expect(await prisma.ownerStatement.count({ where: { tenantId: TENANT_ID } })).toBe(0);
  });

  it('refuses to close a property with no owner assigned', async () => {
    const { property } = await seed({ withOwner: false });

    const result = await closeOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
      actorUserId: 'u_pm', now: AFTER_AUGUST,
    });

    expect(result).toEqual({ ok: false, status: 409, error: 'Property has no owner assigned' });
  });

  it('refuses to close the same month twice', async () => {
    const { property } = await seed();
    await closeOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
      actorUserId: 'u_pm', now: AFTER_AUGUST,
    });

    const second = await closeOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
      actorUserId: 'u_pm', now: AFTER_AUGUST,
    });

    expect(second).toEqual({ ok: false, status: 409, error: 'This period is already closed' });
    expect(await prisma.ownerStatement.count({ where: { tenantId: TENANT_ID } })).toBe(1);
  });

  it('survives two concurrent close attempts, creating exactly one statement', async () => {
    const { property, unit } = await seed();
    await addRent(unit.id, 200_000, new Date('2026-08-10T12:00:00Z'), 'rent-aug');

    const [first, second] = await Promise.all([
      closeOwnerStatement({
        tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
        actorUserId: 'u_pm', now: AFTER_AUGUST,
      }),
      closeOwnerStatement({
        tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
        actorUserId: 'u_pm', now: AFTER_AUGUST,
      }),
    ]);

    const succeeded = [first, second].filter((r) => r.ok);
    const failed = [first, second].filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(await prisma.ownerStatement.count({ where: { tenantId: TENANT_ID } })).toBe(1);
  });

  it('closes a month with no activity at all', async () => {
    const { property } = await seed();

    const result = await closeOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
      actorUserId: 'u_pm', now: AFTER_AUGUST,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const saved = await prisma.ownerStatement.findUniqueOrThrow({ where: { id: result.statementId } });
    expect(saved.rentIncomeCents).toBe(0);
    expect(saved.ownerPayoutCents).toBe(0);
  });

  it('records no distribution transaction when the month closed in the red', async () => {
    const { property, unit } = await seed();
    await addBill({ totalCents: 90_000, billDate: new Date('2026-08-15T12:00:00Z'), unitId: unit.id });

    const result = await closeOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
      actorUserId: 'u_pm', now: AFTER_AUGUST,
    });

    if (!result.ok) throw new Error('expected success');
    const saved = await prisma.ownerStatement.findUniqueOrThrow({ where: { id: result.statementId } });
    expect(saved.ownerPayoutCents).toBe(0);
    expect(saved.shortfallCents).toBe(90_000);
    expect(await prisma.transaction.count({
      where: { tenantId: TENANT_ID, type: 'owner_distribution' },
    })).toBe(0);
  });

  it('does not change a closed statement when later movements are edited', async () => {
    const { property, unit } = await seed();
    await addRent(unit.id, 200_000, new Date('2026-08-10T12:00:00Z'), 'rent-aug');
    const closed = await closeOwnerStatement({
      tenantId: TENANT_ID, propertyId: property.id, period: '2026-08',
      actorUserId: 'u_pm', now: AFTER_AUGUST,
    });
    if (!closed.ok) throw new Error('expected success');

    await addRent(unit.id, 500_000, new Date('2026-08-20T12:00:00Z'), 'rent-aug-extra');

    const saved = await prisma.ownerStatement.findUniqueOrThrow({ where: { id: closed.statementId } });
    expect(saved.rentIncomeCents).toBe(200_000);
  });
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/owner-statement.service.test.ts`
Expected: FAIL — `closeOwnerStatement is not exported`.

- [ ] **Step 3: Implementar**

En `apps/api/src/services/owner-statement.service.ts`, agregar el import de auditoría junto a los existentes:

```typescript
import { writeAudit } from './audit.service.js';
```

y agregar al final del archivo:

```typescript
export type CloseStatementResult =
  | { ok: false; status: 400 | 404 | 409; error: string }
  | { ok: true; statementId: string };

/**
 * Cierra el mes: persiste la foto inmutable del cálculo y registra la
 * instrucción de pago.
 *
 * ADR-005: el Transaction de tipo `owner_distribution` es un REGISTRO de
 * lo que se debe pagar, no una transferencia. Ningún endpoint de este
 * sistema mueve fondos; el pago lo ejecuta un humano por fuera.
 */
export async function closeOwnerStatement(input: {
  tenantId: string;
  propertyId: string;
  period: string;
  actorUserId: string;
  now?: Date;
}): Promise<CloseStatementResult> {
  const previewResult = await previewOwnerStatement({
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    period: input.period,
  });
  if (!previewResult.ok) return previewResult;

  const { preview } = previewResult;
  const now = input.now ?? new Date();

  if (now < preview.periodEnd) {
    return { ok: false, status: 409, error: 'Cannot close a period that has not ended yet' };
  }
  if (!preview.ownerId) {
    return { ok: false, status: 409, error: 'Property has no owner assigned' };
  }
  if (preview.alreadyClosed) {
    return { ok: false, status: 409, error: 'This period is already closed' };
  }

  let statementId: string;
  try {
    const statement = await prisma.ownerStatement.create({
      data: {
        tenantId: input.tenantId,
        propertyId: preview.propertyId,
        ownerId: preview.ownerId,
        periodStart: preview.periodStart,
        periodEnd: preview.periodEnd,
        rentIncomeCents: preview.rentIncomeCents,
        expensesCents: preview.expensesCents,
        managementFeeCents: preview.managementFeeCents,
        reserveWithheldCents: preview.reserveWithheldCents,
        ownerPayoutCents: preview.ownerPayoutCents,
        shortfallCents: preview.shortfallCents,
        appliedFeePercentBps: preview.appliedFeePercentBps,
        reserveTargetCents: preview.reserveTargetCents,
        closedByUserId: input.actorUserId,
      },
    });
    statementId = statement.id;
  } catch {
    // La unique (propertyId, periodStart) es la red de seguridad real
    // contra dos cierres concurrentes: el chequeo de alreadyClosed de
    // arriba puede perder la carrera, esto no.
    return { ok: false, status: 409, error: 'This period is already closed' };
  }

  if (preview.ownerPayoutCents > 0) {
    await prisma.transaction.create({
      data: {
        tenantId: input.tenantId,
        type: 'owner_distribution',
        source: 'manual',
        // Negativo: es una salida desde la perspectiva de la propiedad.
        amountCents: -preview.ownerPayoutCents,
        reference: `owner-statement:${statementId}`,
        occurredAt: preview.periodEnd,
      },
    });
  }

  await writeAudit({
    tenantId: input.tenantId,
    actorId: input.actorUserId,
    actorType: 'user',
    action: 'owner_statement.closed',
    entityType: 'owner_statement',
    entityId: statementId,
    payload: {
      period: input.period,
      propertyId: preview.propertyId,
      ownerPayoutCents: preview.ownerPayoutCents,
      shortfallCents: preview.shortfallCents,
    },
  });

  return { ok: true, statementId };
}
```

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/owner-statement.service.test.ts`
Expected: PASS (18 tests — los 10 de la Task 4 + 8 nuevos).

- [ ] **Step 5: Verificar la suite completa y el typecheck**

Run: `pnpm --filter @property-manager/api exec vitest run && pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: PASS, sin errores.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/owner-statement.service.ts apps/api/src/services/owner-statement.service.test.ts
git commit -m "feat: close a month into an immutable owner statement"
```

---

### Task 6: Rutas

**Files:**
- Modify: `apps/api/src/routes/properties.ts`

**Interfaces:**
- Consumes: `previewOwnerStatement`, `closeOwnerStatement` (Tasks 4-5).
- Produces: `GET /properties/:id/statement-preview?period=YYYY-MM`, `POST /properties/:id/statements`, `GET /properties/:id/statements`, y la extensión de `PATCH`/`POST` de propiedad para configurar dueño/comisión/reserva.

Este task no tiene ciclo TDD propio (la lógica ya está probada en las Tasks 4-5); se verifica con typecheck y la suite completa.

- [ ] **Step 1: Extender el schema de validación de propiedad**

En `apps/api/src/routes/properties.ts`, agregar los tres campos al `propertySchema` existente:

```typescript
  ownerId: z.string().optional().nullable(),
  managementFeePercentBps: z.number().int().min(0).max(10_000).optional(),
  reserveFundTargetCents: z.number().int().min(0).optional(),
```

El tope de 10000 bps = 100%: una comisión mayor al ingreso no tiene sentido y dejaría el estado de cuenta siempre en rojo.

**Ojo con la diferencia entre los dos handlers.** El `PATCH /:propertyId` hace `...parsed.data`, así que recoge los campos nuevos automáticamente — no hay que tocarlo. Pero el `POST /` **enumera los campos uno por uno**, así que sin editarlo ignoraría en silencio la configuración al crear una propiedad. En el `data` del `prisma.property.create` del `POST /`, agregar después de `postalCode`:

```typescript
        ownerId: parsed.data.ownerId || null,
        ...(parsed.data.managementFeePercentBps === undefined
          ? {}
          : { managementFeePercentBps: parsed.data.managementFeePercentBps }),
        ...(parsed.data.reserveFundTargetCents === undefined
          ? {}
          : { reserveFundTargetCents: parsed.data.reserveFundTargetCents }),
```

Los dos spreads condicionales existen para no pisar los `@default` del schema cuando el cliente no manda esos campos.

- [ ] **Step 2: Agregar las tres rutas nuevas**

En el mismo archivo, agregar los imports:

```typescript
import { requireRole } from '../auth/context.js';
import { closeOwnerStatement, previewOwnerStatement } from '../services/owner-statement.service.js';
```

(si `requireAuth`/`requireUser` ya se importan de `../auth/context.js`, agrega `requireRole` a ese import existente en vez de duplicar la línea)

y agregar las rutas al final del archivo. Nota que usan `:propertyId`, no `:id`: es el nombre de parámetro que ya usa el resto del archivo (ver el `PATCH /:propertyId`).

```typescript
propertiesRouter.get('/:propertyId/statement-preview', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const period = typeof req.query.period === 'string' ? req.query.period : '';
    const result = await previewOwnerStatement({
      tenantId: user.tenantId,
      propertyId: req.params.propertyId,
      period,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ preview: result.preview });
  } catch (err) {
    next(err);
  }
});

propertiesRouter.post(
  '/:propertyId/statements',
  requireAuth,
  requireRole('property_manager'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const period = typeof req.body?.period === 'string' ? req.body.period : '';
      const result = await closeOwnerStatement({
        tenantId: user.tenantId,
        propertyId: req.params.propertyId,
        period,
        actorUserId: user.userId,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.status(201).json({ statementId: result.statementId });
    } catch (err) {
      next(err);
    }
  },
);

propertiesRouter.get('/:propertyId/statements', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const statements = await prisma.ownerStatement.findMany({
      where: { propertyId: req.params.propertyId, tenantId: user.tenantId },
      orderBy: { periodStart: 'desc' },
    });
    res.json({ statements });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 3: Verificar**

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — toda la suite.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/properties.ts
git commit -m "feat: expose statement preview, close, and history routes"
```

---

### Task 7: Pantalla de estados de cuenta

**Files:**
- Create: `apps/web/src/pages/OwnerStatementsPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/Layout.tsx`

**Interfaces:**
- Consumes: las tres rutas de la Task 6 y `PATCH /properties/:id` para la configuración; `apiFetch` de `../lib/apiClient`.

Toda la interfaz de Fase 3 vive en una página nueva, en vez de operar sobre `PropertiesPage`: menos riesgo de romper lo existente y todo el flujo (configurar → previsualizar → cerrar → historial) queda en un solo lugar. El repo no tiene tests unitarios de frontend; se verifica con typecheck y revisión manual.

- [ ] **Step 1: Crear la página**

Crear `apps/web/src/pages/OwnerStatementsPage.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/apiClient';

type Property = {
  id: string;
  name: string;
  ownerId: string | null;
  managementFeePercentBps: number;
  reserveFundTargetCents: number;
};

type Preview = {
  propertyName: string;
  ownerName: string | null;
  period: string;
  appliedFeePercentBps: number;
  reserveTargetCents: number;
  reserveAlreadyWithheldCents: number;
  rentIncomeCents: number;
  expensesCents: number;
  managementFeeCents: number;
  reserveWithheldCents: number;
  ownerPayoutCents: number;
  shortfallCents: number;
  alreadyClosed: boolean;
};

type Statement = {
  id: string;
  periodStart: string;
  rentIncomeCents: number;
  expensesCents: number;
  managementFeeCents: number;
  reserveWithheldCents: number;
  ownerPayoutCents: number;
  shortfallCents: number;
};

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
}

function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function OwnerStatementsPage() {
  const queryClient = useQueryClient();
  const [propertyId, setPropertyId] = useState<string>('');
  const [period, setPeriod] = useState<string>(currentPeriod());
  const [error, setError] = useState<string | null>(null);

  const properties = useQuery<{ properties: Property[] }>({
    queryKey: ['properties'],
    queryFn: () => apiFetch('/properties'),
  });

  const preview = useQuery<{ preview: Preview }>({
    queryKey: ['statement-preview', propertyId, period],
    queryFn: () => apiFetch(`/properties/${propertyId}/statement-preview?period=${period}`),
    enabled: Boolean(propertyId && period),
    retry: false,
  });

  const history = useQuery<{ statements: Statement[] }>({
    queryKey: ['statements', propertyId],
    queryFn: () => apiFetch(`/properties/${propertyId}/statements`),
    enabled: Boolean(propertyId),
  });

  const closeMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/properties/${propertyId}/statements`, {
        method: 'POST',
        body: JSON.stringify({ period }),
      }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['statement-preview', propertyId, period] });
      void queryClient.invalidateQueries({ queryKey: ['statements', propertyId] });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not close this period');
    },
  });

  const selected = properties.data?.properties.find((p) => p.id === propertyId);
  const p = preview.data?.preview;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Owner Statements</h1>
        <p className="mt-1 text-sm text-slate-600">
          Monthly settlement per property. Amounts are calculated from recorded rent payments and
          approved bills — closing a period issues a statement, it does not move any funds.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <select
          value={propertyId}
          onChange={(event) => { setPropertyId(event.target.value); setError(null); }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">Select a property…</option>
          {properties.data?.properties.map((property) => (
            <option key={property.id} value={property.id}>{property.name}</option>
          ))}
        </select>
        <input
          type="month"
          value={period}
          onChange={(event) => { setPeriod(event.target.value); setError(null); }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </div>

      {selected && !selected.ownerId && (
        <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          This property has no owner assigned, so its statements cannot be closed.
        </div>
      )}

      {preview.isError && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Could not load the preview for this period.
        </div>
      )}

      {p && (
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-medium text-slate-900">
            {p.propertyName} — {p.period}
          </h2>
          <p className="text-sm text-slate-600">Owner: {p.ownerName ?? 'Not assigned'}</p>

          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Rent income" value={money(p.rentIncomeCents)} />
            <Row label="Expenses" value={`− ${money(p.expensesCents)}`} />
            <Row
              label={`Management fee (${(p.appliedFeePercentBps / 100).toFixed(2)}%)`}
              value={`− ${money(p.managementFeeCents)}`}
            />
            <Row
              label={`Reserve withheld (target ${money(p.reserveTargetCents)}, held ${money(p.reserveAlreadyWithheldCents)})`}
              value={`− ${money(p.reserveWithheldCents)}`}
            />
            <div className="border-t border-slate-200 pt-2">
              {p.shortfallCents > 0 ? (
                <Row label="Owed by owner" value={money(p.shortfallCents)} strong />
              ) : (
                <Row label="Owner payout" value={money(p.ownerPayoutCents)} strong />
              )}
            </div>
          </dl>

          {error && (
            <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>
          )}

          <button
            onClick={() => closeMutation.mutate()}
            disabled={p.alreadyClosed || closeMutation.isPending}
            className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {p.alreadyClosed ? 'Period already closed' : closeMutation.isPending ? 'Closing…' : 'Close period'}
          </button>
        </div>
      )}

      {history.data?.statements?.length ? (
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-medium text-slate-900">Closed statements</h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {history.data.statements.map((statement) => (
              <li key={statement.id} className="flex justify-between py-2">
                <span className="text-slate-700">
                  {new Date(statement.periodStart).toLocaleDateString('en-CA', {
                    year: 'numeric', month: 'long', timeZone: 'UTC',
                  })}
                </span>
                <span className="font-medium text-slate-900">
                  {statement.shortfallCents > 0
                    ? `− ${money(statement.shortfallCents)}`
                    : money(statement.ownerPayoutCents)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={strong ? 'font-medium text-slate-900' : 'text-slate-600'}>{label}</dt>
      <dd className={strong ? 'font-semibold text-slate-900' : 'text-slate-800'}>{value}</dd>
    </div>
  );
}
```

Nota: esta pantalla **no** asigna dueños — solo avisa cuando falta uno. No existe una ruta `/owners` y no debes construirla: asignar dueños es trabajo de la pantalla de Properties y queda fuera de este plan (ver "Limitación conocida" al final).

- [ ] **Step 2: Registrar la ruta**

En `apps/web/src/App.tsx`, agregar el import junto a los demás de páginas (usa **export nombrado**, es la convención del repo):

```tsx
import { OwnerStatementsPage } from './pages/OwnerStatementsPage';
```

y la ruta dentro de `ProtectedRoutes`, junto a `/reconciliation`:

```tsx
        <Route path="/owner-statements" element={<OwnerStatementsPage />} />
```

- [ ] **Step 3: Agregar la entrada de navegación**

En `apps/web/src/components/Layout.tsx`, agregar al array `NAV`, después de la línea de `/reconciliation`:

```tsx
  { to: '/owner-statements', label: 'Owner Statements', icon: 'reconciliation', roles: ['property_manager', 'bookkeeper'] },
```

(Se reutiliza el icono `reconciliation` porque ya existe en `Icon.tsx`; si prefieres otro, verifica primero que el nombre exista en ese archivo.)

- [ ] **Step 4: Verificar el typecheck**

Run: `pnpm --filter @property-manager/web exec tsc --noEmit`
Expected: sin errores.

- [ ] **Step 5: Verificación manual en el navegador**

Con Postgres/Redis arriba y ambos servidores corriendo (`pnpm --filter @property-manager/api dev`, `pnpm --filter @property-manager/web dev`), entrando como `pm@pacificridge.ca` / `Password123!`:

1. Abre "Owner Statements" en la navegación.
2. Selecciona una propiedad y un mes **ya terminado**.
3. Confirma que el desglose aparece y que los números cuadran (ingresos − gastos − comisión − reserva = pago).
4. Si la propiedad tiene dueño asignado, pica "Close period" y confirma que aparece en "Closed statements" y que el botón queda deshabilitado.

Expected: los 4 pasos sin errores en consola.

**Si ninguna propiedad de demo tiene dueño asignado** (es lo esperado: el seed crea dueños pero no los vincula), asígnalo directamente en la base para poder probar el cierre:
`docker exec pm-postgres psql -U pm_dev -d property_manager -c "UPDATE properties SET \"ownerId\" = (SELECT id FROM owners LIMIT 1) WHERE \"ownerId\" IS NULL;"`
Eso es solo para la verificación manual — no lo conviertas en parte del código.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/OwnerStatementsPage.tsx apps/web/src/App.tsx apps/web/src/components/Layout.tsx
git commit -m "feat: add the owner statements page"
```

---

### Task 8: Regresión completa

**Files:** ninguno nuevo — solo verificación.

- [ ] **Step 1: Typecheck de todo el monorepo**

Run: `pnpm -r exec tsc --noEmit`
Expected: sin errores en ningún paquete.

- [ ] **Step 2: Todas las suites**

Run: `pnpm --filter @property-manager/core exec vitest run`
Expected: PASS.

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS.

Run: `pnpm --filter @property-manager/adapters exec vitest run`
Expected: PASS.

- [ ] **Step 3: Commit (solo si algún ajuste fue necesario)**

Si los steps 1-2 no requirieron cambios, no hay nada que comitear.

---

## Limitación conocida de este plan

**Asignar un dueño a una propiedad no tiene interfaz.** El backend lo
soporta (la Task 6 acepta `ownerId` al crear/actualizar propiedad), pero la
pantalla de Properties no expone el selector, y no existe una ruta `/owners`
para listarlos. Hoy se asigna por API directa o por base de datos.

Es una decisión consciente de alcance: la pantalla de Properties es grande
y tocarla arriesga funcionalidad existente, mientras que el valor central
de esta fase (calcular y cerrar el estado de cuenta) no depende de ello. La
página de Owner Statements avisa explícitamente cuando una propiedad no
tiene dueño asignado, en vez de fallar en silencio.
