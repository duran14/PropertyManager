# Fase 1.2 — Hand-off de IA a humano: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hacer que el estado `handoff` de `ChatConversation` realmente pause al bot (hoy no lo hace, en ninguno de los tres flujos que ya lo usan), agregar los dos disparadores automáticos que le faltaban (solicitud explícita del lead, fallo real de proveedor sin fallback), notificar al staff, y dar un camino para reanudar al bot que relee la conversación completa — incluidos los mensajes que el staff mandó a mano durante la pausa.

**Architecture:** Un guard temprano en `handleInboundMessageUnlocked` bloquea la respuesta automática cuando `state === 'handoff'`. Un helper de notificación compartido (extraído del que ya existe en Fase 2A) avisa al staff. Reanudar NO restaura un puntero de estado congelado — llama directo a los mismos `callGlm`/`callOwnershipGlm` que usa el turno normal, con un prompt sintético, para que el modelo decida desde el estado real de la conversación.

**Tech Stack:** TypeScript, Node 20, Express, Prisma + PostgreSQL, Zod, Vitest, React + Vite + TanStack Query. Cero dependencias nuevas.

**Spec:** [`docs/superpowers/specs/2026-08-12-fase-1-2-human-handoff-design.md`](../specs/2026-08-12-fase-1-2-human-handoff-design.md)

## Refinamiento respecto al spec — leer antes de empezar

La Sección 3.4 del spec sugería extraer una función `runConversationTurn` de
`handleInboundMessageUnlocked` (750 líneas, líneas 763-1509 de
`chatbot.service.ts`) para que el turno sintético de "reanudar" la
reutilizara. Al leer el código real para escribir este plan, esa función
resultó ser mucho más grande e intrincada de lo que el spec asumía —
docenas de ramas dependientes de `currentState` y del contenido crudo de
`input.body` (ej. `parseInt(input.body.trim(), 10)` para leer el número de
horario elegido en el estado `scheduling`), muchas de las cuales no tienen
sentido para un prompt sintético que no es un mensaje real del lead.

Extraerla completa habría sido el trabajo más grande y riesgoso de toda
esta fase, sobre una función que hoy ya tiene cobertura de pruebas extensa
que no se puede permitir romper.

En su lugar, la Tarea 6 usa un camino mucho más angosto y seguro:
`callGlm`/`callOwnershipGlm` **ya son funciones independientes**, llamables
directamente con un `history` explícito — no viven pegadas al resto de la
orquestación. `resumeBotFromHandoff` las llama directo, con un `history`
construido igual que siempre (`prepareConversationHistory`, ya reutilizable
tal cual) y un prompt sintético, y hace su propia persistencia mínima
(guardar el mensaje de salida, actualizar `state`, enviar). **No** vuelve a
correr la lógica de recomendaciones de unidades, resolución de shortlist,
ni el flujo de agendamiento — esas cosas ya vuelven a correr solas en el
próximo mensaje real del lead, una vez que el guard de pausa deja de
bloquearlo. El objetivo de "reanudar" es solo desatorar la conversación con
una respuesta contextual, no re-simular el turno completo.

Esto sí requiere un campo nuevo, `handoffPreState`, que el spec no
mencionaba — pero es una pieza técnica interna (qué `currentState` pasarle
a `callGlm`, ya que esa función lo exige como parámetro), no el "puntero
congelado" que el spec explícitamente rechazó. El estado real de la
conversación lo sigue decidiendo el modelo en cada turno, incluido este.

## Global Constraints

1. **Sin dependencias nuevas.**
2. **Errores por valor de retorno, no por excepción**, donde aplique — el
   manejador global de `apps/api/src/app.ts` convierte cualquier `throw` en
   500.
3. **Nunca reportar como hecho algo que no ocurrió** — si la notificación
   al staff falla, la pausa del bot y el mensaje de reconocimiento al lead
   deben sostenerse igual.
4. **Aislamiento por tenant.** Toda consulta filtra por `tenantId`.
5. **Notificaciones best-effort e independientes entre sí** — que falle un
   canal no debe impedir el otro, ni impedir la operación principal.
6. **El repo se queda verde.** No se commitea con una prueba en rojo.

### Seguridad de la base de datos

- **NUNCA** ejecutar `prisma migrate reset`, `prisma db push`, ni
  `migrate dev --force-reset`.
- **NUNCA** pasar `$DATABASE_URL` como `--shadow-database-url`.
- Si `prisma migrate dev` pide un reset, PARAR y reportar BLOCKED.
- Comando de migración:
  ```bash
  pnpm --filter @property-manager/api exec prisma migrate dev --name <nombre>
  ```

### Comandos de verificación

```bash
pnpm -r exec tsc --noEmit
pnpm --filter @property-manager/api test
pnpm --filter @property-manager/web test
```

### Convenciones del repo

- Comentarios en español explicando el **por qué**, código y nombres en
  inglés.
- Las pruebas de servicio corren contra Prisma real, con `cleanup()` en
  `beforeEach`/`afterEach` y un `TENANT_ID` propio del archivo.
- Los mensajes de respuesta del bot (`finalReply`, textos de UI) están en
  inglés — es el idioma real del producto, ver `OwnerStatementsPage.tsx`,
  `ShowingsPage.tsx`, y la corrección de idioma que tuvo que hacerse en
  Fase 1.3 cuando un componente nuevo salió en español por error.

---

## Estructura de archivos

**Crear:**

| Archivo | Responsabilidad |
|---|---|
| `apps/api/src/services/staff-notify.service.ts` | Resolución de destinatarios + envío multi-canal, extraído de Fase 2A |
| `apps/api/src/services/staff-notify.service.test.ts` | Pruebas movidas desde `rental-application.service.test.ts` + casos nuevos |

**Modificar:**

| Archivo | Cambio |
|---|---|
| `apps/api/prisma/schema.prisma` | `ChatConversation.handoffReason`, `.handoffNotifiedAt`, `.handoffPreState` |
| `apps/api/src/services/conversation-events.service.ts` | Nuevo `ConversationEventType`: `'handoff.resumed'` |
| `apps/api/src/services/rental-application.service.ts` | Usa el helper compartido en vez de su copia local |
| `apps/api/src/services/rental-application.service.test.ts` | Quita los 5 casos de `resolveApplicationNotifyTargets` (se mueven) |
| `apps/api/src/services/chatbot.service.ts` | Guard de pausa, `triggerHandoff`, `notifyStaffOfHandoff`, `resumeBotFromHandoff`, fix del filtro de rol `staff`, disparador de intent explícito, disparador de fallo de proveedor |
| `apps/api/src/services/chatbot.service.test.ts` | Pruebas del guard, `triggerHandoff`, `resumeBotFromHandoff` |
| `apps/api/src/services/chatbot.routing.test.ts` | Regresión: los dos disparadores nuevos de punta a punta |
| `apps/api/src/routes/chat.ts` | `POST /conversations/:id/resume`; la ruta manual existente usa `triggerHandoff` |
| `apps/api/src/routes/chat.test.ts` | Pruebas de la ruta nueva (crear si no existe un archivo de pruebas de rutas para `chat.ts`) |
| `apps/web/src/pages/ConversationsPage.tsx` | Deep link `?conversationId=`, franja de pausa + botón "Resume bot" |
| `docs/PRODUCT_ROADMAP.md` | Marca §1.2 entregada |

---

## Corrección post-Tarea 5 — leer antes de tocar las Tareas 6+

Las Tareas 1-5 de abajo ya están commiteadas y revisadas — se dejan tal
cual, son el registro real de lo que se construyó. Pero la revisión de la
Tarea 5 encontró que el diseño sobre el que se construyeron (el bot se
calla en cuanto `state === 'handoff'`) estaba mal: silencia, sin avisarle
a nadie, ~10 puntos que ya existían antes de esta fase y que le prometen
al lead que un humano lo va a contactar. El usuario corrigió el mecanismo
completo — ver **Sección 0 del spec**
(`docs/superpowers/specs/2026-08-12-fase-1-2-human-handoff-design.md`),
que ahora gobierna sobre las Secciones 1-8 originales del mismo documento.

Las Tareas 6, 7 y 8 originales de este plan (tal como aparecían antes de
esta corrección) **se reemplazan por completo** por las Tareas 6-9 nuevas
que siguen después de la Tarea 5. Resumen del cambio de mecánica:

- El guard de pausa deja de depender de `state === 'handoff'` y pasa a
  depender de un campo nuevo, `claimedByUserId` — nulo mientras nadie ha
  tomado control (el bot sigue respondiendo con normalidad), con valor
  una vez que un miembro del staff presiona explícitamente "Take control".
- `handoffPreState` (agregado en la Tarea 1) se retira — ya no hace falta,
  porque el bot nunca deja de correr mientras nadie ha tomado control, así
  que `conversation.state` sigue vivo y actualizado en todo momento.
- La notificación deja de usar la cascada de `resolveStaffNotifyTargets`
  (que se queda intacta para su otro consumidor, Fase 2A) y pasa a avisar
  a **todo** el staff activo con rol `property_manager`/`broker`.
- La ruta manual de pausa preexistente (`POST
  /conversations/:id/handoff`) se retira — "tomar control" la reemplaza
  por completo.
- Se extiende el disparo de aviso a los puntos que ya prometían un humano
  (calificación de compra/venta terminada, reagendar, cancelar, falla de
  agendamiento), corrigiendo su texto para que deje de prometer y avise.

## Task 1: Esquema — campos de handoff y tipo de evento nuevo

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/services/conversation-events.service.ts`
- Test: `apps/api/src/services/conversation-events.service.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `ChatConversation.handoffReason`, `.handoffNotifiedAt`,
  `.handoffPreState`; `ConversationEventType` gana `'handoff.resumed'`.

- [ ] **Step 1: Agregar los campos a `ChatConversation`**

En `apps/api/prisma/schema.prisma`, dentro de `model ChatConversation`,
junto a los demás campos opcionales:

```prisma
  // Fase 1.2: por qué está pausada la conversación. Null cuando no lo está.
  handoffReason      String?   // explicit_request | provider_failure | manual
  handoffNotifiedAt  DateTime?
  // El estado justo antes de pausar. Es una pieza técnica: al reanudar, se
  // usa como el `currentState` que exigen callGlm/callOwnershipGlm — el
  // modelo decide el estado real desde ahí, esto no es "dónde continuar
  // literalmente", solo el parámetro de entrada que la función necesita.
  handoffPreState    String?
```

- [ ] **Step 2: Generar la migración**

```bash
pnpm --filter @property-manager/api exec prisma migrate dev --name add_handoff_fields
```

Esperado: agrega tres columnas nullable a `chat_conversations`, ningún
`DROP`. Si pide un reset, parar y reportar BLOCKED.

- [ ] **Step 3: Agregar el tipo de evento nuevo**

