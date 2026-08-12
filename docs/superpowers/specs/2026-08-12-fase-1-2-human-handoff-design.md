# Fase 1.2 — Hand-off de IA a humano

**Fecha:** 2026-08-12
**Estado:** corregido tras la revisión de la Tarea 5 (ver Sección 0) — la
Sección 0 gobierna sobre cualquier texto posterior que la contradiga.
**Roadmap:** [`docs/PRODUCT_ROADMAP.md`](../../PRODUCT_ROADMAP.md) §1.2

## 0. Corrección post-Tarea 5 — el bot no se apaga solo, alguien lo tiene que apagar

Las Tareas 1-5 (ya commiteadas, ver plan) se construyeron sobre un diseño
que la revisión de la Tarea 5 mostró que estaba mal: un guard que pausaba
el bot en cuanto `state === 'handoff'`, sin importar si algún humano ya
estaba mirando la conversación o no.

La revisión encontró que ese guard silencia, sin avisarle a nadie, ~10
puntos que YA existían antes de esta fase y que le prometen al lead que un
humano lo va a contactar — calificación de compra/venta terminada,
solicitud de reagendar, solicitud de cancelar, falla real de agendamiento.
El bot dice *"I'll connect you with a purchase advisor"* / *"I'll make sure
the property manager is notified"*, y nadie se entera nunca.

**Regla nueva, dada por el usuario:** si el bot tiene que pasar la
conversación a una persona, no puede prometer que esa persona va a
contestar — solo puede avisar que ya dio aviso y que está esperando a que
alguien pueda retomar. **Mientras ningún humano intervenga, el bot no se
apaga ni abandona la conversación.**

El mecanismo, tomado de un patrón que el usuario ya tiene funcionando en
otra aplicación: un botón explícito **"Tomar control de la conversación"**.
Nadie infiere que un humano "ya está mirando" a partir de que mandó un
mensaje cualquiera — alguien decide explícitamente hacerse cargo, y eso es
lo único que apaga al bot. Cuando esa persona termina, otro botón le
devuelve el control al bot.

### 0.1 Qué cambia respecto a las Secciones 1-8 originales (abajo)

- **El guard de pausa (Sección 1, ya commiteado en la Tarea 3) se reemplaza
  por completo.** Ya no depende de `state === 'handoff'`. Depende de un
  campo nuevo, `claimedByUserId`: nulo → el bot sigue respondiendo
  normalmente; con valor → el bot se calla, un humano ya tomó control.
- **`handoffPreState` (Sección 2.1, Tarea 1) se elimina.** Ya no hace
  falta: como el bot nunca deja de procesar turnos mientras nadie ha
  tomado control, `conversation.state` sigue vivo y actualizado en todo
  momento. Al devolver el control, `resumeBotFromHandoff` usa
  `conversation.state` tal cual está en ese momento, no un valor congelado.
- **La notificación (Sección 2.5, Tarea 5) deja de usar la cascada de
  `resolveStaffNotifyTargets`** (broker de la visita → dueño del lead →
  todos los property managers, deteniéndose en el primer nivel no vacío).
  Ese comportamiento se queda exactamente como está para su único otro
  consumidor, la notificación de aplicaciones de renta (Fase 2A) — no se
  toca. Para el hand-off del bot se agrega una función nueva que notifica
  a **todo** el staff activo con rol `property_manager` o `broker`, sin
  cascada: cualquiera que esté disponible puede tomar control.
- **La ruta manual de pausa (Sección 4, Tarea 7, aún no implementada) se
  retira.** "Pausar manualmente" y "tomar control" eran, en la práctica,
  la misma acción — un humano decidiendo hacerse cargo. Se reemplaza por
  completo con el botón de "Tomar control" nuevo; no queda una acción
  separada de "solo pausar sin tomar control".
- **Se extiende el disparo de aviso a los ~10 puntos que ya prometían un
  humano** (calificación de compra/venta terminada, reagendar, cancelar,
  falla de agendamiento) — ahora todos llaman al mismo mecanismo de aviso,
  y su texto deja de prometer contacto ("I'll connect you with...") para
  avisar honestamente ("I've let the team know...").
