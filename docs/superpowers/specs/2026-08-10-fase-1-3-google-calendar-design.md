# Fase 1.3 — Asignación de showings y sync con Google Calendar

**Fecha:** 2026-08-10
**Estado:** aprobado por el usuario, listo para plan de implementación
**Roadmap:** [`docs/PRODUCT_ROADMAP.md`](../../PRODUCT_ROADMAP.md) §1.3

## Problema

El flujo de auto-booking ya existe de punta a punta: `chatbot.service.ts`
ofrece horarios, `scheduling.service.ts` agenda, se crea el `Showing`, el
lead pasa a `tour_scheduled` y se notifica al broker.

Lo que no existe es un calendario real detrás. La disponibilidad sale de
`ShowMojoMockAdapter`, que inventa slots (lunes a viernes, 10/12/14/16 h)
sin consultar nada. No hay `showmojo.real.ts` ni token de ShowMojo. El bot
le promete al prospecto una hora que nadie tiene bloqueada.

Esta fase reemplaza esa fuente falsa por el calendario real de la agencia y
escribe el evento de vuelta ahí.

## Alcance

**Dentro:**

- Conexión OAuth 2.0 con Google Calendar a nivel agencia (tenant).
- Configuración de horario laboral, duración, colchón y ventana de agenda.
- Motor puro de cálculo de huecos disponibles.
- Creación y borrado del evento de Google al agendar y cancelar.
- Pantalla para conectar el calendario y editar la configuración.

**Fuera (decisiones explícitas, no olvidos):**

- **Calendario por broker.** El contrato y el modelo de datos quedan listos
  para varios calendarios; esta fase implementa y expone solo el caso de un
  calendario por agencia. Ver "Preparación para el por-broker".
- **Sync de dos vías.** Google no nos avisa de cambios. Como la
  disponibilidad se lee en vivo en cada consulta, un evento que el manager
  mueva o borre en Google deja de bloquear el hueco automáticamente; lo que
  queda desfasado es el registro `Showing`, y la pantalla de Showings lo
  hace visible (ver "Red de seguridad visible").
- **Google Meet en los eventos.** Todas las visitas son presenciales.
- **Otros proveedores de calendario** (Outlook, CalDAV).

## Restricciones globales

Estas son vinculantes para toda la implementación:

1. **Sin SDKs nuevos.** Los adapters reales del repo (Twilio, Messenger,
   Resend) usan `fetch` pelón; `packages/adapters` solo depende de `zod`.
   Google Calendar y su endpoint de tokens son REST y funcionan igual. No
   se agrega `googleapis` ni ninguna otra dependencia.
2. **Errores por valor de retorno, no por excepción.** El manejador global
   de `app.ts` convierte cualquier `throw` en un 500. Todo error esperado se
   devuelve como resultado discriminado y la ruta lo mapea al status. Los
   precedentes en el repo son `TwilioClaimResult` en `routes/webhooks.ts` y
   `closeOwnerStatement` en `services/owner-statement.service.ts`.
3. **Nunca reportar como hecho algo que no ocurrió.** Si no hay calendario
   conectado, o Google falla, el bot no ofrece horarios y no crea showings.
   Jamás cae al mock de ShowMojo. Este error ya se cometió una vez con
   `WebChatMockAdapter` y no se repite.