En `apps/api/src/services/conversation-events.service.ts`, agregar al
union:

```ts
export type ConversationEventType =
  | 'lead.status_changed'
  | 'unit.recommended_overridden'
  | 'showing.scheduled'
  | 'showing.confirmed'
  | 'showing.cancelled'
  | 'showing.availability_unavailable'
  | 'staff.reply_sent'
  | 'handoff.requested'
  | 'handoff.resumed'
  | 'note.internal_added';
```

Y agregar el caso en `buildConversationEventPresentation`, junto al de
`'handoff.requested'`:

```ts
    case 'handoff.resumed':
      return {
        label: 'Bot resumed',
        detail: 'Staff re-enabled automated assistance',
        tone: 'done',
      };
```

- [ ] **Step 4: Escribir la prueba**

Buscar el archivo de pruebas de `conversation-events.service.ts` (si no
existe, crearlo siguiendo el patrón de cualquier otro archivo de pruebas de
servicio de este repo: Prisma real, `TENANT_ID` propio, `cleanup()`).
Agregar:

```ts
it('handoff.resumed se presenta con tono done', () => {
  const presentation = buildConversationEventPresentation('handoff.resumed', {});
  expect(presentation).toEqual({
    label: 'Bot resumed',
    detail: 'Staff re-enabled automated assistance',
    tone: 'done',
  });
});
```

- [ ] **Step 5: Correr y verificar**

```bash
pnpm --filter @property-manager/api test -- conversation-events
pnpm -r exec tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src/services/conversation-events.service.ts apps/api/src/services/conversation-events.service.test.ts
git commit -m "feat: schema y tipo de evento para pausar/reanudar el bot"
```

---

## Task 2: Helper compartido de notificación al staff

**Files:**
- Create: `apps/api/src/services/staff-notify.service.ts`
- Create: `apps/api/src/services/staff-notify.service.test.ts`
- Modify: `apps/api/src/services/rental-application.service.ts`
- Modify: `apps/api/src/services/rental-application.service.test.ts`

**Interfaces:**
- Consumes: nada de tareas previas.
- Produces:
  - `interface NotifiableStaff { id: string; email: string; notificationChannel: string | null; notificationAddress: string | null }`
  - `function resolveStaffNotifyTargets(input: { brokerUserId: string | null; assignedUserId: string | null; staff: NotifiableStaff[]; propertyManagerIds: string[] }): NotifiableStaff[]`
  - `function notifyStaffTargets(input: { targets: NotifiableStaff[]; subject: string; body: string; messaging: Record<ChatChannel, MessagingAdapter> }): Promise<void>`

Este es un refactor puro: mueve código que ya existe y ya está probado, sin
cambiar su comportamiento. `rental-application.service.ts` sigue pasando
exactamente las mismas pruebas que hoy.

- [ ] **Step 1: Crear el helper con el código movido**

Crear `apps/api/src/services/staff-notify.service.ts`:

```ts
/**
 * Notificación al staff, compartida entre cualquier flujo que necesite
 * avisarle a un humano (aplicaciones de renta recibidas, handoff del bot,
 * lo que siga). Resolución de destinatario y envío multi-canal, movidos
 * tal cual desde rental-application.service.ts (Fase 2A) para no
 * duplicarlos cuando Fase 1.2 necesitó el mismo patrón.
 */
import type { ChatChannel, MessagingAdapter } from '@property-manager/adapters';

export interface NotifiableStaff {
  id: string;
  email: string;
  notificationChannel: string | null;
  notificationAddress: string | null;
}

/**
 * A quién avisarle, en orden de cercanía: el broker de la visita si lo
 * hay, si no el dueño del lead, y si no todos los property managers del
 * tenant. Un id que ya no corresponde a ningún usuario (staff dado de
 * baja) cae al siguiente nivel en vez de dejar la notificación sin
 * destinatario.
 */
export function resolveStaffNotifyTargets(input: {
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

/**
 * Email siempre, más el canal preferido si existe y no es 'web' (mock
 * permanente que reporta éxito sin entregar nada) ni 'email' (ya se
 * mandó arriba, duplicaría el correo). Cada envío es independiente: que
 * falle uno no debe impedir el otro ni propagar al llamador.
 */
export async function notifyStaffTargets(input: {
  targets: NotifiableStaff[];
  subject: string;
  body: string;
  messaging: Record<ChatChannel, MessagingAdapter>;
}): Promise<void> {
  for (const target of input.targets) {
    try {
      await input.messaging.email.send({
        to: target.email,
        body: input.body,
        channel: 'email',
        subject: input.subject,
      });
    } catch (error) {
      console.error(`[StaffNotify] Email a ${target.id} falló:`, error);
    }

    if (
      target.notificationChannel &&
      target.notificationAddress &&
      target.notificationChannel !== 'web' &&
      target.notificationChannel !== 'email'
    ) {
      try {
        const channel = target.notificationChannel as ChatChannel;
        await input.messaging[channel].send({ to: target.notificationAddress, body: input.body, channel });
      } catch (error) {
        console.error(`[StaffNotify] Chat a ${target.id} falló:`, error);
      }
    }
  }
}
```

- [ ] **Step 2: Mover las pruebas de `resolveApplicationNotifyTargets`**

Crear `apps/api/src/services/staff-notify.service.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ChatChannel, MessagingAdapter, OutboundMessage } from '@property-manager/adapters';
import { notifyStaffTargets, resolveStaffNotifyTargets, type NotifiableStaff } from './staff-notify.service.js';

describe('resolveStaffNotifyTargets', () => {
  const broker: NotifiableStaff = { id: 'u_broker', email: 'broker@test.ca', notificationChannel: null, notificationAddress: null };
  const assignee: NotifiableStaff = { id: 'u_assignee', email: 'assignee@test.ca', notificationChannel: null, notificationAddress: null };
  const pmA: NotifiableStaff = { id: 'u_pm_a', email: 'pma@test.ca', notificationChannel: null, notificationAddress: null };
  const pmB: NotifiableStaff = { id: 'u_pm_b', email: 'pmb@test.ca', notificationChannel: null, notificationAddress: null };
  const staff = [broker, assignee, pmA, pmB];

  it('prefers the broker over everyone else', () => {
    expect(resolveStaffNotifyTargets({
      brokerUserId: 'u_broker',
      assignedUserId: 'u_assignee',
      staff,
      propertyManagerIds: ['u_pm_a', 'u_pm_b'],
    })).toEqual([broker]);
  });

  it('falls back to the assignee when there is no broker', () => {
    expect(resolveStaffNotifyTargets({
      brokerUserId: null,
      assignedUserId: 'u_assignee',
      staff,
      propertyManagerIds: ['u_pm_a', 'u_pm_b'],
    })).toEqual([assignee]);
  });

  it('falls back to every property manager when there is neither broker nor assignee', () => {
    expect(resolveStaffNotifyTargets({
      brokerUserId: null,
      assignedUserId: null,
      staff,
      propertyManagerIds: ['u_pm_a', 'u_pm_b'],
    })).toEqual([pmA, pmB]);
  });

  it('skips an id that does not resolve to a known staff member', () => {
    expect(resolveStaffNotifyTargets({
      brokerUserId: 'u_deleted',
      assignedUserId: 'u_assignee',
      staff,
      propertyManagerIds: ['u_pm_a'],
    })).toEqual([assignee]);
  });

  it('returns an empty list when nothing resolves', () => {
    expect(resolveStaffNotifyTargets({
      brokerUserId: null,
      assignedUserId: null,
      staff: [],
      propertyManagerIds: [],
    })).toEqual([]);
  });
});

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
  return {
    sent,
    messaging: { telegram: adapter, web: adapter, email: adapter } as unknown as Record<ChatChannel, MessagingAdapter>,
  };
}

describe('notifyStaffTargets', () => {
  it('sends by email and by the preferred chat channel independently', async () => {
    const { sent, messaging } = fakeMessaging();
    const target: NotifiableStaff = {
      id: 'u_1', email: 'pm@test.ca', notificationChannel: 'telegram', notificationAddress: '900200',
    };

    await notifyStaffTargets({ targets: [target], subject: 'Subject', body: 'Body', messaging });

    expect(sent).toHaveLength(2);
    expect(sent.map((m) => m.channel)).toEqual(expect.arrayContaining(['email', 'telegram']));
  });

  it('skips the chat channel when it is web or email', async () => {
    const { sent, messaging } = fakeMessaging();
    const target: NotifiableStaff = {
      id: 'u_1', email: 'pm@test.ca', notificationChannel: 'web', notificationAddress: 'conv_1',
    };

    await notifyStaffTargets({ targets: [target], subject: 'Subject', body: 'Body', messaging });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe('email');
  });

  it('never throws, even if every channel fails', async () => {
    const { messaging } = fakeMessaging({ shouldFail: true });
    const target: NotifiableStaff = {
      id: 'u_1', email: 'pm@test.ca', notificationChannel: 'telegram', notificationAddress: '900200',
    };

    await expect(notifyStaffTargets({ targets: [target], subject: 'Subject', body: 'Body', messaging })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/api test -- staff-notify
```

- [ ] **Step 4: Actualizar `rental-application.service.ts` para usar el helper**

Quitar de `rental-application.service.ts`: la `interface NotifiableStaff`,
la función `resolveApplicationNotifyTargets`, y el bucle `for (const target
of targets)` dentro de `notifyStaffOfApplication` (el que hace los dos
`try/catch` de email y chat). Importar y usar el helper:

```ts
import { notifyStaffTargets, resolveStaffNotifyTargets } from './staff-notify.service.js';
```

`notifyStaffOfApplication` pasa a:

```ts
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
    const targets = resolveStaffNotifyTargets({
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

    await notifyStaffTargets({
      targets,
      subject: 'New rental application',
      body: `New rental application received from ${application.applicantFullName ?? 'a prospect'}.`,
      messaging: deps.messaging,
    });
  } catch (error) {
    console.error(`[RentalApplication] No se pudo notificar la aplicación ${applicationId}:`, error);
  }
}
```

- [ ] **Step 5: Actualizar el archivo de pruebas de `rental-application.service.ts`**

Quitar el `describe('resolveApplicationNotifyTargets', ...)` completo (ya
se movió) y su import. Los demás describe blocks (`'rental application
invitations'`, `'completeShowingAndInvite'`, `'submitRentalApplication'`)
no cambian.

- [ ] **Step 6: Correr toda la suite y verificar**

```bash
pnpm --filter @property-manager/api test
pnpm -r exec tsc --noEmit
```

Esperado: todo verde, sin diferencia en el conteo total de pruebas de
`rental-application.service.test.ts` menos los 5 casos movidos, más los 8
casos nuevos en `staff-notify.service.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/staff-notify.service.ts apps/api/src/services/staff-notify.service.test.ts apps/api/src/services/rental-application.service.ts apps/api/src/services/rental-application.service.test.ts
git commit -m "refactor: extraer helper compartido de notificación al staff"
```