- El disparador de fallo de proveedor sin fallback determinístico (Sección
  2.3) se queda tal cual — la revisión confirmó que es código muerto hoy
  (ver ledger de la Tarea 5), pero es una red de seguridad correcta y
  probada por si `buildGlmFallback`/`buildOwnershipConversationTurn`
  cambian en el futuro. No se retira.

### 0.2 El mecanismo corregido, completo

**Campos en `ChatConversation`** (reemplaza lo que describe la Sección 2.1):

```prisma
  handoffReason      String?   // explicit_request | provider_failure | manual | follow_up_needed
  handoffNotifiedAt  DateTime?
  claimedByUserId    String?
  claimedAt          DateTime?

  claimedByUser User? @relation("ConversationClaimedBy", fields: [claimedByUserId], references: [id])
```

`manual` deja de generarse desde una ruta separada (esa ruta se retira,
ver 0.1) — se conserva como valor del enum solo por si algún flujo futuro
lo necesita marcar sin pasar por el flujo de aviso automático; hoy nada lo
escribe. `follow_up_needed` es el valor genérico para los ~10 puntos que
ya prometían contacto — el detalle específico (reagendar vs. cancelar vs.
calificación completa vs. sin horarios) va en el `payload.detail` del
`ConversationEvent`, no en un campo nuevo por cada caso.

**`triggerHandoff`** (reemplaza el cuerpo de la Sección 2.4): ya NO asume
que el bot se apaga. Su trabajo es únicamente: dejar `handoffReason`,
crear el evento, avisar a todo el staff disponible (best-effort, una sola
vez por episodio vía `handoffNotifiedAt`), y devolver el texto honesto de
reconocimiento. No toca `claimedByUserId` — eso es un flujo aparte.

```ts
const HANDOFF_ACKNOWLEDGEMENT =
  "I've let the team know — someone will pick this up as soon as they can. " +
  "In the meantime, I'm still here if you have other questions.";
```

**Notificación a todo el staff disponible** (reemplaza la Sección 2.5):
consulta directa, sin pasar por `resolveStaffNotifyTargets`:

```ts
const staff = await prisma.user.findMany({
  where: {
    tenantId: input.tenantId,
    isActive: true,
    role: { in: ['property_manager', 'broker'] },
  },
  select: { id: true, email: true, notificationChannel: true, notificationAddress: true },
});
await notifyStaffTargets({
  targets: staff,
  subject: 'A conversation needs your attention',
  body: `${leadName} ${reasonText} and needs a reply.\n\n${link}`,
  messaging: getAdapters().messaging,
});
```

`notifyStaffTargets` (Tarea 2) se reutiliza tal cual — solo cambia quién
llega en `targets`. `resolveStaffNotifyTargets` no se toca ni se llama
desde este flujo.

**El guard de pausa** (reemplaza la Sección 1 completa):

```ts
if (conversation.claimedByUserId) {
  return { replyText: '', newState: conversation.state as ConversationState, leadCreated: false, handoff: true };
}
```

Corre en el mismo punto donde vivía el guard viejo (después del opt-out,
antes de `/start` y de cualquier lógica de estado). La diferencia clave:
ya NO bloquea solo porque `state === 'handoff'` — un lead cuya
conversación tiene `handoffReason` puesto pero nadie ha tomado control
sigue recibiendo respuestas normales del bot.

**Tomar control** — `POST /chat/conversations/:id/claim`, `requireAuth`,
`requireRole('property_manager', 'broker')`:

```ts
const result = await prisma.chatConversation.updateMany({
  where: { id: req.params.id, tenantId: user.tenantId, claimedByUserId: null },
  data: { claimedByUserId: user.userId, claimedAt: new Date() },
});
if (result.count === 0) {
  res.status(409).json({ error: 'already_claimed' });
  return;
}
```

El `where: { claimedByUserId: null }` es la red de concurrencia: si dos
miembros del staff presionan "Tomar control" casi al mismo tiempo, la
actualización condicional garantiza que solo uno tenga éxito (`count ===
1`), sin necesitar una unique nueva — el mismo principio de "las
condiciones de la base son la red, no los `if` del código" aplicado a un
`UPDATE` en vez de un `INSERT`. Crea un `ConversationEvent` de tipo nuevo
`'handoff.claimed'` (`label: 'Staff took control'`, tono `active`).

