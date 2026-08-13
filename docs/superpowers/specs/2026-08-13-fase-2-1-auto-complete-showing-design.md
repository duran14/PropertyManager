# Fase 2.1 — Disparo automático post-showing — Diseño

## 1. El gap

`docs/PRODUCT_ROADMAP.md`, sección 2.1: *"Trigger: transcurridas 2 horas desde
la finalización del evento showing en el calendario. Acción: enviar un
mensaje con un enlace seguro... conteniendo el formulario de solicitud
formal de arrendamiento."*

Hoy esto es 100% manual: un botón *"Mark as completed"* en `ShowingsPage.tsx`
(`apps/web/src/pages/ShowingsPage.tsx:543-550`) llama a
`POST /showings/:id/complete` (`apps/api/src/routes/showings.ts:65-90`), que
ejecuta `completeShowingAndInvite`
(`apps/api/src/services/rental-application.service.ts:73-142`) — la misma
función hace la transición de estado (`scheduled`/`confirmed` →
`completed`) Y crea/envía la invitación, en una sola llamada síncrona
iniciada por un humano. No existe ningún temporizador ni sondeo que
detecte "ya pasaron 2 horas desde que terminó el showing" — confirmado por
inspección directa: `completeShowingAndInvite` no lee `scheduledAt` ni
`durationMinutes`, y es el único punto donde un `Showing` transiciona a
`'completed'` en todo el código.

## 2. Diseño

**No se reemplaza el botón manual — se agrega un sondeo automático que
llama la MISMA función.** El botón sigue existiendo (útil para completar
antes de las 2 horas, o para un showing que el sondeo automático se saltó
por alguna razón).

### 2.1 Sondeo periódico, mismo patrón que `shortlist-reminders.ts`

Nuevo archivo `apps/api/src/jobs/showing-auto-complete.ts`, mismo patrón
que el worker de recordatorios de shortlist ya existente (`setInterval` +
consulta de "filas vencidas" + núcleo inyectable para tests, sin BullMQ —
esto no necesita reintentos ni colas, es un sondeo idempotente que se
repite solo cada 15 minutos):

```ts
const CHECK_INTERVAL_MS = 15 * 60_000;
const TWO_HOURS_MS = 2 * 60 * 60_000;
// Protección contra un blast retroactivo la primera vez que esto se
// despliega: un showing cuyo fin + 2h cayó hace más de 48h no se
// auto-completa (el prospecto ya se enfrió, mandarle el link ahora sería
// raro) — se deja para que el staff lo complete a mano si aplica.
const STALE_CUTOFF_MS = 48 * 60 * 60_000;

export function startShowingAutoCompleteWorker(): void {
  setInterval(() => {
    void runShowingAutoCompleteSweep().catch((error) =>
      console.error('[ShowingAutoComplete] Sondeo falló:', error),
    );
  }, CHECK_INTERVAL_MS).unref();
}
```

### 2.2 Consulta de showings vencidos

`durationMinutes` es un campo por fila — Prisma no puede expresar
`scheduledAt + durationMinutes <= X` en un `where` type-safe sin SQL crudo.
En vez de eso: se sobre-consulta con un filtro simple (`scheduledAt` antes
de "hace 2 horas", una cota segura porque `durationMinutes` son minutos,
nunca horas) y se filtra con precisión en código:

```ts
export async function findShowingsDueForAutoComplete(now: Date) {
  const conservativeCutoff = new Date(now.getTime() - TWO_HOURS_MS);
  const candidates = await prisma.showing.findMany({
    where: { status: { in: ['scheduled', 'confirmed'] }, scheduledAt: { lte: conservativeCutoff } },
    select: { id: true, tenantId: true, scheduledAt: true, durationMinutes: true, brokerUserId: true },
  });
  return candidates.filter((showing) => {
    const dueAt = showing.scheduledAt.getTime() + showing.durationMinutes * 60_000 + TWO_HOURS_MS;
    return dueAt <= now.getTime() && now.getTime() - dueAt <= STALE_CUTOFF_MS;
  });
}
```

### 2.3 Completar cada showing vencido, reutilizando `completeShowingAndInvite`

```ts
export async function runShowingAutoCompleteSweep(deps?: { messaging?: ... }): Promise<{ completed: number; skipped: number }> {
  const due = await findShowingsDueForAutoComplete(new Date());
  const messaging = deps?.messaging ?? getAdapters().messaging;
  let completed = 0, skipped = 0;
  for (const showing of due) {
    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: showing.tenantId, actorUserId: showing.brokerUserId },
      { messaging },
    );
    // Un 409 acá es el camino NORMAL, no un error: alguien lo completó a
    // mano (el botón sigue vivo) o el ciclo anterior del sondeo ya lo
    // agarró — el guard de `updateMany` de completeShowingAndInvite ya
    // resuelve la carrera, este código solo cuenta el resultado.
    if (result.ok) completed++; else skipped++;
  }
  return { completed, skipped };
}
```

**Un showing por vez, secuencial** (no `Promise.all`): el volumen esperado
(showings vencidos entre sondeos de 15 min, para un property manager
individual) es bajo — decenas, no miles — y secuencial evita saturar el
adapter de mensajería o la conexión de Prisma sin necesidad. Si el volumen
crece, es un cambio localizado a este archivo.

### 2.4 `completeShowingAndInvite` — `actorUserId` pasa a aceptar `null`

`actorUserId` hoy es `string`, usado solo como *fallback* cuando
`showing.brokerUserId` es `null` (línea 102:
`brokerUserId: showing.brokerUserId ?? input.actorUserId`). El sondeo
automático no tiene un actor humano — pasa `showing.brokerUserId` directo,
que puede ser `null`. Cambio mínimo de firma:

```ts
export async function completeShowingAndInvite(
  input: { showingId: string; tenantId: string; actorUserId: string | null },
  deps: { messaging: Record<ChatChannel, MessagingAdapter> },
): Promise<CompleteShowingResult> {
  ...
  data: { status: 'completed', brokerUserId: showing.brokerUserId ?? input.actorUserId ?? undefined },
  ...
```

`undefined` en un `data` de Prisma omite el campo del `UPDATE` (deja
`brokerUserId` como estaba — `null`), a diferencia de pasar `null`
explícito. El único call site existente (`routes/showings.ts`, el botón
manual) sigue mandando un `string` real (`requireUser(req).id`) — asignable
sin cambios a `string | null`, no rompe nada.

### 2.5 Arranque

`apps/api/src/server.ts`, junto a `startShortlistReminderWorker()` y
`startMessageDeliveryRetryWorker()` (mismo bloque dentro del callback de
`app.listen`): `startShowingAutoCompleteWorker();`.

## 3. Fuera de alcance

- No se agrega un campo `completedAt`/`endedAt` al modelo `Showing` — el
  cálculo `scheduledAt + durationMinutes` ya es suficiente y evita una
  migración innecesaria (YAGNI).
- No se toca el botón manual ni su ruta — sigue funcionando exactamente
  igual, solo cambia el tipo de `actorUserId` que `completeShowingAndInvite`
  acepta (más permisivo, no más restrictivo).
- No se agrega ninguna cola de BullMQ — este sondeo no necesita reintentos
  individuales por showing: si un envío de mensaje falla,
  `completeShowingAndInvite` ya lo maneja como best-effort (el showing
  igual se completa y la aplicación se crea, el link simplemente no se
  entrega automáticamente — mismo comportamiento que el botón manual hoy).