---

## Task 3: El guard de pausa

**Files:**
- Modify: `apps/api/src/services/chatbot.service.ts`
- Test: `apps/api/src/services/chatbot.service.test.ts`

**Interfaces:**
- Consumes: nada de tareas previas (usa `BotReply`, ya existente).
- Produces: el guard temprano en `handleInboundMessageUnlocked`.

- [ ] **Step 1: Escribir la prueba que falla**

En `apps/api/src/services/chatbot.service.test.ts`, buscar cómo ese
archivo construye una conversación de prueba en un estado dado (o seguir
el patrón de `chatbot.routing.test.ts` si es más directo — usar el que
exista en el archivo elegido). Agregar:

```ts
it('no responde ni llama a GLM cuando la conversación está en handoff', async () => {
  const conversation = await prisma.chatConversation.create({
    data: {
      tenantId: TENANT_ID,
      externalId: 'web:handoff-guard-1',
      channel: 'web',
      state: 'handoff',
      handoffReason: 'manual',
    },
  });

  const reason = vi.fn();
  const glm = { name: 'glm', reason, extractReceipt: vi.fn() } as unknown as GlmAdapter;
  const send = vi.fn(async () => ({ messageId: 'm1' }));
  const messaging = { channel: 'web', send, parseWebhook: vi.fn() } as unknown as MessagingAdapter;

  const reply = await handleInboundMessage(
    { tenantId: TENANT_ID, from: 'web:handoff-guard-1', body: 'hello?', channel: 'web' },
    { glm, messaging },
  );

  expect(reason).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(reply.replyText).toBe('');
  expect(reply.newState).toBe('handoff');

  const messages = await prisma.chatMessage.findMany({ where: { conversationId: conversation.id } });
  expect(messages).toHaveLength(1);
  expect(messages[0]!.role).toBe('user');
  expect(messages[0]!.content).toBe('hello?');
});
```

Ajustar el nombre exacto del `TENANT_ID`/helpers de limpieza al patrón que
ya use ese archivo — no inventar un tenant nuevo si el archivo ya tiene uno
consistente para sus pruebas.

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/api test -- chatbot.service
```

Esperado: FAIL — hoy el bot sí llama a GLM y sí responde.

- [ ] **Step 3: Implementar el guard**

En `apps/api/src/services/chatbot.service.ts`, dentro de
`handleInboundMessageUnlocked`, inmediatamente después del bloque de
detección de opt-out (línea ~812, justo antes de `// /start (Telegram)
significa...`) y **antes** de calcular `isStartCommand`/`conversationState`
para el resto de la lógica — el guard debe correr con el `state` tal como
viene de la fila recién leída, sin ningún ajuste:

```ts
  // Fase 1.2: si la conversación está pausada para un humano, el bot no
  // responde. El mensaje del lead ya quedó guardado arriba — el staff lo
  // ve como cualquier otro — pero no se llama a GLM ni al motor
  // determinístico, y no se envía nada por el canal del lead.
  if (conversation.state === 'handoff') {
    return { replyText: '', newState: 'handoff', leadCreated: false, handoff: true };
  }
```

Nota: se usa `conversation.state` (el valor recién leído del `upsert` de
arriba), no una variable derivada, porque este guard debe correr antes de
cualquier lógica de `/start` o de la máquina de estados normal.

- [ ] **Step 4: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/api test -- chatbot.service
```

- [ ] **Step 5: Regresión completa de chatbot**

```bash
pnpm --filter @property-manager/api test -- chatbot
```

Esperado: verde — este guard no debe afectar ningún turno normal (solo
dispara cuando `state` ya es `'handoff'` al entrar, y hoy nada deja el
estado en `'handoff'` de forma persistente antes de un turno posterior
salvo los tres flujos que el spec documenta).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/chatbot.service.ts apps/api/src/services/chatbot.service.test.ts
git commit -m "fix: el bot deja de responder cuando la conversación está en handoff"
```

---

## Task 4: Fix del filtro de contexto — el modelo deja de ignorar al staff

**Files:**
- Modify: `apps/api/src/services/chatbot.service.ts`
- Test: `apps/api/src/services/chatbot.service.test.ts`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `callGlm`/`callOwnershipGlm` incluyen mensajes `role: 'staff'`
  en el historial que le pasan al modelo.

- [ ] **Step 1: Escribir la prueba que falla**

```ts
it('el contexto que recibe el modelo incluye las respuestas del staff', async () => {
  const conversation = await prisma.chatConversation.create({
    data: {
      tenantId: TENANT_ID,
      externalId: 'web:staff-context-1',
      channel: 'web',
      state: 'proposing_tour',
      slots: { create: [{ key: 'transaction_intent', value: 'rent' }] },
      messages: {
        create: [
          { role: 'user', content: 'Is the unit still available?' },
          { role: 'staff', content: 'Yes, still available — I can hold it for you.' },
        ],
      },
    },
  });

  let capturedPrompt = '';
  const reason = vi.fn(async (request: GlmReasoningRequest) => {
    capturedPrompt = request.systemPrompt;
    return { content: JSON.stringify({ intent: 'other', confidence: 'high', reply: 'ok', profile: { set: {}, clear: [] } }) };
  });
  const glm = { name: 'glm', reason, extractReceipt: vi.fn() } as unknown as GlmAdapter;
  const send = vi.fn(async () => ({ messageId: 'm1' }));
  const messaging = { channel: 'web', send, parseWebhook: vi.fn() } as unknown as MessagingAdapter;

  await handleInboundMessage(
    { tenantId: TENANT_ID, from: 'web:staff-context-1', body: 'ok thanks', channel: 'web' },
    { glm, messaging },
  );

  expect(capturedPrompt).toContain('still available — I can hold it');
});
```

`buildRentalConversationPrompt` (en `rental-conversation.interpreter.ts`)
serializa `context.history` con `JSON.stringify` dentro del `systemPrompt`
que le pasa a `glm.reason()` — la aserción sobre `request.systemPrompt` de
arriba es correcta tal cual, no hace falta ajustar nada.

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/api test -- chatbot.service
```

Esperado: FAIL — el mensaje de staff no llega al prompt.

- [ ] **Step 3: Ampliar el filtro en los dos puntos**

En `apps/api/src/services/chatbot.service.ts`, dentro de `callGlm`
(línea ~1533-1536):

```ts
  const history = ctx.history
    .slice(-10)
    .filter((message): message is { role: 'user' | 'assistant' | 'staff'; content: string } =>
      message.role === 'user' || message.role === 'assistant' || message.role === 'staff')
    .map((message) => ({
      // El lead ve un mensaje de staff igual que uno del bot: ambos son
      // "lo que la agencia respondió". No se inventa un tercer rol para
      // el prompt del modelo.
      role: message.role === 'staff' ? 'assistant' : message.role,
      content: message.content,
    }));
```

Y el mismo cambio, con el mismo comentario, dentro de `callOwnershipGlm`
(línea ~1666-1669).

**Importante:** verificar el tipo real que consume
`buildRentalConversationPrompt`/`buildOwnershipConversationPrompt` para
`history` (probablemente `Array<{ role: 'user' | 'assistant'; content:
string }>`) — el `.map` de arriba garantiza que después del filtro solo
queden esos dos valores de `role`, así que el tipo de salida sigue siendo
compatible sin cambiar la firma de esas funciones de construcción de
prompt.

- [ ] **Step 4: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/api test -- chatbot.service
pnpm -r exec tsc --noEmit
```

- [ ] **Step 5: Regresión completa**

```bash
pnpm --filter @property-manager/api test -- chatbot
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/chatbot.service.ts apps/api/src/services/chatbot.service.test.ts
git commit -m "fix: el modelo ya ve los mensajes que el staff manda a mano"
```

---

## Task 5: `triggerHandoff`, `notifyStaffOfHandoff`, y los dos disparadores

**Files:**
- Modify: `apps/api/src/services/chatbot.service.ts`
- Test: `apps/api/src/services/chatbot.service.test.ts`
- Test: `apps/api/src/services/chatbot.routing.test.ts`

**Interfaces:**
- Consumes: `resolveStaffNotifyTargets`/`notifyStaffTargets` (Tarea 2);
  `createConversationEvent` con `'handoff.requested'` (ya existente);
  `getAdapters()` (patrón ya usado en todo el archivo vía
  `await import('../config/adapters.js')`).
- Produces:
  - `async function triggerHandoff(input: { tenantId: string; conversation: { id: string; leadId: string | null }; reason: 'explicit_request' | 'provider_failure' | 'manual'; preState: ConversationState }): Promise<{ acknowledgement: string }>`
  - Constante `HANDOFF_ACKNOWLEDGEMENT: string`
  - `InterpretedTurn` gana el campo opcional `handoffReason?: 'explicit_request' | 'provider_failure'`

- [ ] **Step 1: Escribir las pruebas que fallan**

En `apps/api/src/services/chatbot.service.test.ts`:

```ts
describe('triggerHandoff', () => {
  it('deja handoffReason, un evento, y notifica al staff cuando no es manual', async () => {
    const tenant = await prisma.tenant.upsert({
      where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: 'Handoff Test', province: 'BC' },
    });
    const pm = await prisma.user.create({
      data: {
        tenantId: TENANT_ID, email: `pm-${TENANT_ID}@test.ca`, passwordHash: 'x',
        firstName: 'Pat', lastName: 'Manager', role: 'property_manager',
        notificationChannel: 'telegram', notificationAddress: '900300',
      },
    });
    const lead = await prisma.lead.create({
      data: { tenantId: TENANT_ID, name: 'Ana', phone: '+16045550111', status: 'contacted' },
    });
    const conversation = await prisma.chatConversation.create({
      data: { tenantId: TENANT_ID, externalId: 'web:trigger-1', channel: 'web', state: 'proposing_tour', leadId: lead.id },
    });

    const result = await triggerHandoff({
      tenantId: TENANT_ID,
      conversation: { id: conversation.id, leadId: lead.id },
      reason: 'explicit_request',
      preState: 'proposing_tour',
    });

    expect(result.acknowledgement).toContain('team');

    const row = await prisma.chatConversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(row.handoffReason).toBe('explicit_request');
    expect(row.handoffPreState).toBe('proposing_tour');
    expect(row.handoffNotifiedAt).not.toBeNull();

    const events = await prisma.conversationEvent.findMany({ where: { tenantId: TENANT_ID, conversationId: conversation.id, type: 'handoff.requested' } });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { reason?: string }).reason).toBe('explicit_request');
  });

  it('no notifica cuando reason es manual', async () => {
    // seed similar al anterior, reason: 'manual'
    // espiar getAdapters().messaging.email.send y confirmar que no se llamó
  });

  it('no vuelve a notificar en un segundo trigger dentro del mismo episodio', async () => {
    // llamar triggerHandoff dos veces sobre la misma conversación con
    // handoffNotifiedAt ya seteado por la primera; el segundo envío por
    // messaging no debe dispararse otra vez — verificar contando llamadas
    // al spy de notifyStaffTargets o al adapter de mensajería.
  });
});
```

Completar los dos casos con seeds análogos al primero, usando `vi.spyOn`
sobre `getAdapters().messaging.email` o inyectando un mensajero falso —
seguir el patrón de espiado ya usado en `chatbot.routing.test.ts` con
`glmReturning`.

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/api test -- chatbot.service
```