**Devolver el control al bot** (reemplaza la Sección 3 — el mecanismo
interno de `resumeBotFromHandoff`, llamar a `callGlm`/`callOwnershipGlm`
con un prompt sintético y contexto completo incluidos los mensajes de
staff, **se queda exactamente igual**; lo único que cambia es de dónde
saca el `currentState` de entrada):

```ts
const landingState: ConversationState =
  conversation.state === 'scheduling' ? 'proposing_tour' : (conversation.state as ConversationState);
```

en vez de leer `handoffPreState` (que ya no existe). Limpia
`claimedByUserId`, `claimedAt`, `handoffReason`, `handoffNotifiedAt` al
terminar.

**Interfaz:** tres estados posibles en la franja de
`ConversationsPage.tsx`:

- Sin `handoffReason`: nada, conversación normal.
- `handoffReason` puesto, `claimedByUserId` nulo: *"🔔 Needs a human — the
  bot is still responding while it waits."* + botón **"Take control"**.
- `claimedByUserId` puesto: *"👤 [nombre] is handling this conversation."*
  + botón **"Return to bot"**.

### 0.3 Qué NO cambia

El resto de esta sección (0) es el único texto que gobierna la mecánica de
pausa/aviso/reanudación. Las Secciones 1-8 de abajo documentan el diseño
ORIGINAL, previo a esta corrección — se conservan como registro histórico
de por qué se llegó a la Sección 0, no como especificación vigente. Todo
lo demás que esas secciones ya cubrían y esta corrección no menciona
explícitamente sigue vigente tal cual: el esquema de
`ConversationEventType`, el fix del filtro de contexto para mensajes
`role: 'staff'` (Sección 3.2 original, ya commiteado en la Tarea 4), el
turno sintético de reanudación en sí (Sección 3.4 original), el deep link
`?conversationId=`, y toda la batería de pruebas salvo donde el guard
nuevo la contradiga.

---

## Problema

El estado `handoff` ya existe en `ChatConversation.state` y ya se usa en tres
lugares: tras agendar exitosamente, cuando no hay calendario conectado
(Fase 1.3), y cuando un manager toma la conversación a mano desde
`POST /conversations/:id/handoff`. Pero **nada respeta ese estado**:
`handleInboundMessageUnlocked` no tiene ningún `if (currentState ===
'handoff')` en ningún punto de su flujo. Un lead cuya conversación llega a
`handoff` y vuelve a escribir sigue recibiendo respuestas automáticas del
bot como si nada — el bug no es hipotético, ya afecta código en producción.

Tampoco existe ninguna notificación al manager. El roadmap pide un aviso
instantáneo con link directo al chat; hoy nadie se entera de que una
conversación quedó esperando a un humano hasta que la revisa manualmente.

Esta fase corrige ambas cosas: hace que `handoff` realmente pause al bot, y
agrega los dos disparadores automáticos que le faltaban al estado (solicitud
explícita del lead, fallo real del proveedor de IA sin fallback), con
notificación al staff y un camino para reanudar al bot.

## Alcance

**Dentro:**

- Guard real de pausa en `handleInboundMessageUnlocked`.
- Dos disparadores automáticos: intent `handoff` del modelo, y fallo de
  proveedor sin fallback determinístico.
- Notificación al staff (email + canal preferido), una sola vez por episodio.
- Botón "Reanudar bot" que hace que el modelo retome la conversación
  revisando el historial completo — incluidos los mensajes que el staff
  mandó a mano mientras estaba pausado.
- Deep link `?conversationId=` en `ConversationsPage.tsx`.
- La ruta manual de pausa que ya existe pasa a activar el mismo guard.

**Fuera (decisiones explícitas):**

- **Confianza baja como disparador.** El intérprete ya calcula
  `turn.confidence === 'low'` por turno, pero eso queda fuera: solo
  dispara `ask_clarification`, igual que hoy. Nota importante: esta señal
  **no** es la misma que ADR-004 — esa ADR describe el veto multiplicativo
  del Financial Sentinel para aprobar movimientos contables, un sistema
  completamente distinto. `turn.confidence` es una señal por-turno del
  intérprete de renta/ownership, sin relación con el Sentinel.
