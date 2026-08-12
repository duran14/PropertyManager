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

## Task 6: Reanudar el bot

**Files:**
- Modify: `apps/api/src/services/chatbot.service.ts`
- Modify: `apps/api/src/routes/chat.ts`
- Test: `apps/api/src/services/chatbot.service.test.ts`
- Test: crear o extender el archivo de pruebas de rutas de `chat.ts`

**Interfaces:**
- Consumes: `callGlm`/`callOwnershipGlm` (ya existentes, con el filtro
  corregido de la Tarea 4); `prepareConversationHistory`,
  `getReplyAddressFromConversation`, `sendHumanLike`, `nextDeliveryRetryAt`
  (todas ya exportadas o ya importadas en el archivo).
- Produces: `export async function resumeBotFromHandoff(input: { tenantId: string; conversationId: string; actorUserId: string }): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }>`

- [ ] **Step 1: Escribir la prueba que falla**

```ts
describe('resumeBotFromHandoff', () => {
  it('usa el historial completo, incluidos los mensajes de staff, y limpia los campos de handoff', async () => {
    const lead = await prisma.lead.create({
      data: { tenantId: TENANT_ID, name: 'Ana', phone: '+16045550111', status: 'contacted' },
    });
    const conversation = await prisma.chatConversation.create({
      data: {
        tenantId: TENANT_ID, externalId: 'web:resume-1', channel: 'web', state: 'handoff',
        handoffReason: 'explicit_request', handoffPreState: 'proposing_tour', handoffNotifiedAt: new Date(),
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

    const result = await resumeBotFromHandoff({ tenantId: TENANT_ID, conversationId: conversation.id, actorUserId: 'user_1' });

    expect(result).toEqual({ ok: true });
    expect(capturedPrompt).toContain('happy to help');

    const row = await prisma.chatConversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(row.handoffReason).toBeNull();
    expect(row.handoffNotifiedAt).toBeNull();
    expect(row.handoffPreState).toBeNull();
    expect(row.state).not.toBe('handoff');

    const messages = await prisma.chatMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'asc' } });
    expect(messages).toHaveLength(3); // user + staff + el nuevo assistant
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1); // nada nuevo de tipo user

    const events = await prisma.conversationEvent.findMany({ where: { tenantId: TENANT_ID, conversationId: conversation.id, type: 'handoff.resumed' } });
    expect(events).toHaveLength(1);
  });

  it('devuelve 404 si la conversación no existe', async () => {
    const result = await resumeBotFromHandoff({ tenantId: TENANT_ID, conversationId: 'no_existe', actorUserId: 'user_1' });
    expect(result).toEqual({ ok: false, status: 404, error: 'not_found' });
  });

  it('devuelve 409 si la conversación no está en handoff', async () => {
    const conversation = await prisma.chatConversation.create({
      data: { tenantId: TENANT_ID, externalId: 'web:resume-2', channel: 'web', state: 'proposing_tour' },
    });
    const result = await resumeBotFromHandoff({ tenantId: TENANT_ID, conversationId: conversation.id, actorUserId: 'user_1' });
    expect(result).toEqual({ ok: false, status: 409, error: 'not_paused' });
  });

  it('sustituye scheduling por proposing_tour como estado de entrada al reanudar', async () => {
    const conversation = await prisma.chatConversation.create({
      data: {
        tenantId: TENANT_ID, externalId: 'web:resume-3', channel: 'web', state: 'handoff',
        handoffReason: 'provider_failure', handoffPreState: 'scheduling',
        slots: { create: [{ key: 'transaction_intent', value: 'rent' }] },
      },
    });

    let capturedState: string | undefined;
    // Espiar callGlm no es directo porque no está exportado; en su lugar,
    // verificar indirectamente: el intérprete no debe recibir 'scheduling'
    // como parte del prompt de forma que intente parsear un número de
    // input.body — dado que el body es el prompt sintético (texto, no un
    // dígito), lo verificable de forma robusta es que la llamada NO lanza
    // y el resultado es ok:true. Si el implementador encuentra un punto de
    // inspección más directo (ej. exportar currentState recibido en un modo
    // de prueba), preferirlo; si no, esta aserción indirecta es aceptable.
    const reason = vi.fn(async () => ({
      content: JSON.stringify({ intent: 'other', confidence: 'high', reply: 'ok', profile: { set: {}, clear: [] } }),
    }));
    vi.spyOn(await import('../config/adapters.js'), 'getAdapters').mockReturnValue({
      glm: { name: 'glm', reason, extractReceipt: vi.fn() },
      messaging: { web: { channel: 'web', send: vi.fn(async () => ({ messageId: 'm1' })), parseWebhook: vi.fn() } },
    } as never);

    const result = await resumeBotFromHandoff({ tenantId: TENANT_ID, conversationId: conversation.id, actorUserId: 'user_1' });
    expect(result).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Correr y ver que falla**

```bash
pnpm --filter @property-manager/api test -- chatbot.service
```

- [ ] **Step 3: Implementar `resumeBotFromHandoff`**

En `apps/api/src/services/chatbot.service.ts`:

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
  if (conversation.state !== 'handoff') return { ok: false, status: 409, error: 'not_paused' };

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
  const rawPreState = (conversation.handoffPreState ?? 'proposing_tour') as ConversationState;
  const landingState: ConversationState = rawPreState === 'scheduling' ? 'proposing_tour' : rawPreState;

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
    data: { state: newState, handoffReason: null, handoffNotifiedAt: null, handoffPreState: null },
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

**Verificar contra el código real** antes de dar esto por terminado: el
tipo exacto de `ChatChannel` que exige `adapters.messaging[...]` (¿es un
`Record<ChatChannel, MessagingAdapter>` indexable directo con
`conversation.channel: string`? puede requerir un cast `as ChatChannel`,
igual que se ve en otros puntos del archivo), y que `getTenantName`,
`getAvailableUnits`, `buildGlmFallback`, `callGlm`, `callOwnershipGlm`,
`prepareConversationHistory`, `getReplyAddressFromConversation`,
`sendHumanLike`, `nextDeliveryRetryAt` estén todas accesibles desde el
punto donde se agrega esta función (todas viven en el mismo archivo salvo
`nextDeliveryRetryAt`, ya importado).

- [ ] **Step 4: Correr y ver que pasa**

```bash
pnpm --filter @property-manager/api test -- chatbot.service
```

- [ ] **Step 5: La ruta**

En `apps/api/src/routes/chat.ts`, importar `resumeBotFromHandoff` y
`requireRole` (verificar que `requireRole` ya esté importado en este
archivo; si no, agregarlo desde `../auth/context.js`). Agregar, cerca de la
ruta `/conversations/:id/handoff` existente:

```ts
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