Esperado: FAIL — `triggerHandoff` no existe.

- [ ] **Step 3: Implementar `triggerHandoff` y `notifyStaffOfHandoff`**

En `apps/api/src/services/chatbot.service.ts`, agregar (junto a las demás
funciones auxiliares del archivo, cerca de `handOffScheduling` que ya
existe de Fase 1.3 y es el precedente directo de este patrón):

```ts
const HANDOFF_ACKNOWLEDGEMENT =
  "I'll get someone from our team to help you with that — they'll follow up right here.";

async function triggerHandoff(input: {
  tenantId: string;
  conversation: { id: string; leadId: string | null };
  reason: 'explicit_request' | 'provider_failure' | 'manual';
  preState: ConversationState;
}): Promise<{ acknowledgement: string }> {
  await prisma.chatConversation.update({
    where: { id: input.conversation.id },
    data: { handoffReason: input.reason, handoffPreState: input.preState },
  });

  await createConversationEvent({
    tenantId: input.tenantId,
    conversationId: input.conversation.id,
    leadId: input.conversation.leadId,
    type: 'handoff.requested',
    payload: { reason: input.reason },
  });

  if (input.reason !== 'manual') {
    await notifyStaffOfHandoff({
      tenantId: input.tenantId,
      conversationId: input.conversation.id,
      leadId: input.conversation.leadId,
      reason: input.reason,
    });
    await prisma.chatConversation.update({
      where: { id: input.conversation.id },
      data: { handoffNotifiedAt: new Date() },
    });
  }

  return { acknowledgement: HANDOFF_ACKNOWLEDGEMENT };
}

/**
 * Best-effort, igual que notifyStaffOfApplication (Fase 2A): la pausa del
 * bot y el mensaje al lead ya se sostienen sin depender de que esto
 * funcione. Un fallo aquí se loguea y nunca se propaga.
 */
async function notifyStaffOfHandoff(input: {
  tenantId: string;
  conversationId: string;
  leadId: string | null;
  reason: 'explicit_request' | 'provider_failure';
}): Promise<void> {
  try {
    const lead = input.leadId
      ? await prisma.lead.findUnique({ where: { id: input.leadId }, select: { assignedUserId: true, name: true } })
      : null;
    const staff = await prisma.user.findMany({
      where: { tenantId: input.tenantId, isActive: true },
      select: { id: true, email: true, role: true, notificationChannel: true, notificationAddress: true },
    });
    const targets = resolveStaffNotifyTargets({
      brokerUserId: null,
      assignedUserId: lead?.assignedUserId ?? null,
      staff,
      propertyManagerIds: staff.filter((m) => m.role === 'property_manager').map((m) => m.id),
    });

    const reasonText = input.reason === 'explicit_request'
      ? 'asked to speak with a person'
      : 'ran into a problem our assistant could not resolve on its own';
    const env = getEnv();
    const link = `${env.WEB_URL}/conversations?conversationId=${input.conversationId}`;
    const body = `${lead?.name ?? 'A lead'} ${reasonText} and needs a reply.\n\n${link}`;

    const { getAdapters } = await import('../config/adapters.js');
    await notifyStaffTargets({
      targets,
      subject: 'A conversation needs your attention',
      body,
      messaging: getAdapters().messaging,
    });
  } catch (error) {
    console.error(`[Handoff] No se pudo notificar la conversación ${input.conversationId}:`, error);
  }
}
```

Agregar los imports que falten al inicio del archivo:

```ts
import { resolveStaffNotifyTargets, notifyStaffTargets } from './staff-notify.service.js';
```

(`getEnv` ya debe estar importado en el archivo — verificar; si no,
agregarlo desde `../config/env.js`).

- [ ] **Step 4: Cablear el disparador de intent explícito**

En `handleInboundMessageUnlocked`, el bloque (línea ~998-1004):

```ts
  if (glmResult.intent === 'request_matches' || glmResult.intent === 'request_more_options') {
    glmResult.next_state = 'proposing_tour';
  } else if (glmResult.intent === 'schedule_tour') {
    glmResult.next_state = 'scheduling';
  } else if (glmResult.intent === 'handoff') {
    glmResult.next_state = 'handoff';
  }
```

pasa a:

```ts
  if (glmResult.intent === 'request_matches' || glmResult.intent === 'request_more_options') {
    glmResult.next_state = 'proposing_tour';
  } else if (glmResult.intent === 'schedule_tour') {
    glmResult.next_state = 'scheduling';
  } else if (glmResult.intent === 'handoff') {
    glmResult.next_state = 'handoff';
    glmResult.handoffReason = glmResult.handoffReason ?? 'explicit_request';
  }
```

(el `?? 'explicit_request'` respeta el caso de la Tarea 6, donde el fallo
de proveedor ya deja `handoffReason: 'provider_failure'` en `glmResult`
antes de llegar aquí — no lo pisa).

Más abajo en la misma función, justo después del bloque que actualiza
`prisma.chatConversation.update({ data: { state: newState, ... } })`
(línea ~1359-1362) y antes de crear el `assistantMessage`, agregar:

```ts
  if (newState === 'handoff' && glmResult.handoffReason) {
    const { acknowledgement } = await triggerHandoff({
      tenantId: input.tenantId,
      conversation: { id: conversation.id, leadId: conversation.leadId },
      reason: glmResult.handoffReason,
      preState: currentState,
    });
    finalReply = acknowledgement;
  }
```

Este bloque debe ir **antes** de la línea `const assistantMessage = await
prisma.chatMessage.create({ data: { ..., content: finalReply, ... } })`,
para que el mensaje persistido y enviado sea ya el de reconocimiento, no
el `glmResult.reply` original del modelo.

- [ ] **Step 5: Agregar `handoffReason` a `InterpretedTurn`**

Buscar la definición de `InterpretedTurn` (usada como tipo de `glmResult`)
y agregar el campo opcional:

```ts
  handoffReason?: 'explicit_request' | 'provider_failure';
```

- [ ] **Step 6: Cablear el disparador de fallo de proveedor**

En las dos ramas `providerFailed` (línea ~1583-1590 para renta, ~1696-1698
para ownership — buscar el texto exacto en el archivo real, puede haberse
movido unas líneas por los cambios de la Tarea 4):

```ts
  if (providerFailed) {
    if (deterministicFallback) return deterministicFallback;
    return {
      reply: turn.reply,
      intent: 'ask_clarification',
      next_state: currentState,
    };
  }
```

pasa a:

```ts
  if (providerFailed) {
    if (deterministicFallback) return deterministicFallback;
    return {
      reply: turn.reply,
      intent: 'handoff',
      next_state: 'handoff',
      handoffReason: 'provider_failure',
    };
  }
```

**Repetir el mismo cambio en las dos ramas** (rental y ownership) — son
funciones distintas con el mismo cuerpo, no una sola.

- [ ] **Step 7: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/api test -- chatbot.service
```

- [ ] **Step 8: Prueba de regresión de punta a punta**

En `apps/api/src/services/chatbot.routing.test.ts`, agregar (siguiendo el
patrón de `seedConversationWithSlots`/`glmReturning`/`throwingGlm` que ya
tiene ese archivo):

```ts
it('un intent handoff explícito pausa el bot y notifica al staff', async () => {
  await seedTenant();
  const pm = await prisma.user.create({
    data: {
      tenantId: TENANT_ID, email: `pm-handoff-${TENANT_ID}@test.ca`, passwordHash: 'x',
      firstName: 'Pat', lastName: 'Manager', role: 'property_manager',
    },
  });
  const conversation = await seedConversationWithSlots('web:handoff-explicit', 'proposing_tour', {
    transaction_intent: 'rent',
  });
  const { glm } = glmReturning(JSON.stringify({
    intent: 'handoff', confidence: 'high', reply: 'Let me get someone.',
    profile: { set: {}, clear: [] },
  }));

  const reply = await handleInboundMessage(
    { tenantId: TENANT_ID, from: 'web:handoff-explicit', body: 'I want to talk to a person', channel: 'web' },
    { glm, messaging: new WebChatMockAdapter() },
  );

  expect(reply.newState).toBe('handoff');
  expect(reply.replyText).toContain('team');
  const row = await prisma.chatConversation.findUniqueOrThrow({ where: { id: conversation.id } });
  expect(row.handoffReason).toBe('explicit_request');
  expect(row.handoffNotifiedAt).not.toBeNull();
});

it('un fallo real de proveedor sin fallback determinístico pausa el bot', async () => {
  await seedTenant();
  await prisma.user.create({
    data: {
      tenantId: TENANT_ID, email: `pm-outage-${TENANT_ID}@test.ca`, passwordHash: 'x',
      firstName: 'Pat', lastName: 'Manager', role: 'property_manager',
    },
  });
  // Una conversación NUEVA (sin transaction_intent todavía) es el único
  // caso realista donde no hay fallback determinístico: una vez que
  // transaction_intent ya se conoce, buildGlmFallback SIEMPRE devuelve algo
  // (su rama final "I'm still with you..." cubre cualquier otro estado) y
  // buildOwnershipConversationTurn también siempre devuelve algo (cae a
  // buyerTurn/sellerTurn, que terminan en un mensaje catch-all). El único
  // hueco real es buildFastQualificationTurn cuando el primer mensaje es
  // rico en señales de renta (>2 palabras, con palabras como "bedroom",
  // "budget", etc.) y no es un saludo corto — devuelve undefined a
  // propósito (chatbot.service.ts:2061-2062) para que ese mensaje pase al
  // modelo en vez de recibir el saludo genérico.
  const { glm } = throwingGlm();

  const reply = await handleInboundMessage(
    {
      tenantId: TENANT_ID,
      from: 'web:handoff-outage',
      body: 'Hi, looking for a 2 bedroom apartment near Kelowna, budget around $2000, pet friendly please',
      channel: 'web',
    },
    { glm, messaging: new WebChatMockAdapter() },
  );

  expect(reply.newState).toBe('handoff');
  const conversation = await prisma.chatConversation.findFirstOrThrow({
    where: { tenantId: TENANT_ID, externalId: 'web:handoff-outage' },
  });
  expect(conversation.handoffReason).toBe('provider_failure');
});
```

- [ ] **Step 9: Correr y verificar**

```bash
pnpm --filter @property-manager/api test -- chatbot
pnpm -r exec tsc --noEmit
```

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/chatbot.service.ts apps/api/src/services/chatbot.service.test.ts apps/api/src/services/chatbot.routing.test.ts
git commit -m "feat: disparadores automáticos de handoff con notificación al staff"
```