- **Re-notificación por cada mensaje del lead mientras está pausado.** Se
  notifica una vez por episodio de handoff.
- **Notificación en la pausa manual existente.** Quien la activa ya está
  viendo la conversación.
- **Restaurar un `pre_handoff_state` guardado al reanudar.** Se descartó a
  propósito — ver Sección 3.

## Restricciones globales

1. **Sin dependencias nuevas.**
2. **Errores por valor de retorno, no por excepción**, donde aplique — el
   manejador global de `app.ts` convierte cualquier `throw` en 500.
3. **Nunca reportar como hecho algo que no ocurrió** — si la notificación al
   staff falla, la pausa del bot y el mensaje de reconocimiento al lead
   deben sostenerse igual; un fallo de notificación nunca debe hacer que el
   bot siga respondiendo cuando debería estar pausado.
4. **Aislamiento por tenant.** Toda consulta filtra por `tenantId`.
5. **Notificaciones best-effort e independientes entre sí** — el patrón ya
   establecido en `notifyStaffOfApplication` (Fase 2A): que falle un canal
   no debe impedir el otro, ni impedir que la operación principal (guardar
   el mensaje, pausar el bot) se complete.
6. **El repo se queda verde.**

---

## Arquitectura

Tres piezas, todas dentro de `apps/api/src/services/chatbot.service.ts` y
sus vecinos directos:

```
handleInboundMessageUnlocked   ← guard de pausa (Sección 1)
   │
   ├─ dispara handoff ──────►  triggerHandoff()          (Sección 2)
   │                              │
   │                              └─► notifyStaffOfHandoff()  (Sección 2.3,
   │                                    helper compartido con Fase 2A)
   │
   └─ (guard activo, no llama a GLM)

POST /conversations/:id/resume  ← reanudar (Sección 3)
```

---

## 1. El guard de pausa

En `handleInboundMessageUnlocked`, justo después de persistir el
`ChatMessage` entrante y de aplicar la detección de opt-out (que debe seguir
corriendo primero — un lead pausado que además pide no ser contactado sigue
mereciendo ese registro), se agrega:

`BotReply` (línea 145) ya tiene la forma:

```ts
export interface BotReply {
  replyText: string;
  newState: ConversationState;
  leadCreated: boolean;
  handoff: boolean;
  extractedSlots?: Record<string, string>;
  proposedUnits?: Array<{ id: string; name: string; rent: number }>;
}
```

y `handoff` ya se deriva en cada punto de retorno existente como
`newState === 'handoff'` — es puramente informativo, no hay que inventar
ningún campo nuevo. El guard retorna:

```ts
if (conversationState === 'handoff') {
  return { replyText: '', newState: 'handoff', leadCreated: false, handoff: true };
}
```

Lo importante es que **no** se llama a `interpretRentalTurn` /
`interpretOwnershipTurn` ni al motor determinístico, y **no** se envía nada
por `deps.messaging`. El mensaje del lead queda guardado — el staff lo ve
en `ConversationsPage.tsx` como cualquier otro — pero no genera respuesta
automática. El plan de implementación debe verificar contra el código real
cómo los demás puntos de salida tempranos de `handleInboundMessageUnlocked`
(si los hay) pueblan `leadCreated`/`extractedSlots` para mantener esa misma
convención aquí.

Este guard, por sí solo, ya corrige el bug existente en los tres flujos que
hoy escriben `state: 'handoff'` sin que nada lo respete.

---

## 2. Los dos disparadores nuevos

### 2.1 Campos nuevos en `ChatConversation`

```prisma
  // Fase 1.2: por qué está pausada la conversación. Null cuando no lo está.
  handoffReason      String?   // explicit_request | provider_failure | manual
  handoffNotifiedAt  DateTime?
```

`handoffNotifiedAt` es la guarda contra re-notificar: se pone al notificar
con éxito (o al menos al intentarlo — ver 2.3) y se limpia al reanudar.

### 2.2 Disparo por solicitud explícita

Ambos contratos semánticos (`rental-conversation.types.ts`,
`ownership-conversation.types.ts`) ya incluyen `intent: 'handoff'` como
valor válido, verificado por schema de zod. Hoy, en
`chatbot.service.ts:1002`, el único efecto es:

```ts
} else if (glmResult.intent === 'handoff') {
  glmResult.next_state = 'handoff';
}
```

Pasa a:

```ts
} else if (glmResult.intent === 'handoff') {
  glmResult.next_state = 'handoff';
  handoffReasonToApply = 'explicit_request';
}
```

y más abajo, después de persistir el nuevo `state` de la conversación, si
`handoffReasonToApply` está presente se llama a `triggerHandoff(...)`
(Sección 2.3).

### 2.3 Disparo por fallo real de proveedor

En ambos manejadores de turno determinístico
(`applyRentalDeterministicFallback` y su equivalente de ownership, líneas
~1580-1590 y ~1694-1698 de `chatbot.service.ts`), la rama que hoy es:

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

Sin umbral, sin reintentos — esta rama ya es el último recurso: solo se
llega aquí cuando no existe un fallback determinístico para la
intención/estado actual. `InterpretedTurn` gana el campo opcional
`handoffReason?: 'explicit_request' | 'provider_failure'` para que el
llamador sepa por qué, sin tener que releer el `intent`.

### 2.4 `triggerHandoff` — lo que pasa al entrar a handoff

Función nueva en `chatbot.service.ts`, llamada desde los dos puntos
anteriores (y reutilizada por la ruta manual, Sección 4):

```ts
async function triggerHandoff(input: {
  tenantId: string;
  conversation: { id: string; leadId: string | null; channel: ChatChannel; externalId: string };
  reason: 'explicit_request' | 'provider_failure' | 'manual';
  deps: { messaging: MessagingAdapter };
  actorUserId?: string; // presente solo para 'manual'
}): Promise<{ acknowledgement: string }>
```

Pasos:

1. `prisma.chatConversation.update` con `state: 'handoff'`, `handoffReason:
   input.reason`.
2. `createConversationEvent({ type: 'handoff.requested', payload: { reason:
   input.reason } })` — se reutiliza el tipo existente en vez de crear tres
   nuevos; su presentación (`'Human handoff requested'`, tono `attention`)
   ya cubre los tres casos con el detalle correcto porque
   `buildConversationEventPresentation` ya lee `payload.reason`.
3. Si `input.reason !== 'manual'`: llamar a `notifyStaffOfHandoff(...)`
   (Sección 2.5) y, si tiene éxito (o al menos no lanza), actualizar
   `handoffNotifiedAt`. Este paso es best-effort — si falla, no debe
   impedir el paso 4.
4. Devolver el texto de reconocimiento para el lead:

   ```
   "I'll get someone from our team to help you with that — they'll
   follow up right here."
   ```

   (mismo tono/idioma que el resto de las respuestas del bot, que son en
   inglés — ver `handOffScheduling` en Fase 1.3 como precedente directo).

El llamador (el flujo principal de `handleInboundMessageUnlocked`) es quien
persiste este texto como el `ChatMessage` de salida y lo envía por
`deps.messaging` — `triggerHandoff` no manda mensajes al lead, solo hace la
transición de estado, el evento, y la notificación al staff.

### 2.5 `notifyStaffOfHandoff` — helper compartido con Fase 2A

`notifyStaffOfApplication` (`rental-application.service.ts`) tiene, desde
la resolución de destinatarios hasta el bucle de envío, ~30 líneas
reutilizables al 100% para este caso — solo cambia el cuerpo del mensaje y
de dónde sale `brokerUserId`/`assignedUserId`. Se extrae el bucle de envío
a un helper nuevo y compartido:

**Crear** `apps/api/src/services/staff-notify.service.ts`:

```ts
export interface NotifiableStaff {
  id: string;
  email: string;
  notificationChannel: ChatChannel | null;
  notificationAddress: string | null;
}

export function resolveStaffNotifyTargets(input: {
  brokerUserId: string | null;
  assignedUserId: string | null;
  staff: NotifiableStaff[];
  propertyManagerIds: string[];
}): NotifiableStaff[]
// Cuerpo idéntico al actual resolveApplicationNotifyTargets — se mueve,
// no se duplica.

export async function notifyStaffTargets(input: {
  targets: NotifiableStaff[];
  subject: string;
  body: string;
  messaging: { email: MessagingAdapter } & Record<ChatChannel, MessagingAdapter>;
}): Promise<void>
// Cuerpo idéntico al bucle for de notifyStaffOfApplication: email siempre,
// canal preferido si existe y no es 'web' ni 'email', cada envío con su
// propio try/catch, nunca propaga.
```