- [ ] **Step 6: Pruebas de la ruta**

Buscar si existe `apps/api/src/routes/chat.test.ts`. Si no existe, crear
uno mínimo siguiendo el patrón de pruebas de servicio del repo llamando
DIRECTO a `resumeBotFromHandoff` (ya cubierto exhaustivamente en el Step 1
de esta tarea) — no es necesario un test HTTP end-to-end nuevo si el
servicio ya está probado a fondo y la ruta es un mapeo delgado de status;
si el repo ya tiene un patrón de pruebas HTTP para `chat.ts` (revisar
`apps/api/src/routes/webhooks.messenger.test.ts` como referencia de estilo
si aplica a rutas no-webhook), seguirlo. Como mínimo, una prueba de que
`requireRole('property_manager', 'broker')` está en la cadena de
middleware de esta ruta (grep del archivo de rutas ya sirve como
verificación manual si no hay infraestructura de test HTTP en este
directorio).

- [ ] **Step 7: Correr y verificar**

```bash
pnpm --filter @property-manager/api test
pnpm -r exec tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/chatbot.service.ts apps/api/src/routes/chat.ts apps/api/src/services/chatbot.service.test.ts
git commit -m "feat: reanudar el bot revisando la conversación completa"
```

---

## Task 7: La ruta manual existente pasa por `triggerHandoff`

**Files:**
- Modify: `apps/api/src/routes/chat.ts`
- Test: pruebas existentes de esa ruta, si las hay; si no, agregar un caso.

**Interfaces:**
- Consumes: `triggerHandoff` (Tarea 5), exportado de
  `chatbot.service.ts` — **verificar que se agregue `export`** delante de
  `async function triggerHandoff` en la Tarea 5, ya que hasta ahora se
  usaba solo dentro del mismo archivo.

- [ ] **Step 1: Exportar `triggerHandoff`**

En `chatbot.service.ts`, cambiar `async function triggerHandoff` por
`export async function triggerHandoff`.

- [ ] **Step 2: Actualizar la ruta manual**

En `apps/api/src/routes/chat.ts`, la ruta `POST
/conversations/:id/handoff` (línea ~282) reemplaza su bloque de:

```ts
    const event = await createConversationEvent({
      tenantId: user.tenantId,
      conversationId: conversation.id,
      leadId: conversation.leadId,
      actorUserId: user.userId,
      type: 'handoff.requested',
      payload: { reason: parsed.data.reason },
    });

    await prisma.chatConversation.update({
      where: { id: conversation.id },
      data: { state: 'handoff', updatedAt: new Date() },
    });
```

por:

```ts
    const currentConversation = await prisma.chatConversation.findFirstOrThrow({
      where: { id: conversation.id },
      select: { state: true },
    });

    await triggerHandoff({
      tenantId: user.tenantId,
      conversation: { id: conversation.id, leadId: conversation.leadId },
      reason: 'manual',
      preState: currentConversation.state as ConversationState,
    });

    // El evento de la razón dada por el staff en el formulario (parsed.data.reason,
    // texto libre) se conserva aparte del evento genérico 'handoff.requested' que
    // ya crea triggerHandoff con reason: 'manual' — ese texto libre no cabe en el
    // discriminador reason de triggerHandoff (que es un enum fijo), así que se
    // guarda en un evento propio para no perderlo.
    const event = await createConversationEvent({
      tenantId: user.tenantId,
      conversationId: conversation.id,
      leadId: conversation.leadId,
      actorUserId: user.userId,
      type: 'note.internal_added',
      payload: { note: `Manual handoff: ${parsed.data.reason}` },
    });
```