---

## Task 6: Migración de campos, guard de "tomar control", notificación a todo el staff

**Contexto real (ya commiteado, verificado línea por línea antes de escribir
esta tarea):** el guard de pausa vive en
`apps/api/src/services/chatbot.service.ts:824-826`:

```ts
  if (conversation.state === 'handoff') {
    return { replyText: '', newState: 'handoff', leadCreated: false, handoff: true };
  }
```

`triggerHandoff` (exportado, `:3674-3718`) ya escribe
`handoffPreState: input.preState` y ya trae el guard de idempotencia de
notificación (`existing.handoffNotifiedAt`) que la revisión de la Tarea 5
agregó sobre el diseño original del plan. `notifyStaffOfHandoff`
(`:3725-3763`) hoy resuelve destinatarios con `resolveStaffNotifyTargets`
(la cascada broker → dueño del lead → todos los PM). `HANDOFF_ACKNOWLEDGEMENT`
(`:3665-3667`) hoy dice *"I'll get someone from our team to help you with
that — they'll follow up right here."*

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/services/chatbot.service.ts`
- Modify: `apps/api/src/services/conversation-events.service.ts`
- Test: `apps/api/src/services/chatbot.service.test.ts`
- Test: `apps/api/src/services/chatbot.routing.test.ts`
- Test: `apps/api/src/services/conversation-events.service.test.ts`

**Interfaces:**
- Consumes: `notifyStaffTargets` (Tarea 2) — se sigue usando tal cual, solo
  cambia quién llega en `targets`.
- Produces: `triggerHandoff`/`notifyStaffOfHandoff` con la misma firma
  pública que ya tienen (sin cambios de tipo); el guard de pausa revisado.

- [ ] **Step 1: Migración — retirar `handoffPreState`, agregar `claimedByUserId`/`claimedAt`**

En `apps/api/prisma/schema.prisma`, dentro de `model ChatConversation`,
reemplazar:

```prisma
  handoffReason      String?
  handoffNotifiedAt  DateTime?
  handoffPreState    String?
```

por:

```prisma
  handoffReason      String?   // explicit_request | provider_failure | manual | follow_up_needed
  handoffNotifiedAt  DateTime?
  // Quién tomó control de la conversación. Nulo mientras nadie lo ha
  // hecho — el bot sigue respondiendo con normalidad; no se apaga solo
  // porque handoffReason esté puesto. Ver spec Sección 0.
  claimedByUserId    String?
  claimedAt          DateTime?

  claimedByUser User? @relation("ConversationClaimedBy", fields: [claimedByUserId], references: [id])
```

Y en `model User`, junto a `assignedLeads`, agregar la relación inversa:

```prisma
  claimedConversations ChatConversation[] @relation("ConversationClaimedBy")
```

Correr:

```bash
pnpm --filter @property-manager/api exec prisma migrate dev --name add_conversation_claim
```

Esperado: elimina la columna `handoffPreState` y agrega `claimedByUserId`
(con su FK) y `claimedAt`. Confirmar que la migración generada NO borra
`handoffReason` ni `handoffNotifiedAt` — esas se quedan igual.

- [ ] **Step 2: Nuevo tipo de evento `handoff.claimed`**

En `apps/api/src/services/conversation-events.service.ts`, agregar al
union:

```ts
  | 'handoff.claimed'
```

Y el caso en `buildConversationEventPresentation`:

```ts
    case 'handoff.claimed':
      return {
        label: 'Staff took control',
        detail: formatText(payload.claimedByName) ?? 'A staff member took over this conversation',
        tone: 'active',
      };
```

Prueba (en `conversation-events.service.test.ts`, siguiendo el patrón del
caso `handoff.resumed` que ya existe ahí):

```ts
it('handoff.claimed se presenta con tono active', () => {
  const presentation = buildConversationEventPresentation('handoff.claimed', {});
  expect(presentation).toEqual({
    label: 'Staff took control',
    detail: 'A staff member took over this conversation',
    tone: 'active',
  });
});
```

- [ ] **Step 3: Reescribir el guard de pausa**

En `chatbot.service.ts:824-826`, reemplazar:

```ts
  if (conversation.state === 'handoff') {
    return { replyText: '', newState: 'handoff', leadCreated: false, handoff: true };
  }
```

por:

```ts
  // Fase 1.2 (corregido): el bot NO se apaga solo porque haya pedido
  // ayuda humana — sigue respondiendo mientras nadie ha tomado control.
  // Solo un humano que presiona explícitamente "Take control" (la ruta
  // /claim) apaga al bot. Ver spec Sección 0.
  if (conversation.claimedByUserId) {
    return {
      replyText: '',
      newState: conversation.state as ConversationState,
      leadCreated: false,
      handoff: true,
    };
  }
```

Actualizar el comentario que queda arriba de este bloque (el que hoy dice
"si la conversación está pausada para un humano, el bot no responde") para
reflejar que la condición es `claimedByUserId`, no `state`.

- [ ] **Step 4: Escribir la prueba que falla para el guard nuevo**

En `chatbot.routing.test.ts`, junto a la prueba existente "sin calendario
conectado no ofrece horarios..." (que sigue vigente sin cambios), agregar
dos casos:

```ts
it('el bot SIGUE respondiendo si hay handoffReason pero nadie ha tomado control', async () => {
  const conversation = await prisma.chatConversation.create({
    data: {
      tenantId: TENANT_ID, externalId: 'web:pending-claim-1', channel: 'web',
      state: 'proposing_tour', handoffReason: 'explicit_request',
      slots: { create: [{ key: 'transaction_intent', value: 'rent' }] },
    },
  });
  const { glm, reason } = glmReturning(JSON.stringify({
    intent: 'other', confidence: 'high', reply: 'Sure, happy to help.',
    profile: { set: {}, clear: [] },
  }));

  const reply = await handleInboundMessage(
    { tenantId: TENANT_ID, from: 'web:pending-claim-1', body: 'any updates?', channel: 'web' },
    { glm, messaging: new WebChatMockAdapter() },
  );

  expect(reason).toHaveBeenCalledTimes(1);
  expect(reply.replyText).not.toBe('');
});

it('el bot se calla en cuanto alguien tomó control', async () => {
  const staffUser = await prisma.user.create({
    data: {
      tenantId: TENANT_ID, email: `claimer-${TENANT_ID}@test.ca`, passwordHash: 'x',
      firstName: 'Pat', lastName: 'Manager', role: 'property_manager',
    },
  });
  const conversation = await prisma.chatConversation.create({
    data: {
      tenantId: TENANT_ID, externalId: 'web:claimed-1', channel: 'web',
      state: 'proposing_tour', handoffReason: 'explicit_request',
      claimedByUserId: staffUser.id, claimedAt: new Date(),
    },
  });
  const { glm, reason } = glmReturning('should never be called');

  const reply = await handleInboundMessage(
    { tenantId: TENANT_ID, from: 'web:claimed-1', body: 'hello?', channel: 'web' },
    { glm, messaging: new WebChatMockAdapter() },
  );

  expect(reason).not.toHaveBeenCalled();
  expect(reply.replyText).toBe('');
});
```

Extender `cleanup()` de ese archivo para borrar también `prisma.user` de
`TENANT_ID` (si aún no lo hace) — el segundo caso siembra un usuario nuevo.

- [ ] **Step 5: Correr y ver que el primer caso nuevo falla**

```bash
pnpm --filter @property-manager/api test -- chatbot.routing
```

Esperado: el primer caso nuevo FALLA contra el código viejo (el guard
todavía revisa `state === 'handoff'`, así que una conversación con
`handoffReason` puesto pero `state: 'proposing_tour'` no se ve afectada
por el guard viejo — para que este test realmente demuestre el cambio,
verificar contra el guard ANTES de aplicar el Step 3 que el escenario
correcto que SÍ fallaría es uno con `state: 'handoff'` Y `handoffReason`
puesto pero sin `claimedByUserId` — ajustar el seed del primer caso si
hace falta para que efectivamente ejercite la diferencia real entre el
guard viejo y el nuevo).

- [ ] **Step 6: Aplicar el Step 3 y confirmar que ambos casos pasan**

```bash
pnpm --filter @property-manager/api test -- chatbot.routing
```

- [ ] **Step 7: Notificación a todo el staff disponible, no en cascada**

En `notifyStaffOfHandoff` (`:3725-3763`), reemplazar la resolución de
destinatarios:

```ts
    const lead = input.leadId
      ? await prisma.lead.findUnique({ where: { id: input.leadId }, select: { assignedUserId: true, name: true } })
      : null;
    const staff = await prisma.user.findMany({
      where: { tenantId: input.tenantId, isActive: true },
      select: { id: true, email: true, role: true, notificationChannel: true, notificationAddress: true },
    });
    const targets = resolveStaffNotifyTargets({
      brokerUserId: null,
      assignedUserId: lead?.assignedUserId ?? null,
      staff,
      propertyManagerIds: staff.filter((m) => m.role === 'property_manager').map((m) => m.id),
    });
```

por:

```ts
    const lead = input.leadId
      ? await prisma.lead.findUnique({ where: { id: input.leadId }, select: { name: true } })
      : null;
    // A diferencia de la notificación de aplicaciones de renta (que sí usa
    // la cascada de resolveStaffNotifyTargets), aquí se avisa a TODO el
    // staff disponible con rol property_manager o broker — cualquiera que
    // esté libre puede tomar control. No hay "dueño" de un hand-off.
    const targets = await prisma.user.findMany({
      where: {
        tenantId: input.tenantId,
        isActive: true,
        role: { in: ['property_manager', 'broker'] },
      },
      select: { id: true, email: true, notificationChannel: true, notificationAddress: true },
    });
```

`resolveStaffNotifyTargets` deja de importarse/usarse en este archivo si
no queda ningún otro caller local — verificar antes de quitar el import
(no tocar su declaración en `staff-notify.service.ts`, sigue en uso desde
`rental-application.service.ts`).

- [ ] **Step 8: Texto honesto del acuse de recibo**

Reemplazar `HANDOFF_ACKNOWLEDGEMENT` (`:3665-3667`):

```ts
export const HANDOFF_ACKNOWLEDGEMENT =
  "I've let the team know — someone will pick this up as soon as they can. " +
  "In the meantime, I'm still here if you have other questions.";