`rental-application.service.ts` se actualiza para importar y usar estas dos
funciones en vez de sus copias locales — **elimina** su
`resolveApplicationNotifyTargets` y el bucle inline, sin cambiar ningún
comportamiento ni ninguna prueba existente (las pruebas de
`resolveApplicationNotifyTargets` se mueven al nuevo archivo de test del
helper compartido).

`notifyStaffOfHandoff` en `chatbot.service.ts`:

```ts
async function notifyStaffOfHandoff(input: {
  tenantId: string;
  conversationId: string;
  leadId: string | null;
  reason: 'explicit_request' | 'provider_failure';
}): Promise<void> {
  try {
    const lead = input.leadId
      ? await prisma.lead.findUnique({
        where: { id: input.leadId },
        select: { assignedUserId: true, name: true, phone: true },
      })
      : null;
    const staff = await prisma.user.findMany({
      where: { tenantId: input.tenantId, isActive: true },
      select: { id: true, email: true, role: true, notificationChannel: true, notificationAddress: true },
    });
    const targets = resolveStaffNotifyTargets({
      brokerUserId: null, // no hay showing todavía en este punto del flujo
      assignedUserId: lead?.assignedUserId ?? null,
      staff,
      propertyManagerIds: staff.filter((m) => m.role === 'property_manager').map((m) => m.id),
    });

    const reasonText = input.reason === 'explicit_request'
      ? 'asked to speak with a person'
      : 'ran into a problem our assistant could not resolve on its own';
    const link = `${getEnv().WEB_URL}/conversations?conversationId=${input.conversationId}`;
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

`brokerUserId: null` es correcto aquí: a diferencia de la aplicación de
renta (que siempre nace de un `Showing` ya agendado), un handoff puede
pasar en cualquier punto de la conversación, antes de que exista visita
alguna. La resolución cae directo a `assignedUserId` → todos los property
managers, igual que la aplicación cuando tampoco hay broker.

---

## 3. Reanudar el bot

### 3.1 Por qué no se restaura un estado guardado

La alternativa obvia — guardar `state` justo antes de pausar y restaurarlo
tal cual al reanudar — se descartó a propósito: mientras la conversación
está pausada, el staff puede haber respondido directamente al lead, resuelto
su duda, o el lead puede haber mandado información nueva. Restaurar un
puntero congelado ignora todo eso. En vez de eso, reanudar hace que el
**modelo** relea la conversación completa (incluidas las respuestas del
staff) y decida desde ahí — el mismo mecanismo que ya usa cada turno normal
del chatbot, solo que sin un mensaje nuevo del lead que lo dispare.

### 3.2 El hueco que hay que cerrar primero: el filtro de contexto ignora al staff

Los mensajes que el staff manda a mano (`POST /conversations/:id/reply`) ya
se guardan con `role: 'staff'` en `ChatMessage` — eso ya funciona hoy. Pero
el código que arma el contexto para el modelo, en dos puntos de
`chatbot.service.ts` (líneas ~1536 y ~1669), filtra:

```ts
message.role === 'user' || message.role === 'assistant'
```

Un mensaje `role: 'staff'` nunca pasa ese filtro — el modelo jamás se entera
de lo que el staff escribió. Sin corregir esto, "reanudar revisando toda la
conversación" es imposible. El fix:

```ts
message.role === 'user' || message.role === 'assistant' || message.role === 'staff'
```

tratando `staff` como el mismo lado de la conversación que `assistant` (el
lead ve ambos como "lo que la agencia le respondió"), en cualquier
transformación posterior a mensajes con rol `user`/`assistant` para el
prompt del modelo — un mensaje de staff se mapea al rol `assistant` en ese
punto, no se inventa un tercer rol para la API del modelo.

### 3.3 El endpoint

`POST /chat/conversations/:id/resume`, `requireAuth`, roles
`property_manager` y `broker` (mismos que pueden confirmar/cancelar
showings).

```ts
chatRouter.post('/conversations/:id/resume', requireAuth, requireRole('property_manager', 'broker'), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const conversation = await prisma.chatConversation.findFirst({
      where: { id: req.params.id, tenantId: user.tenantId },
    });
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (conversation.state !== 'handoff') {
      res.status(409).json({ error: 'not_paused' });
      return;
    }

    const result = await resumeBotFromHandoff({ tenantId: user.tenantId, conversation, actorUserId: user.userId });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
```

### 3.4 `resumeBotFromHandoff` — el turno sintético

Nueva función en `chatbot.service.ts`, exportada para que la ruta la use.
Reutiliza la construcción de contexto que ya existe (últimos 20 mensajes
con el filtro corregido de 3.2, slots, unidades disponibles) y llama al
mismo intérprete de siempre (renta u ownership, según
`slots.transaction_intent`), pero con un `message` sintético en vez del
cuerpo de un mensaje real del lead:

```ts
const RESUME_SYNTHETIC_PROMPT =
  '[System: a staff member has re-enabled automated assistance for this ' +
  'conversation. Review the full conversation so far — including any ' +
  'replies from staff — and continue helping the lead from wherever the ' +
  'conversation actually stands now, not from where you left off before ' +
  'the pause.]';
```

Este texto **no se persiste** como `ChatMessage` — no es un mensaje del
lead, es la instrucción de este turno único. Se le pasa directo al
intérprete como `message`.

```ts
export async function resumeBotFromHandoff(input: {
  tenantId: string;
  conversation: { id: string; leadId: string | null; channel: ChatChannel; externalId: string; unitId: string | null };
  actorUserId: string;
}): Promise<{ sent: boolean }> {
  const deps = { glm: getAdapters().glm, messaging: getAdapters().messaging[input.conversation.channel] };
  // Construye el mismo InterpretedTurn que un mensaje real, pero con el
  // prompt sintético — reutiliza processRentalTurn/processOwnershipTurn tal
  // cual, solo cambia de dónde sale `message`.
  const result = await runConversationTurn({
    tenantId: input.tenantId,
    conversation: input.conversation,
    body: RESUME_SYNTHETIC_PROMPT,
    isResume: true, // evita que se persista como ChatMessage de tipo user
    deps,
  });

  await prisma.chatConversation.update({
    where: { id: input.conversation.id },
    data: { handoffReason: null, handoffNotifiedAt: null },
  });
  await createConversationEvent({
    tenantId: input.tenantId,
    conversationId: input.conversation.id,
    leadId: input.conversation.leadId,
    actorUserId: input.actorUserId,
    type: 'handoff.requested', // reutilizado; ver nota abajo
    payload: { reason: 'resumed' },
  });

  return { sent: Boolean(result.text) };
}
```

**Nota sobre el tipo de evento:** `'handoff.requested'` no es un nombre
ideal para "se reanudó", pero reutilizarlo evita una cuarta variante de
presentación solo para esto. Alternativa considerada: el plan de
implementación puede optar por agregar `'handoff.resumed'` como tipo nuevo
en `ConversationEventType` (con su propia entrada en
`buildConversationEventPresentation`, ej. label `'Bot resumed'`, tono
`'done'`) si el implementador considera que reutilizar el mismo tipo con
`payload.reason: 'resumed'` genera una etiqueta engañosa en la UI
("Human handoff requested" para un evento que es justo lo opuesto). Esta es
la única decisión de nomenclatura que el plan puede resolver sin volver a
preguntar — cualquier otra ambigüedad de este spec sí debe escalarse.

`runConversationTurn` es una función nueva, extraída del cuerpo de
`handleInboundMessageUnlocked`: la parte que arma el contexto, llama al
intérprete correcto, actualiza slots/estado y decide qué responder — hoy
vive inline en `handleInboundMessageUnlocked`, y esta fase la separa para
que el turno sintético de "reanudar" pueda llamarla sin pasar por la
creación de un `ChatMessage` de tipo `user` (que sí ocurre en
`handleInboundMessageUnlocked` antes de llegar a esa lógica). El parámetro
`isResume` es lo único que controla esa diferencia: con `isResume: true`,
la función omite el `prisma.chatMessage.create({ role: 'user', ... })}` que
normalmente es lo primero que pasa, pero sigue persistiendo la respuesta
del bot (`role: 'assistant'`) y enviándola por el canal del lead
exactamente igual que un turno normal.

Esta extracción es la pieza de refactor más grande de la fase — el plan de
implementación debe tratarla como su propia tarea, con su propia batería de
pruebas de regresión (todo lo que `chatbot.routing.test.ts` ya cubre debe
seguir pasando sin cambios de comportamiento).

---

## 4. La ruta manual existente

`POST /conversations/:id/handoff` (`apps/api/src/routes/chat.ts:282`) pasa
a llamar a `triggerHandoff({ reason: 'manual', actorUserId: user.userId,
... })` en vez de su lógica inline actual — mismo resultado (estado,
evento, `Lead.operationalStatus: 'needs_handoff'` que ya escribía), más el
`handoffReason: 'manual'` que ahora activa el guard de pausa. No dispara
`notifyStaffOfHandoff` (paso 3 de `triggerHandoff` es condicional a
`reason !== 'manual'`, como ya se especificó en 2.4).

---

## 5. Interfaz

**`ConversationsPage.tsx`:**

- Lee `?conversationId=` con `useSearchParams` al montar y selecciona esa
  conversación (mismo patrón que `?calendar=` en `ShowingsPage.tsx`,
  Fase 1.3).
- Cuando la conversación seleccionada tiene `state === 'handoff'`, se
  muestra una franja indicando que el bot está pausado, con el motivo
  (`handoffReason`) en texto legible, y el botón **"Resume bot"** junto al
  botón existente de pausa manual. Solo visible/habilitado para
  `property_manager`/`broker`.
- El botón llama `POST /conversations/:id/resume`, invalida la query de la
  conversación al terminar.

---

## 6. Pruebas

- **Guard de pausa:** un mensaje entrante con `state === 'handoff'` no
  llama a GLM ni al motor determinístico (espiar el adapter), se persiste
  el `ChatMessage` del lead, no se envía nada por `deps.messaging`.
- **Disparo por intent explícito:** un turno con `intent: 'handoff'` deja
  `handoffReason: 'explicit_request'`, un `ConversationEvent`
  `'handoff.requested'` con ese reason, y el mensaje de reconocimiento
  enviado al lead.
- **Disparo por fallo de proveedor:** `providerFailed: true` sin
  `deterministicFallback` produce `handoffReason: 'provider_failure'`;
  con `deterministicFallback` presente, sigue devolviendo ese fallback sin
  pausar (comportamiento actual, no debe cambiar).
- **No se re-notifica:** un segundo mensaje del lead mientras sigue en
  `handoff` no dispara un segundo envío a `notifyStaffTargets` (verificar
  `handoffNotifiedAt` ya seteado evita la llamada).
- **`resolveStaffNotifyTargets`/`notifyStaffTargets`:** los casos que ya
  cubría `resolveApplicationNotifyTargets` en Fase 2A, migrados al nuevo
  archivo del helper, más un caso propio de handoff sin broker.
- **Reanudar:** un `ChatMessage` con `role: 'staff'` guardado durante la
  pausa aparece en el contexto que recibe el intérprete (mock del adapter
  GLM, verificar el `userPrompt`/contexto real que recibe); el turno
  sintético no crea ningún `ChatMessage` con `role: 'user'`; al terminar,
  `handoffReason` y `handoffNotifiedAt` quedan en `null`; `state` termina
  en lo que el intérprete decida (no en un valor fijo).
- **`POST /resume` sobre una conversación que no está en handoff:**
  devuelve 409, no hace nada.
- **La ruta manual sigue funcionando:** mismo comportamiento que hoy
  (estado, evento, `Lead.operationalStatus`), más el guard de pausa ahora
  activo y sin notificación disparada.
- **`?conversationId=`:** selecciona la conversación correcta al cargar
  `ConversationsPage.tsx`.
- **Regresión completa de `chatbot.routing.test.ts`:** la extracción de
  `runConversationTurn` no debe cambiar ningún resultado observable de los
  turnos normales (renta, ownership, fallback determinístico, opt-out).

---

## 7. Documentación

`docs/PRODUCT_ROADMAP.md` marca la §1.2 como entregada, con nota de lo que
quedó fuera (confianza baja como disparador, re-notificación por mensaje).