4. **La zona horaria del negocio es `America/Vancouver`**, ya declarada como
   `BUSINESS_TIME_ZONE` en `packages/core/src/period.ts`. Los datos IANA
   actuales indican que Vancouver deja de observar horario de verano después
   de 2026: **las pruebas afirman propiedades locales** ("el hueco de las
   9:00 se renderiza como 9:00 hora local"), nunca constantes UTC quemadas.
5. **Credenciales cifradas en reposo.** Los tokens de Google se guardan con
   `encrypt()` / `decrypt()` de `apps/api/src/config/crypto.ts` (AES-256-GCM
   con `INTEGRATION_ENCRYPTION_KEY`). Nunca en texto plano, nunca en logs,
   nunca en payloads de auditoría.
6. **Las uniques de base son la red de concurrencia**, no los `if` del
   código. Igual que en la Fase 3.
7. **Aislamiento por tenant.** Toda consulta filtra por `tenantId`.

---

## Arquitectura

Tres capas con fronteras nítidas:

```
packages/core/src/availability.ts     ← motor puro: sin red, sin base
packages/adapters/src/…/calendar.*    ← solo HTTP con Google, sin estado
apps/api/src/services/scheduling.*    ← persistencia, tokens, orquestación
```

El adapter no sabe de la base de datos ni de tokens guardados: recibe un
access token ya válido y hace la llamada. El servicio es quien guarda,
descifra y refresca. El motor no sabe que Google existe.

---

## 1. Modelo de datos

### 1.1 `CalendarConnection`

```prisma
model CalendarConnection {
  id                   String                   @id @default(cuid())
  tenantId             String
  provider             CalendarProvider         @default(google)
  // Dueño de la conexión. Hoy siempre null (nivel agencia). La fase
  // por-broker lo llena sin migrar la tabla.
  userId               String?
  // Derivado en la misma escritura: "tenant" cuando userId es null,
  // "user:<id>" cuando no. Ver nota sobre NULL más abajo.
  ownerKey             String
  // Correo de la cuenta de Google conectada. Solo para mostrar en la UI.
  accountEmail         String
  // Calendario secundario que creamos nosotros, donde viven los showings.
  showingsCalendarId   String
  // Cifrados con config/crypto.ts (AES-256-GCM).
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
```

**Por qué `ownerKey` y no `@@unique([tenantId, userId])`:** en Postgres dos
`NULL` se consideran distintos entre sí, así que una unique sobre un
`userId` nulo **no** impediría dos conexiones de agencia para el mismo
tenant. `ownerKey` es una llave sintética que sí lo impide. Es la misma
técnica que `Showing.activeProspectSlotKey` ya usa en este esquema.

`ownerKey` se calcula y se escribe en la misma operación que `userId`;
nunca se edita por separado.

### 1.2 `SchedulingConfig`

Una fila por tenant. Se crea con valores por defecto la primera vez que se
lee (upsert), así no hace falta backfill.

```prisma
model SchedulingConfig {
  id                     String   @id @default(cuid())
  tenantId               String   @unique
  // Ver formato en 1.3. Validado con zod en cada lectura y escritura.
  // Sin default a nivel Prisma a propósito: el valor por defecto lo escribe
  // el servicio al crear la fila (ver nota abajo), para que exista una sola
  // definición de "el horario por defecto".
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

| Campo | Default | Para qué |
|---|---|---|
| `weeklyHours` | L-V 09:00–17:00 | cuándo se puede agendar |
| `timeZone` | `America/Vancouver` | zona en la que se interpretan esas horas |
| `showingDurationMinutes` | 30 | duración de la visita |
| `bufferMinutes` | 30 | traslado entre visitas |
| `minNoticeHours` | 4 | no ofrecer algo dentro de 20 minutos |
| `maxAdvanceDays` | 14 | hasta dónde ofrecer hacia adelante |
| `slotGranularityMinutes` | 30 | para no ofrecer "9:07" |

El horario por defecto vive en **una sola** constante exportada,
`DEFAULT_WEEKLY_HOURS` en `packages/core/src/availability.ts`
(lunes a viernes, un rango 09:00–17:00; sábado y domingo vacíos). El
servicio la usa al crear la fila y la UI la usa para el botón "restaurar
valores por defecto". El esquema de Prisma no declara default para
`weeklyHours` justamente para que no haya dos definiciones que puedan
divergir.

`showingDurationMinutes` pasa por `normalizeShowingDuration()`, que ya
existe en `scheduling.service.ts` y solo acepta 15, 30, 45 o 60.

Validación de los demás, aplicada en la ruta de escritura:
`bufferMinutes` 0–120, `minNoticeHours` 0–72, `maxAdvanceDays` 1–60,
`slotGranularityMinutes` en {15, 30, 60}, `timeZone` debe ser aceptado por
`Intl.DateTimeFormat`.

### 1.3 Formato de `weeklyHours`

```json
{
  "mon": [{ "from": "09:00", "to": "12:00" }, { "from": "13:00", "to": "17:00" }],
  "tue": [{ "from": "09:00", "to": "17:00" }],
  "wed": [], "thu": [], "fri": [], "sat": [], "sun": []
}
```

Reglas, verificadas por el esquema de zod:

- Las siete llaves están siempre presentes; un día sin rangos es `[]`.
- `from` y `to` son `HH:MM` en 24 h, con `from` estrictamente menor que `to`.
- Los rangos de un mismo día no se traslapan y van ordenados.
- Un día puede tener a lo más 4 rangos.

Varios rangos por día es lo que permite la hora de comida sin inventar un
campo aparte.

### 1.4 Campos nuevos en `Showing`

```prisma
  // Evento en Google Calendar que bloquea este horario.
  googleEventId    String?
  googleCalendarId String?
  // Red de concurrencia: "<ownerKey>:<startAt ISO>". Se limpia al cancelar
  // para que el hueco vuelva a ofrecerse.
  calendarSlotKey  String?

  @@unique([tenantId, calendarSlotKey])
```

Dos leads que eligen el mismo horario al mismo tiempo chocan en un `P2002`;
el segundo recibe "ese horario acaba de ocuparse, elige otro". Es la misma
red que impidió cerrar dos veces el mismo mes en la Fase 3.

---

## 2. El motor de huecos — `packages/core/src/availability.ts`

Función pura. Sin red, sin base de datos, sin reloj implícito: el instante
"ahora" entra como parámetro.

```ts
export interface TimeRange {
  start: Date;
  end: Date;
}

export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface DayRange {
  from: string; // "HH:MM"
  to: string;   // "HH:MM"
}

export type WeeklyHours = Record<WeekdayKey, DayRange[]>;

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

export function computeAvailableSlots(
  input: ComputeAvailableSlotsInput,
): TimeRange[];
```

Algoritmo:

1. **Expandir el horario semanal.** Para cada día local del calendario en
   `[from, to]`, tomar los rangos de ese día de la semana y convertirlos a
   instantes UTC. Cada límite calcula su propio offset, así un rango que
   cruza el cambio de horario de verano no se corre una hora.
2. **Normalizar los ocupados.** Ordenar, fusionar los que se traslapan, y
   luego inflar cada bloque resultante por `bufferMinutes` a cada lado.
   Fusionar **antes** de inflar evita que dos eventos contiguos generen un
   colchón doble en medio.
3. **Recorrer.** En cada ventana laboral, avanzar en pasos de
   `granularityMinutes` desde el inicio de la ventana. Un candidato
   `[t, t + durationMinutes)` entra si cabe completo dentro de la ventana,
   no cruza ningún bloque inflado, y `t >= from`.
4. Devolver ordenado ascendente.

**Helper nuevo en `period.ts`.** Ese archivo ya calcula offsets de zona por
dentro (`timeZoneOffsetMs`, `zonedMonthStart`) para los límites de mes
contable. Se extrae y exporta:

```ts
export function zonedDateTimeToUtc(
  year: number,
  month: number,   // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date;
```

`monthBoundsUtc` se reescribe encima de este helper y conserva su
comportamiento y sus pruebas actuales. No es refactor gratuito: es
exactamente la pieza que el motor necesita y que ya está escrita y probada
en ese archivo.

### Casos que el motor debe cubrir en pruebas

- Día sin rangos configurados → cero huecos ese día.
- Ocupado que tapa toda la ventana laboral → cero huecos.
- Ocupado parcial → huecos antes y después, respetando el colchón.
- Dos eventos contiguos → un solo colchón entre ellos, no dos.
- Dos rangos en un mismo día (hora de comida) → no se ofrece nada en medio.
- `from` a media ventana → no se ofrecen huecos anteriores.
- Un hueco que no cabe completo antes de que cierre la ventana → se descarta.
- **Cruce de horario de verano:** el rango 09:00–17:00 del día del cambio
  produce huecos que se renderizan como 09:00 en adelante hora local.
- `busy` vacío → la ventana completa se llena según la granularidad.
- Granularidad 60 con duración 30 → huecos en punto, sin los de media hora.

---

## 3. OAuth y el adapter

### 3.1 Scopes y por qué

| Scope | Qué da |
|---|---|
| `https://www.googleapis.com/auth/calendar.freebusy` | Ver la disponibilidad de sus calendarios. Solo intervalos ocupados; ningún título, invitado ni descripción. |
| `https://www.googleapis.com/auth/calendar.app.created` | Crear calendarios secundarios y gestionar eventos **solo en los que la app creó**. |
| `openid`, `email` | Obtener el correo de la cuenta conectada para mostrarlo en la UI. |

Con esta combinación el token que guardamos **no alcanza** para leer el
detalle de ningún evento personal del manager. Eso cumple el requisito del
roadmap ("ocultar razones personales del calendario") a nivel de permiso
concedido, no de disciplina nuestra. La alternativa `calendar.events`
daría lectura y edición de todos sus eventos — más permiso del que la
función necesita y más que perder si esa credencial se filtra.

**Consecuencia obligatoria:** los showings viven en un calendario secundario
propio ("Property Showings"), así que la consulta de disponibilidad debe
preguntar por **ambos** calendarios — `primary` y `showingsCalendarId` — o
el bot ofrecería un horario donde ya hay otro showing.

El correo sale de decodificar el payload del `id_token` que Google devuelve
junto con los tokens. No hace falta verificar su firma: llegó directo del
endpoint de Google sobre TLS, no de un tercero.

### 3.2 Contrato `CalendarAdapter`

En `packages/adapters/src/contracts.ts`. Sin estado: recibe el access token
ya válido, no sabe de la base de datos.

```ts
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
  /** Si viene vacío, el evento se crea sin invitados. */
  attendeeEmails?: string[];
}

export interface CalendarAdapter {
  readonly name: 'google_calendar' | 'calendar_mock';

  exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
  }): Promise<{
    refreshToken: string;
    accessToken: string;
    expiresInSeconds: number;
    accountEmail: string;
  }>;

  refreshAccessToken(input: { refreshToken: string }): Promise<
    | { ok: true; accessToken: string; expiresInSeconds: number }
    | { ok: false; reason: 'revoked' | 'provider_error'; detail: string }
  >;

  /** Crea el calendario "Property Showings" si no existe; idempotente. */
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

  createEvent(input: { accessToken: string } & CalendarEventInput): Promise<{
    eventId: string;
    htmlLink?: string;
  }>;

  deleteEvent(input: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<void>;
}
```

`refreshAccessToken` devuelve resultado discriminado porque distinguir
"el manager revocó el acceso" de "Google está caído" cambia lo que hace el
sistema: lo primero apaga la conexión, lo segundo es transitorio. Los demás
métodos lanzan; el servicio los envuelve.

**Implementaciones:**

- `GoogleCalendarRealAdapter` (`packages/adapters/src/real/google-calendar.real.ts`),
  con `fetch` contra `https://oauth2.googleapis.com/token` y
  `https://www.googleapis.com/calendar/v3/…`.
- `CalendarMockAdapter` (`packages/adapters/src/mocks/calendar.mock.ts`),
  determinista, para desarrollo y pruebas.

El factory los selecciona con `isIntegrationConfigured(env, 'google_calendar')`,
igual que las once integraciones existentes. `IntegrationKey` gana el valor
`'google_calendar'`, la función devuelve
`Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)`, y la interfaz
`Adapters` gana el campo `calendar: CalendarAdapter`. Como `mockModes` está
tipado como `Record<IntegrationKey, boolean>`, el compilador exige la
entrada nueva y la UI de integraciones la muestra sin cambios.

**Importante:** que el adapter sea el mock no significa que el bot ofrezca
horarios falsos. El mock solo se usa cuando además existe una conexión en
la base, cosa que en desarrollo se siembra a propósito. Sin conexión, el
bot pasa a handoff (§4.3) sin importar qué adapter esté activo.

### 3.3 Variables de entorno

Se agregan a `packages/config/src/env.ts`, todas opcionales:

```
GOOGLE_CLIENT_ID              default ''
GOOGLE_CLIENT_SECRET          default ''
GOOGLE_OAUTH_REDIRECT_URI     default ''  → si vacío se usa
                              `${API_URL}/api/integrations/google-calendar/callback`
```

### 3.4 Rutas

Nuevo router `apps/api/src/routes/integrations.google-calendar.ts`, montado
en `/api/integrations/google-calendar`. Todas requieren sesión; conectar y
desconectar exigen rol `property_manager`.

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/` | Estado: `{ connected, accountEmail?, status?, lastErrorAt? }` |
| `POST` | `/authorize` | Devuelve `{ authorizeUrl }` |
| `GET` | `/callback` | Canjea el código y redirige a la app web |
| `DELETE` | `/` | Borra la conexión |

**`POST /authorize`** arma la URL de consentimiento de Google con
`access_type=offline` y `prompt=consent` — sin ambos, Google no entrega
refresh token en reconexiones — y un parámetro `state`.

**El `state`** es `base64url(payload).base64url(hmac)`, donde el payload es
`{ tenantId, userId, exp }` y el HMAC-SHA256 se calcula con
`JWT_ACCESS_SECRET`. Vigencia 10 minutos. Protege contra CSRF sin tabla
nueva. El callback rechaza un `state` con firma inválida o expirado.

**`GET /callback`** es la única ruta pública del router (Google redirige el
navegador ahí, sin nuestra cookie de sesión necesariamente presente); su
autenticación **es** el `state` firmado. Pasos:

1. Validar `state`. Si falla → redirigir a
   `${WEB_URL}/showings?calendar=error&reason=invalid_state`.
2. Canjear el código.
3. `ensureShowingsCalendar`.
4. Guardar la conexión (upsert por `[tenantId, ownerKey]`) con los tokens
   cifrados y `status: 'active'`.
5. Auditar `calendar.connected` con `accountEmail` y `calendarId`.
   **Nunca** con tokens.
6. Redirigir a `${WEB_URL}/showings?calendar=connected`.

**`DELETE /`** borra la fila y audita `calendar.disconnected`. Los showings
ya agendados conservan su `googleEventId`; sus eventos siguen en Google.

### 3.5 Ciclo de vida del access token

Un helper del servicio, `getUsableAccessToken(tenantId)`:

1. Lee la conexión. Sin fila → `{ ok: false, reason: 'not_connected' }`.
   `status: 'revoked'` → `{ ok: false, reason: 'revoked' }`.
2. Si hay `accessTokenEnc` y faltan más de 60 segundos para
   `accessTokenExpiresAt`, lo descifra y lo devuelve.
3. Si no, refresca. Éxito → guarda el nuevo token cifrado y su expiración.
   `reason: 'revoked'` → marca la conexión `revoked`, guarda `lastError` y
   devuelve `{ ok: false, reason: 'revoked' }`. `reason: 'provider_error'`
   → devuelve `{ ok: false, reason: 'provider_error' }` sin apagar la
   conexión, porque es transitorio.

---

## 4. Cableado

### 4.1 `getSchedulingAvailability`

En `scheduling.service.ts`:

```ts
export type SchedulingAvailabilityResult =
  | { ok: true; slots: Array<{ index: number; startAt: string; endAt: string; label: string }> }
  | { ok: false; reason: 'not_connected' | 'revoked' | 'provider_error' | 'no_slots' };

export function getSchedulingAvailability(
  tenantId: string,
  unitId: string,
): Promise<SchedulingAvailabilityResult>;
```

1. `getUsableAccessToken(tenantId)`; si falla, devolver esa razón.
2. Leer o crear `SchedulingConfig` y validar `weeklyHours` con zod.
3. `from = ahora + minNoticeHours`, `to = ahora + maxAdvanceDays`.
4. `adapter.getBusy({ calendarIds: ['primary', showingsCalendarId], from, to })`.
   Si lanza → `provider_error`.
5. `computeAvailableSlots(...)`.
6. Tomar los primeros 6 y etiquetarlos. Cero huecos → `no_slots`.

El límite de 6 opciones se conserva del comportamiento actual: es lo que
cabe en un mensaje de chat sin abrumar.

`formatSlotLabel` sigue existiendo pero cambia de firma: hoy recibe un
`ShowMojoSlot` y anexa el nombre del broker entre paréntesis. Pasa a recibir
`{ startAt: string; timeZone: string }` y a formatear la fecha **en la zona
de la configuración**, no en la del servidor. El nombre del broker
desaparece de la etiqueta porque a nivel agencia hay un solo calendario y no
hay a quién nombrar; vuelve cuando llegue el por-broker.

### 4.2 `bookShowingFromCalendar`

```ts
export type BookShowingResult =
  | { ok: true; showingId: string; scheduledAt: string; googleEventId: string }
  | { ok: false; status: 404; error: 'unit_not_found' }
  | { ok: false; status: 409; error: 'slot_taken' | 'slot_no_longer_offered' | 'prospect_double_booked' }
  | { ok: false; status: 503; error: 'calendar_unavailable' };

export function bookShowingFromCalendar(input: {
  tenantId: string;
  unitId: string;
  leadId: string;
  startAt: Date;
  prospectName: string;
  prospectEmail?: string;
  prospectPhone?: string;
  conversationId?: string;
}): Promise<BookShowingResult>;
```

Orden de operaciones y su razón:

1. **Recalcular disponibilidad** y confirmar que `startAt` sigue entre los
   huecos ofrecidos. Los `pending_slots` guardados en la conversación
   pueden tener media hora de viejos. Si ya no está →
   `slot_no_longer_offered`.
2. **Crear el `Showing`** en una transacción, con
   `calendarSlotKey = "<ownerKey>:<startAt ISO>"`, `activeSlotKey` y
   `activeProspectSlotKey` como hoy; actualizar el lead a `tour_scheduled`.
   Un `P2002` sobre `calendarSlotKey` → `slot_taken`; sobre
   `activeProspectSlotKey` → `prospect_double_booked`. El `catch` se
   estrecha al código `P2002` y se inspecciona `meta.target` para
   distinguirlos; cualquier otro error se relanza.
3. **Crear el evento en Google**, con el prospecto como invitado si hay
   correo (`sendUpdates=all` para que Google le mande la invitación), y
   guardar `googleEventId` y `googleCalendarId` en el `Showing`.
4. **Si el paso 3 falla:** borrar el `Showing`, auditar
   `showing.calendar_event_failed` y devolver `calendar_unavailable`.

**Por qué la base antes que Google:** el `INSERT` es el paso que reserva el
hueco de forma atómica. Al revés, dos reservas simultáneas crearían ambas
su evento antes de chocar entre sí, y quedarían dos eventos en el
calendario del manager para el mismo horario.

Título del evento: `Showing — <nombre del prospecto> — <propiedad> · <unidad>`.
Descripción: teléfono y correo del prospecto, y el link al lead en la app.
`location`: la dirección de la propiedad.

### 4.3 Red de seguridad visible

La compensación del paso 4 también puede fallar (si el `DELETE` no pasa).
En vez de encadenar compensaciones, hay una regla visible que cubre todos
los modos de falla:

> La pantalla de Showings marca con advertencia cualquier showing en estado
> `scheduled` cuyo `googleEventId` sea nulo: **"sin bloquear en calendario"**.

Una regla, todos los casos, y el manager lo ve en vez de enterarse cuando
el prospecto llegue.

### 4.4 El chatbot

En `chatbot.service.ts`, el estado `scheduling`:

- Al entrar, llamar `getSchedulingAvailability`. Con `ok: true`, guardar
  `pending_slots` y ofrecer la lista, exactamente como hoy.
- Con `ok: false`, responder que un asesor confirmará el horario, pasar el
  estado de la conversación a `handoff` y registrar un `ConversationEvent`
  de tipo `showing.availability_unavailable` con la razón en el payload,
  para que el manager lo vea en Conversaciones. **No** crear ningún
  `Showing`. **No** consultar ShowMojo.
- Al elegir un número, llamar `bookShowingFromCalendar`. `ok: true` → el
  mensaje de confirmación actual. `slot_taken` o `slot_no_longer_offered` →
  volver a ofrecer la lista recalculada. Cualquier otro `ok: false` → el
  mismo camino de handoff.

**Consecuencia:** `deps.showmojo` deja de usarse dentro de
`handleInboundMessage` y sale de su firma. Eso quita el hilo del mock en
siete llamadas: `routes/chat.ts` (2), `routes/leads.ts` (1),
`routes/webhooks.ts` (2), `jobs/telegram-poller.ts` (1), más las dos
declaraciones de tipo en `chatbot.service.ts`. Los dos usos directos en
`routes/leads.ts` (`getAvailableSlots` y `scheduleTour` sobre el shortlist)
pasan a las funciones nuevas.

`ShowMojoAdapter` **se queda** en el factory y en los contratos, y el
webhook de entrada `POST /webhooks/showmojo` — que crea leads y no toca el
adapter — queda intacto. Solo se retira de la ruta de agendamiento.

Las funciones `scheduleTour` y `getAvailableSlots` se eliminan, junto con
las pruebas que solo existían para ejercitarlas contra el mock; sus dos
llamadores en `routes/leads.ts` pasan a `getSchedulingAvailability` y
`bookShowingFromCalendar`, mapeando el resultado discriminado a status HTTP
(`404`, `409`, `503`) en vez de dejar que un `throw` se vuelva 500.
`resolveShowingBooking`, que solo servía a `scheduleTour`, se elimina con
ella. `createManualShowingFromConversation`
(el agendado manual desde el panel) se conserva, y **también** crea el
evento en Google cuando hay conexión, con el mismo camino de compensación;
sin conexión sigue creando el `Showing` como hoy, porque ahí quien agenda
es una persona que ya sabe si tiene el hueco libre.

### 4.5 Cancelar

`cancelShowing` gana un paso: si hay `googleEventId`, borrar el evento en
Google (mejor esfuerzo, auditado tanto en éxito como en fallo) y limpiar
`calendarSlotKey` junto con `activeSlotKey` y `activeProspectSlotKey`, para
que el hueco vuelva a ofrecerse.

---

## 5. Interfaz

Una tarjeta **"Agenda y calendario"** arriba de `ShowingsPage`. Sin página
de ajustes nueva, igual que la Fase 3 metió la configuración contable en
`PropertiesPage`.

**Sin conectar:** explicación de una línea y botón *Conectar Google
Calendar*, que llama `POST /authorize` y navega a la URL devuelta.

**Conectada:** el correo de la cuenta, un botón *Desconectar* con
confirmación, y el editor de configuración: los siete días con sus rangos
(agregar y quitar), duración, colchón, aviso mínimo, ventana y granularidad.
Guardar valida contra las mismas reglas del servidor y muestra el error del
servidor si lo hay.

**Revocada:** aviso de que Google retiró el permiso, con el botón de
reconectar y el texto de `lastError`.

Solo el rol `property_manager` ve los botones de conectar, desconectar y
guardar; los demás ven la configuración en modo lectura.

En la tabla de showings, la advertencia de §4.3.

Al volver del callback, la página lee `?calendar=connected|error` de la URL
y muestra el aviso correspondiente.

---

## 6. Pruebas

**`packages/core`** — el motor puro, con los diez casos de §2.

**`packages/adapters`** — `GoogleCalendarRealAdapter` con `fetch` simulado,
siguiendo el patrón de `twilio.real.test.ts`: canje de código (incluida la
decodificación del `id_token`), refresco exitoso, `invalid_grant` →
`{ ok: false, reason: 'revoked' }`, error 500 de Google →
`{ ok: false, reason: 'provider_error' }`, `getBusy` sobre dos calendarios
que fusiona lo que devuelve cada uno, `createEvent` con y sin invitados,
`ensureShowingsCalendar` idempotente.

**`apps/api`** — contra la base real, como el resto de los servicios:

- Sin conexión → `not_connected`, y el bot responde handoff sin crear
  showings.
- Conexión `revoked` → `revoked`.
- Refresco que devuelve `invalid_grant` → la conexión queda `revoked` en la
  base.
- **Dos reservas concurrentes del mismo horario → exactamente un `Showing`**
  y el otro recibe `slot_taken`. Mismo test de carrera que el cierre de mes
  de la Fase 3.
- Fallo al crear el evento en Google → no queda ningún `Showing`.
- Cancelar → el evento se borra y `calendarSlotKey` queda nulo.
- El `state` del callback: firma inválida y expirado, ambos rechazados.

**Ruteo del chatbot** — sin calendario conectado: respuesta de handoff,
cero showings creados, y el mock de ShowMojo jamás invocado.

---

## 7. Preparación para el por-broker

Lo que esta fase deja listo para no re-arquitecturar después:

- `CalendarConnection.userId` y `ownerKey` ya soportan varias filas por
  tenant; la unique es sobre la pareja.
- `getBusy` recibe una **lista** de `calendarIds`, no uno.
- `calendarSlotKey` lleva el `ownerKey` como prefijo, así dos brokers pueden
  tener showings a la misma hora sin chocar.
- El adapter no guarda estado, así que servir a N conexiones no lo cambia.

Lo que faltará entonces: elegir qué broker atiende cada propiedad, resolver
a qué conexión pertenece cada hueco ofrecido, y una UI donde cada usuario
conecte su cuenta.

---

## 8. Documentación

`docs/GOOGLE_CALENDAR_SETUP.md`, al estilo de `docs/MESSENGER_SETUP.md`:
crear el proyecto en Google Cloud, habilitar la Calendar API, configurar la
pantalla de consentimiento con los tres scopes, crear las credenciales OAuth
de aplicación web, registrar la URI de redirección, y qué pegar en el `.env`.
Con la advertencia de que mientras la app esté en modo *Testing*, Google
caduca los refresh tokens a los siete días y hay que publicarla para
producción.

`docs/PRODUCT_ROADMAP.md` marca la §1.3 como entregada.