```

Buscar cualquier prueba existente (Tarea 5) que haga match exacto o
parcial sobre el texto viejo (`'team'`, `"they'll follow up"`, etc.) y
actualizar esas aserciones al nuevo texto — no debe quedar ninguna prueba
verificando el string viejo.

- [ ] **Step 9: Correr toda la suite y verificar**

```bash
pnpm --filter @property-manager/api test
pnpm -r exec tsc --noEmit
```

- [ ] **Step 10: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src/services/chatbot.service.ts apps/api/src/services/conversation-events.service.ts apps/api/src/services/chatbot.service.test.ts apps/api/src/services/chatbot.routing.test.ts apps/api/src/services/conversation-events.service.test.ts
git commit -m "fix: el bot no se apaga hasta que un humano toma control explícitamente"
```

---

## Task 7: Tomar control / devolver control

**Files:**
- Modify: `apps/api/src/services/chatbot.service.ts`
- Modify: `apps/api/src/routes/chat.ts`
- Test: `apps/api/src/services/chatbot.service.test.ts`

**Interfaces:**
- Consumes: `callGlm`/`callOwnershipGlm`, `prepareConversationHistory`,
  `getReplyAddressFromConversation`, `sendHumanLike`, `nextDeliveryRetryAt`
  (todas ya exportadas/importadas); `claimedByUserId`/`claimedAt` (Tarea 6).
- Produces:
  - `export async function claimConversation(input: { tenantId: string; conversationId: string; userId: string }): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }>`
  - `export async function resumeBotFromHandoff(input: { tenantId: string; conversationId: string; actorUserId: string }): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }>`

- [ ] **Step 1: Escribir las pruebas que fallan — `claimConversation`**

```ts
describe('claimConversation', () => {
  it('marca la conversación como tomada y crea el evento', async () => {
    const staffUser = await prisma.user.create({
      data: {
        tenantId: TENANT_ID, email: `claim-1-${TENANT_ID}@test.ca`, passwordHash: 'x',
        firstName: 'Pat', lastName: 'Manager', role: 'property_manager',
      },
    });
    const conversation = await prisma.chatConversation.create({
      data: { tenantId: TENANT_ID, externalId: 'web:claim-1', channel: 'web', state: 'proposing_tour', handoffReason: 'explicit_request' },
    });

    const result = await claimConversation({ tenantId: TENANT_ID, conversationId: conversation.id, userId: staffUser.id });

    expect(result).toEqual({ ok: true });
    const row = await prisma.chatConversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(row.claimedByUserId).toBe(staffUser.id);
    expect(row.claimedAt).not.toBeNull();

    const events = await prisma.conversationEvent.findMany({ where: { tenantId: TENANT_ID, conversationId: conversation.id, type: 'handoff.claimed' } });
    expect(events).toHaveLength(1);
  });

  it('devuelve 409 si ya la tomó alguien más — dos intentos simultáneos dejan exactamente un dueño', async () => {
    const [staffA, staffB] = await Promise.all([
      prisma.user.create({ data: { tenantId: TENANT_ID, email: `claim-a-${TENANT_ID}@test.ca`, passwordHash: 'x', firstName: 'A', lastName: 'A', role: 'property_manager' } }),
      prisma.user.create({ data: { tenantId: TENANT_ID, email: `claim-b-${TENANT_ID}@test.ca`, passwordHash: 'x', firstName: 'B', lastName: 'B', role: 'broker' } }),
    ]);
    const conversation = await prisma.chatConversation.create({
      data: { tenantId: TENANT_ID, externalId: 'web:claim-race', channel: 'web', state: 'proposing_tour', handoffReason: 'explicit_request' },
    });

    const [resultA, resultB] = await Promise.all([
      claimConversation({ tenantId: TENANT_ID, conversationId: conversation.id, userId: staffA.id }),
      claimConversation({ tenantId: TENANT_ID, conversationId: conversation.id, userId: staffB.id }),
    ]);

    const outcomes = [resultA, resultB];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok && o.status === 409)).toHaveLength(1);

    const row = await prisma.chatConversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect([staffA.id, staffB.id]).toContain(row.claimedByUserId);
  });

  it('devuelve 404 si la conversación no existe', async () => {
    const result = await claimConversation({ tenantId: TENANT_ID, conversationId: 'no_existe', userId: 'user_1' });
    expect(result).toEqual({ ok: false, status: 404, error: 'not_found' });
  });
});
```

- [ ] **Step 2: Implementar `claimConversation`**

```ts
export async function claimConversation(input: {
  tenantId: string;
  conversationId: string;
  userId: string;
}): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
  const conversation = await prisma.chatConversation.findFirst({
    where: { id: input.conversationId, tenantId: input.tenantId },
    select: { id: true, leadId: true },
  });
  if (!conversation) return { ok: false, status: 404, error: 'not_found' };

  // El where: { claimedByUserId: null } es la red de concurrencia: si dos
  // miembros del staff presionan "Take control" casi al mismo tiempo, esta
  // actualización condicional garantiza que solo uno tenga éxito, sin
  // necesitar una unique nueva — el mismo principio de "las condiciones de
  // la base son la red" aplicado a un UPDATE en vez de un INSERT.
  const result = await prisma.chatConversation.updateMany({
    where: { id: input.conversationId, tenantId: input.tenantId, claimedByUserId: null },
    data: { claimedByUserId: input.userId, claimedAt: new Date() },
  });
  if (result.count === 0) return { ok: false, status: 409, error: 'already_claimed' };

  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { firstName: true, lastName: true } });
  await createConversationEvent({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    leadId: conversation.leadId,
    actorUserId: input.userId,
    type: 'handoff.claimed',
    payload: { claimedByName: user ? `${user.firstName} ${user.lastName}` : undefined },
  });

  return { ok: true };
}
```

- [ ] **Step 3: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/api test -- chatbot.service
```

- [ ] **Step 4: Escribir las pruebas que fallan — `resumeBotFromHandoff`**

Mismo esqueleto de pruebas que la versión original de esta tarea (ver
historial de este archivo si hace falta referencia), con dos ajustes
respecto al diseño viejo:

```ts
describe('resumeBotFromHandoff', () => {
  it('usa el historial completo, incluidos los mensajes de staff, y limpia claim + handoff', async () => {
    const staffUser = await prisma.user.create({
      data: { tenantId: TENANT_ID, email: `resume-1-${TENANT_ID}@test.ca`, passwordHash: 'x', firstName: 'Pat', lastName: 'Manager', role: 'property_manager' },
    });
    const lead = await prisma.lead.create({
      data: { tenantId: TENANT_ID, name: 'Ana', phone: '+16045550111', status: 'contacted', source: 'web' },
    });
    const conversation = await prisma.chatConversation.create({
      data: {
        tenantId: TENANT_ID, externalId: 'web:resume-1', channel: 'web', state: 'proposing_tour',
        handoffReason: 'explicit_request', handoffNotifiedAt: new Date(),
        claimedByUserId: staffUser.id, claimedAt: new Date(),
        leadId: lead.id,
        slots: { create: [{ key: 'transaction_intent', value: 'rent' }] },
        messages: {
          create: [
            { role: 'user', content: 'I want to talk to someone' },
            { role: 'staff', content: 'Hi, this is Pat — happy to help. What questions do you have?' },
          ],
        },
      },
    });

    let capturedPrompt = '';
    const reason = vi.fn(async (request: GlmReasoningRequest) => {
      capturedPrompt = request.systemPrompt;
      return { content: JSON.stringify({ intent: 'other', confidence: 'high', reply: 'Sure, happy to help further.', profile: { set: {}, clear: [] } }) };
    });
    vi.spyOn(await import('../config/adapters.js'), 'getAdapters').mockReturnValue({
      glm: { name: 'glm', reason, extractReceipt: vi.fn() },
      messaging: { web: { channel: 'web', send: vi.fn(async () => ({ messageId: 'm1' })), parseWebhook: vi.fn() } },
    } as never);

    const result = await resumeBotFromHandoff({ tenantId: TENANT_ID, conversationId: conversation.id, actorUserId: staffUser.id });

    expect(result).toEqual({ ok: true });
    expect(capturedPrompt).toContain('happy to help');

    const row = await prisma.chatConversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(row.handoffReason).toBeNull();
    expect(row.handoffNotifiedAt).toBeNull();
    expect(row.claimedByUserId).toBeNull();
    expect(row.claimedAt).toBeNull();

    const messages = await prisma.chatMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'asc' } });
    expect(messages).toHaveLength(3);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);

    const events = await prisma.conversationEvent.findMany({ where: { tenantId: TENANT_ID, conversationId: conversation.id, type: 'handoff.resumed' } });
    expect(events).toHaveLength(1);
  });

  it('devuelve 404 si la conversación no existe', async () => {
    const result = await resumeBotFromHandoff({ tenantId: TENANT_ID, conversationId: 'no_existe', actorUserId: 'user_1' });
    expect(result).toEqual({ ok: false, status: 404, error: 'not_found' });
  });

  it('devuelve 409 si nadie ha tomado control', async () => {
    const conversation = await prisma.chatConversation.create({
      data: { tenantId: TENANT_ID, externalId: 'web:resume-2', channel: 'web', state: 'proposing_tour' },
    });
    const result = await resumeBotFromHandoff({ tenantId: TENANT_ID, conversationId: conversation.id, actorUserId: 'user_1' });
    expect(result).toEqual({ ok: false, status: 409, error: 'not_claimed' });
  });

  it('sustituye scheduling por proposing_tour como estado de entrada', async () => {
    const staffUser = await prisma.user.create({
      data: { tenantId: TENANT_ID, email: `resume-3-${TENANT_ID}@test.ca`, passwordHash: 'x', firstName: 'Pat', lastName: 'Manager', role: 'property_manager' },
    });
    const conversation = await prisma.chatConversation.create({
      data: {
        tenantId: TENANT_ID, externalId: 'web:resume-3', channel: 'web', state: 'scheduling',
        handoffReason: 'provider_failure', claimedByUserId: staffUser.id, claimedAt: new Date(),
        slots: { create: [{ key: 'transaction_intent', value: 'rent' }] },
      },
    });

    const reason = vi.fn(async () => ({
      content: JSON.stringify({ intent: 'other', confidence: 'high', reply: 'ok', profile: { set: {}, clear: [] } }),
    }));
    vi.spyOn(await import('../config/adapters.js'), 'getAdapters').mockReturnValue({
      glm: { name: 'glm', reason, extractReceipt: vi.fn() },
      messaging: { web: { channel: 'web', send: vi.fn(async () => ({ messageId: 'm1' })), parseWebhook: vi.fn() } },
    } as never);

    const result = await resumeBotFromHandoff({ tenantId: TENANT_ID, conversationId: conversation.id, actorUserId: staffUser.id });
    expect(result).toEqual({ ok: true });
  });
});
```

- [ ] **Step 5: Implementar `resumeBotFromHandoff`**

Mismo cuerpo que la versión original de esta función (el turno sintético
vía `callGlm`/`callOwnershipGlm` no cambia en absoluto — la corrección es
solo de dónde sale el `currentState` de entrada y qué campos se limpian al
terminar):

```ts
const RESUME_SYNTHETIC_PROMPT =
  '[System: a staff member has re-enabled automated assistance for this ' +
  'conversation. Review the full conversation so far — including any ' +
  'replies from staff — and continue helping the lead from wherever the ' +
  'conversation actually stands now, not from where you left off before ' +
  'the pause.]';