Verificar contra el código real de esa ruta (línea ~282-320) el nombre
exacto de la variable `conversation` y si ya trae `state` seleccionado en
su `findFirst` original (línea ~291-294) — si ya lo trae, no hace falta el
`findFirstOrThrow` extra, se puede usar directo `conversation.state`. El
implementador debe leer el bloque completo antes de aplicar este cambio,
no copiarlo a ciegas si la forma real difiere.

Mantener sin cambios el resto de la ruta: el `if (conversation.leadId) {
await prisma.lead.update({ ..., data: { operationalStatus:
'needs_handoff' } }) }` que ya existe se queda igual.

- [ ] **Step 3: Importar `ConversationState` y `triggerHandoff` en `chat.ts`**

```ts
import { triggerHandoff, type ConversationState } from '../services/chatbot.service.js';
```

(ajustar si `ConversationState` ya se importa con otro alias en ese
archivo).

- [ ] **Step 4: Correr y verificar**

```bash
pnpm --filter @property-manager/api test
pnpm -r exec tsc --noEmit
```

Esperado: la ruta manual sigue funcionando (verificar contra cualquier
prueba existente de esa ruta), y ahora además dispara el guard de pausa de
la Tarea 3 porque `handoffReason` queda seteado.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/chat.ts apps/api/src/services/chatbot.service.ts
git commit -m "refactor: la pausa manual también pasa por triggerHandoff"
```

---

## Task 8: Interfaz y documentación

**Files:**
- Modify: `apps/web/src/pages/ConversationsPage.tsx`
- Modify: `apps/web/src/lib/types.ts`
- Modify: `docs/PRODUCT_ROADMAP.md`

**Interfaces:**
- Consumes: `POST /chat/conversations/:id/resume` (Tarea 6).

- [ ] **Step 1: Tipos**

En `apps/web/src/lib/types.ts`, agregar al tipo de `Conversation` (o donde
viva ese tipo) los tres campos nuevos:

```ts
  handoffReason?: string | null;
  handoffNotifiedAt?: string | null;
  handoffPreState?: string | null;
```

- [ ] **Step 2: Deep link `?conversationId=`**

En `apps/web/src/pages/ConversationsPage.tsx`, agregar `useSearchParams`
de `react-router-dom` (mismo patrón usado en `PublicListingPage.tsx` y en
`ShowingsPage.tsx` de Fase 1.3 para `?calendar=`). Al montar, si hay un
`conversationId` en la URL, llamar `setSelectedId(...)` con ese valor.

- [ ] **Step 3: Franja de pausa + botón "Resume bot"**

Agregar una `useMutation` que llame `POST
/chat/conversations/${selectedId}/resume` e invalide la query de la
conversación seleccionada al terminar (mismo patrón que las mutaciones
existentes de esa página, ej. la de `/handoff` que ya está ahí).

Cuando la conversación seleccionada tenga `state === 'handoff'`, mostrar
una franja (mismo estilo de alerta que usa esa página para otros avisos)
con el texto:

```
"Automated replies are paused" + (handoffReason legible: "The lead asked
to speak with someone" | "Our assistant ran into a problem" | "Paused by
staff")
```

y el botón **"Resume bot"**, deshabilitado si `user.role` no es
`property_manager` ni `broker` (mismo patrón `useAuth()` que
`AuditPage.tsx`).

- [ ] **Step 4: Verificar que compila**

```bash
pnpm --filter @property-manager/web test
pnpm -r exec tsc --noEmit
```

- [ ] **Step 5: Roadmap**

En `docs/PRODUCT_ROADMAP.md`, sección 1.2, marcar como entregado con nota
de lo que quedó fuera (confianza baja como disparador, re-notificación por
mensaje), mismo estilo usado para §1.3.

- [ ] **Step 6: Regresión completa del monorepo**

```bash
pnpm -r exec tsc --noEmit
pnpm -r run test
```

Esperado: todo verde en los cuatro paquetes. Si algo falla, no commitear:
reportar.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src docs/PRODUCT_ROADMAP.md
git commit -m "feat: pantalla de pausa/reanudación de handoff y roadmap"
```

---

## Notas para quien ejecute el plan

- **La Tarea 5 tiene dos puntos marcados explícitamente "verificar contra
  el código real antes de fijar la aserción/implementación"** — el
  intérprete de fallo de proveedor y el tipo exacto de `history` que
  consumen `buildRentalConversationPrompt`/`buildOwnershipConversationPrompt`.
  No copiar el pseudocódigo a ciegas si diverge de lo que el archivo real
  muestra: leer primero, ajustar, luego escribir la prueba.
- **`triggerHandoff` se usa en dos tareas separadas** (Tarea 5 la crea sin
  exportar, Tarea 7 la exporta y la reutiliza) — si se ejecuta la Tarea 7
  antes de que la 5 esté commiteada, no existe todavía; respetar el orden.
- **Si una prueba no pasa, se reporta BLOCKED.** No se commitea en rojo.