export async function resumeBotFromHandoff(input: {
  tenantId: string;
  conversationId: string;
  actorUserId: string;
}): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
  const conversation = await prisma.chatConversation.findFirst({
    where: { id: input.conversationId, tenantId: input.tenantId },
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 20 }, slots: true },
  });
  if (!conversation) return { ok: false, status: 404, error: 'not_found' };
  if (!conversation.claimedByUserId) return { ok: false, status: 409, error: 'not_claimed' };

  const existingSlots: Record<string, string> = {};
  for (const slot of conversation.slots) existingSlots[slot.key] = slot.value;

  const isOwnershipConversation =
    existingSlots.transaction_intent === 'buy' || existingSlots.transaction_intent === 'sell';
  const history = prepareConversationHistory(conversation.messages, false);
  const { getAdapters } = await import('../config/adapters.js');
  const adapters = getAdapters();
  const tenantName = await getTenantName(input.tenantId);

  // 'scheduling' depende de que input.body sea un número de opción elegido
  // por el lead — no aplica al prompt sintético. proposing_tour es neutral
  // y ya rutea por el modelo para cualquier transaction_intent conocido.
  // Ya no se lee handoffPreState (retirado en la Tarea 6): como el bot
  // nunca dejó de correr mientras nadie tomaba control, conversation.state
  // sigue siendo el estado real y vivo de la conversación.
  const currentDbState = conversation.state as ConversationState;
  const landingState: ConversationState = currentDbState === 'scheduling' ? 'proposing_tour' : currentDbState;

  const turn = isOwnershipConversation
    ? await callOwnershipGlm(adapters.glm, {
      currentState: landingState,
      tenantId: input.tenantId,
      userMessage: RESUME_SYNTHETIC_PROMPT,
      history,
      existingSlots,
    })
    : await callGlm(adapters.glm, {
      currentState: landingState,
      tenantId: input.tenantId,
      userMessage: RESUME_SYNTHETIC_PROMPT,
      history,
      existingSlots,
      availableUnits: await getAvailableUnits(input.tenantId, existingSlots),
      providerOutageFallback: buildGlmFallback(landingState, tenantName, RESUME_SYNTHETIC_PROMPT, existingSlots),
    });

  const newState = turn.next_state ?? landingState;

  await prisma.chatConversation.update({
    where: { id: conversation.id },
    data: {
      state: newState,
      handoffReason: null,
      handoffNotifiedAt: null,
      claimedByUserId: null,
      claimedAt: null,
    },
  });

  const assistantMessage = await prisma.chatMessage.create({
    data: { conversationId: conversation.id, role: 'assistant', content: turn.reply, deliveryStatus: 'pending' },
  });

  const to = getReplyAddressFromConversation(conversation.externalId);
  const messagingAdapter = adapters.messaging[conversation.channel as ChatChannel];
  try {
    const deliveredMessageIds = await sendHumanLike(to, turn.reply, conversation.channel, messagingAdapter);
    await prisma.chatMessage.update({
      where: { id: assistantMessage.id },
      data: { deliveryStatus: 'sent', deliveryError: null, deliveryNextAttemptAt: null, deliveryAttempts: 1, providerMessageIds: deliveredMessageIds },
    });
  } catch (error) {
    await prisma.chatMessage.update({
      where: { id: assistantMessage.id },
      data: {
        deliveryStatus: 'failed',
        deliveryError: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown delivery error',
        deliveryAttempts: 1,
        deliveryNextAttemptAt: nextDeliveryRetryAt(1),
      },
    });
  }

  await createConversationEvent({
    tenantId: input.tenantId,
    conversationId: conversation.id,
    leadId: conversation.leadId,
    actorUserId: input.actorUserId,
    type: 'handoff.resumed',
    payload: {},
  });

  return { ok: true };
}
```

- [ ] **Step 6: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/api test -- chatbot.service
```

- [ ] **Step 7: Rutas — retirar la manual, agregar claim/resume**

En `apps/api/src/routes/chat.ts`: **eliminar por completo** la ruta `POST
/conversations/:id/handoff` (bloque completo, incluidos `handoffSchema` si
solo lo usaba esa ruta y ningún otro handler) — "tomar control" la
reemplaza; no queda ninguna acción separada de "solo pausar". Verificar
que nada más en el archivo (ni en el frontend — ya confirmado que
`ConversationsPage.tsx` no llama esa ruta hoy) dependa de ella antes de
borrarla.

Agregar las dos rutas nuevas:

```ts
chatRouter.post('/conversations/:id/claim', requireAuth, requireRole('property_manager', 'broker'), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const result = await claimConversation({
      tenantId: user.tenantId,
      conversationId: req.params.id,
      userId: user.userId,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

chatRouter.post('/conversations/:id/resume', requireAuth, requireRole('property_manager', 'broker'), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const result = await resumeBotFromHandoff({
      tenantId: user.tenantId,
      conversationId: req.params.id,
      actorUserId: user.userId,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
```

Importar `claimConversation`, `resumeBotFromHandoff`, `requireRole`,
`type ConversationState` desde `../services/chatbot.service.js` /
`../auth/context.js` según corresponda (verificar qué ya está importado
en el archivo antes de duplicar imports).

- [ ] **Step 8: Correr y verificar**

```bash
pnpm --filter @property-manager/api test
pnpm -r exec tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/chatbot.service.ts apps/api/src/routes/chat.ts apps/api/src/services/chatbot.service.test.ts
git commit -m "feat: tomar control de la conversación y devolverla al bot"
```

---

## Task 8: Extender el aviso honesto a los puntos que ya prometían un humano

**Contexto:** estos cinco lugares en el código, todos previos a esta fase,
le dicen al lead que un humano lo va a contactar y hoy nunca lo notifican
a nadie. Con el guard nuevo de la Tarea 6 el bot ya NO se calla después de
estos — pero el texto sigue siendo una promesa vacía hasta que esta tarea
los conecte al mismo mecanismo de aviso que ya existe.

**El patrón es siempre el mismo:** los cuatro primeros ya devuelven (o
pueden devolver) un objeto con forma de `InterpretedTurn`/
`OwnershipConversationTurn`, que ya tienen (o ganan aquí) el campo opcional
`handoffReason`. El punto único de despacho que ya existe en
`handleInboundMessageUnlocked` (`if (newState === 'handoff' &&
glmResult.handoffReason) { triggerHandoff(...) }`, línea ~1379) recoge
automáticamente cualquier `handoffReason` que llegue puesto en
`glmResult` — no hace falta llamar a `triggerHandoff` desde un lugar
nuevo, solo asegurarse de que el campo llegue con el valor correcto.

**Files:**
- Modify: `apps/api/src/services/chatbot.service.ts`
- Modify: `apps/api/src/services/ownership-conversation.service.ts`
- Test: `apps/api/src/services/chatbot.service.test.ts`
- Test: `apps/api/src/services/ownership-conversation.service.test.ts`
- Test: `apps/api/src/services/chatbot.routing.test.ts`

- [ ] **Step 1: `buildPostTourContextTurn` — reagendar y cancelar**

En `chatbot.service.ts`, dentro de `buildPostTourContextTurn`
(línea ~285-320), las ramas de reagendar y cancelar:

```ts
  if (/\b(?:reschedule|change (?:the )?(?:time|date)|another time)\b/.test(normalized)) {
    return {
      reply: "Of course — I can help you reschedule. Tell me which day or time would work better, and I'll check the available alternatives.",
      slots: { post_tour_action: 'reschedule' },
      next_state: 'handoff',
    };
  }
  if (/\b(?:cancel|cannot make it|can't make it|won't make it)\b/.test(normalized)) {
    return {
      reply: "I can help with that. I'll treat this as a cancellation request and make sure the property manager is notified.",
      slots: { post_tour_action: 'cancel' },
      next_state: 'handoff',
    };
  }
```

pasan a:

```ts
  if (/\b(?:reschedule|change (?:the )?(?:time|date)|another time)\b/.test(normalized)) {
    return {
      reply: "Got it — I've flagged this so the team can help you find a new time. " + HANDOFF_ACKNOWLEDGEMENT,
      slots: { post_tour_action: 'reschedule' },
      next_state: 'handoff',
      handoffReason: 'follow_up_needed',
    };
  }
  if (/\b(?:cancel|cannot make it|can't make it|won't make it)\b/.test(normalized)) {
    return {
      reply: "I've noted this as a cancellation request and flagged it for the team. " + HANDOFF_ACKNOWLEDGEMENT,
      slots: { post_tour_action: 'cancel' },
      next_state: 'handoff',
      handoffReason: 'follow_up_needed',
    };
  }
```

(`HANDOFF_ACKNOWLEDGEMENT` ya se exporta desde este mismo archivo — Tarea
6 la corrigió; el texto final que el lead ve termina reemplazándose de
todas formas por el genérico cuando `triggerHandoff` corre, así que
concatenarlo aquí es solo para que la prueba directa de esta función
tenga un texto honesto incluso antes de pasar por el despacho — verificar
si el implementador prefiere omitir el texto extra dado que se sobreescribe
igual; cualquiera de las dos opciones es válida, lo que NO puede pasar es
que quede el texto viejo que promete "notified"/"I'll check alternatives"
sin que nada lo respalde).

No es necesario un `else` ni cambiar la firma de la función — `InterpretedTurn`
ya tiene `handoffReason?: 'explicit_request' | 'provider_failure'` desde la
Tarea 5; **ampliar ese union a** `'explicit_request' | 'provider_failure' |
'follow_up_needed'` en la declaración de `InterpretedTurn`.

- [ ] **Step 2: `handOffScheduling` — falla real de agendamiento**

En `chatbot.service.ts`, los dos call sites que hacen `finalReply = await
handOffScheduling(...); newState = 'handoff';` (uno en la rama de
`getSchedulingAvailability` sin resultado, otro en la rama de reserva
fallida — buscar ambos con `handOffScheduling(` en el archivo) agregan,
justo después de la asignación de `newState`:

```ts
        glmResult.handoffReason = 'follow_up_needed';
```

Esto hace que el despacho genérico de la línea ~1379 recoja el caso — el
texto específico que devuelve `handOffScheduling` queda superado por el
acuse genérico de `triggerHandoff`, lo cual es correcto (ambos textos ya
dicen esencialmente lo mismo). No hace falta cambiar la firma ni el cuerpo
de `handOffScheduling` en sí — solo sigue escribiendo su propio
`ConversationEvent` de tipo `'showing.availability_unavailable'`, que se
conserva sin cambios como el detalle específico de por qué no hubo
horarios; `triggerHandoff` agrega el evento genérico `'handoff.requested'`
aparte, ambos coexisten sin conflicto.

- [ ] **Step 3: `buyerTurn`/`sellerTurn` — calificación de compra/venta completa**

En `apps/api/src/services/ownership-conversation.service.ts`, agregar el
campo al tipo:

```ts
export type OwnershipConversationTurn = {
  reply: string;
  slots: Record<string, string>;
  next_state: ConversationState;
  clearSlots?: string[];
  handoffReason?: 'follow_up_needed';
};
```

En `buyerTurn` (línea ~322-329), los dos `return` con `next_state:
'handoff'`:

```ts
    return {
      reply: `Great, ${slots.prospect_name}. I have you looking in ${slots.preferred_area}, ${slots.preferred_province}, for a ${slots.bedrooms}-bedroom home with ${propertyLabel}, a working budget of $${Number(slots.purchase_budget).toLocaleString('en-CA')}, ${slots.financing_status.replaceAll('_', ' ')}, and ${petLabel}. Your priorities are ${slots.buyer_priorities}. I'll connect you with a purchase advisor, who will contact you at ${Object.values(contact)[0]} with the next step.`,
      slots: { ...contact, ownership_qualification_complete: 'yes' },
      next_state: 'handoff',
    };
  }
  return {
    reply: `Your purchase brief is already complete. I'll connect you with the purchase specialist for the next step.`,
    slots: {},
    next_state: 'handoff',
  };
```

pasan a:

```ts
    return {
      reply: `Great, ${slots.prospect_name}. I have you looking in ${slots.preferred_area}, ${slots.preferred_province}, for a ${slots.bedrooms}-bedroom home with ${propertyLabel}, a working budget of $${Number(slots.purchase_budget).toLocaleString('en-CA')}, ${slots.financing_status.replaceAll('_', ' ')}, and ${petLabel}. Your priorities are ${slots.buyer_priorities}. I've flagged this for a purchase advisor to follow up — someone will reach out to ${Object.values(contact)[0]} as soon as they can.`,
      slots: { ...contact, ownership_qualification_complete: 'yes' },
      next_state: 'handoff',
      handoffReason: 'follow_up_needed',
    };
  }
  return {
    reply: `Your purchase brief is already complete — a purchase specialist has already been flagged for the next step.`,
    slots: {},
    next_state: 'handoff',
    handoffReason: 'follow_up_needed',
  };
```

Mismo tratamiento en `sellerTurn` (línea ~421-428): el texto
`"I'll connect you with a selling specialist for a proper market
analysis and next steps."` y `"Your sale brief is already complete. I'll
connect you with the selling specialist for the next step."` pasan a la
misma redacción honesta ("I've flagged this for a selling specialist...",
sin prometer contacto específico), y ambos `return` ganan `handoffReason:
'follow_up_needed'`.

- [ ] **Step 4: Verificar que el campo llega hasta `glmResult`**

`buildOwnershipConversationTurn` (que envuelve `buyerTurn`/`sellerTurn`) y
`buildDeterministicQualificationTurn` (que la llama y hace `return
ownershipTurn;`) no necesitan ningún cambio — `OwnershipConversationTurn`
ya es estructuralmente compatible con `InterpretedTurn` vía ese `return`
directo, así que el campo nuevo viaja solo. Confirmar esto con una prueba
de integración en `chatbot.routing.test.ts` en vez de asumirlo:

```ts
it('calificación de compra completa dispara handoff con aviso al staff', async () => {
  await seedTenant();
  await prisma.user.create({
    data: { tenantId: TENANT_ID, email: `pm-buyer-${TENANT_ID}@test.ca`, passwordHash: 'x', firstName: 'Pat', lastName: 'Manager', role: 'property_manager' },
  });
  const conversation = await seedConversationWithSlots('web:buyer-qualified', 'collecting_budget', {
    transaction_intent: 'buy',
    prospect_name: 'Ana', preferred_area: 'Kelowna', preferred_province: 'British Columbia',
    bedrooms: '3', buyer_property_type: 'any', purchase_budget: '850000',
    financing_status: 'pre_approved', buyer_pets: 'none', buyer_priorities: 'schools',
    buyer_email: 'ana@example.com',
  });

  const reply = await handleInboundMessage(
    { tenantId: TENANT_ID, from: 'web:buyer-qualified', body: 'that all sounds right', channel: 'web' },
    { glm: throwingGlm().glm, messaging: new WebChatMockAdapter() },
  );

  expect(reply.newState).toBe('handoff');
  const row = await prisma.chatConversation.findUniqueOrThrow({ where: { id: conversation.id } });
  expect(row.handoffReason).toBe('follow_up_needed');
  expect(row.handoffNotifiedAt).not.toBeNull();
});
```

Usar `throwingGlm()` (o cualquier GLM que no se espera que se llame) es
intencional: si `buildOwnershipConversationTurn` realmente intercepta el
turno antes de llegar al modelo (como debe), el test pasa sin que GLM se
invoque nunca — si por algún motivo el modelo SÍ se llama, el mock lanza y
el test falla, delatando que el intercept no está funcionando. Ajustar los
nombres exactos de los slots de comprador contra
`ownership-conversation.service.ts`/`ownership-conversation.types.ts` si
difieren de los usados arriba — verificar contra el código real antes de
fijar el seed.

- [ ] **Step 5: Correr y verificar**

```bash
pnpm --filter @property-manager/api test
pnpm -r exec tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/chatbot.service.ts apps/api/src/services/ownership-conversation.service.ts apps/api/src/services/chatbot.service.test.ts apps/api/src/services/ownership-conversation.service.test.ts apps/api/src/services/chatbot.routing.test.ts
git commit -m "fix: los puntos que ya prometían un humano ahora avisan de verdad"
```

---

## Task 9: Interfaz de tres estados y documentación

**Files:**
- Modify: `apps/web/src/pages/ConversationsPage.tsx`
- Modify: `apps/web/src/lib/types.ts`
- Modify: `docs/PRODUCT_ROADMAP.md`

**Interfaces:**
- Consumes: `POST /chat/conversations/:id/claim`, `POST
  /chat/conversations/:id/resume` (Tarea 7).

- [ ] **Step 1: Tipos**

En `apps/web/src/lib/types.ts`, agregar al tipo de `Conversation`:

```ts
  handoffReason?: string | null;
  handoffNotifiedAt?: string | null;
  claimedByUserId?: string | null;
  claimedByUserName?: string | null; // si la API ya incluye el nombre resuelto; si no, ajustar al shape real del endpoint de detalle de conversación
```

Verificar contra la ruta `GET /chat/conversations/:id` real si el nombre
del staff que tomó control ya viene resuelto o solo el id — si solo viene
el id, mostrar el id o extender esa ruta con un `select` del nombre
(decisión del implementador, cualquiera de las dos es aceptable para esta
fase).

- [ ] **Step 2: Deep link `?conversationId=`**

En `ConversationsPage.tsx`, agregar `useSearchParams` de
`react-router-dom` (mismo patrón que `?calendar=` en `ShowingsPage.tsx`,
Fase 1.3). Al montar, si hay un `conversationId` en la URL, seleccionar
esa conversación.

- [ ] **Step 3: Retirar el botón/mutación de la ruta manual vieja**

**Confirmado, no es condicional:** `ConversationsPage.tsx:379-389` define
`handoffMutation` apuntando a `` `/chat/conversations/${id}/handoff` `` (esa
ruta ya no existe, se eliminó en la Tarea 7), y el botón "Request handoff"
que la dispara vive en `:837-852` junto con un textarea de motivo. Ambos
quedan como una llamada rota (404) desde que la Tarea 7 se commiteó hasta
que este Step se ejecuta — quitar `handoffMutation` y el botón/textarea
por completo, reemplazados por los botones "Take control"/"Return to bot"
del Step 4 de esta misma tarea.

- [ ] **Step 4: Franja de tres estados**

Agregar dos mutaciones — `POST .../claim` y `POST .../resume` — que
invaliden la query de la conversación seleccionada al terminar.

Render condicional en la conversación seleccionada:

- Sin `handoffReason`: nada.
- `handoffReason` puesto, `claimedByUserId` nulo: franja *"🔔 Needs a
  human — the bot is still responding while it waits."* + botón **"Take
  control"**.
- `claimedByUserId` puesto: franja *"👤 [nombre o id] is handling this
  conversation."* + botón **"Return to bot"**.

Ambos botones deshabilitados si `user.role` no es `property_manager` ni
`broker` (mismo patrón `useAuth()` que `AuditPage.tsx`).

- [ ] **Step 5: Verificar que compila**

```bash
pnpm --filter @property-manager/web test
pnpm -r exec tsc --noEmit
```

- [ ] **Step 6: Roadmap**

En `docs/PRODUCT_ROADMAP.md`, sección 1.2, marcar como entregado con nota
de lo que quedó fuera (confianza baja como disparador de handoff,
re-notificación por mensaje mientras nadie ha tomado control).

- [ ] **Step 7: Regresión completa del monorepo**

```bash
pnpm -r exec tsc --noEmit
pnpm -r run test
```

Esperado: todo verde en los cuatro paquetes. Si algo falla, no commitear:
reportar.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src docs/PRODUCT_ROADMAP.md
git commit -m "feat: pantalla de tomar/devolver control y roadmap"
```

---

## Notas para quien ejecute el plan

- **Las Tareas 1-5 ya están commiteadas y revisadas bajo el diseño
  original** (el bot se apagaba en cuanto `state === 'handoff'`). Las
  Tareas 6-9 corrigen ese mecanismo — no hace falta revertir nada, se
  corrige hacia adelante.
- **La Tarea 6 depende de que la Tarea 5 ya esté commiteada** (usa
  `triggerHandoff`/`notifyStaffOfHandoff`/`HANDOFF_ACKNOWLEDGEMENT` tal
  como quedaron, y los modifica in situ) — ya lo está.
- **La Tarea 8 depende de que la Tarea 6 haya corrido `prisma migrate
  dev`** (el campo `handoffReason` en `InterpretedTurn`/
  `OwnershipConversationTurn` es independiente del schema, pero las
  pruebas de la Tarea 8 siembran `claimedByUserId`, que no existe hasta
  la migración de la Tarea 6).
- **La Tarea 5 tiene un punto marcado "verificar contra el código real"**
  que ya se resolvió en la práctica (el intérprete de fallo de proveedor
  resultó ser código muerto en producción — ver ledger de la Tarea 5 — y
  se dejó como red de seguridad, no se retiró).
- **Si una prueba no pasa, se reporta BLOCKED.** No se commitea en rojo.
