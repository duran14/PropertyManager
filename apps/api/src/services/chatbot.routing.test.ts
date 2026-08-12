import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WebChatMockAdapter,
  type GlmAdapter,
  type GlmReasoningRequest,
  type MessagingAdapter,
} from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { handleInboundMessage } from './chatbot.service.js';

/**
 * Prueba de integración de la decisión de enrutamiento de
 * `handleInboundMessage`: ¿el modelo real se convierte en el camino
 * principal una vez que `transaction_intent` está definido, y el motor
 * determinista solo se usa (a) antes de que exista ese intent, y
 * (b) como respaldo ante un fallo real del proveedor?
 *
 * Usa Prisma real contra la BD de test (mismo patrón que
 * bills.service.test.ts) y adapters mock/espía para GLM y mensajería —
 * nunca golpea la red real. ShowMojo ya no es parte de las dependencias de
 * `handleInboundMessage` (Tarea 9): el mock de aquí solo se usa para
 * demostrar que nadie lo alcanza por otra vía.
 */

const TENANT_ID = 'tenant_test_chatbot_routing';

async function seedTenant() {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Routing Test Tenant', province: 'BC' },
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
  await prisma.conversationEvent.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.chatConversation.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.unit.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.property.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.calendarConnection.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.schedulingConfig.deleteMany({ where: { tenantId: TENANT_ID } });
}

function glmReturning(content: string): { glm: GlmAdapter; reason: ReturnType<typeof vi.fn> } {
  const reason = vi.fn(async (_request: GlmReasoningRequest) => ({ content }));
  return { glm: { name: 'glm', reason, extractReceipt: vi.fn() } as unknown as GlmAdapter, reason };
}

function throwingGlm(): { glm: GlmAdapter; reason: ReturnType<typeof vi.fn> } {
  const reason = vi.fn(async () => {
    throw new Error('simulated provider outage');
  });
  return { glm: { name: 'glm', reason, extractReceipt: vi.fn() } as unknown as GlmAdapter, reason };
}

async function seedConversationWithSlots(
  externalId: string,
  state: string,
  slots: Record<string, string>,
) {
  return prisma.chatConversation.create({
    data: {
      tenantId: TENANT_ID,
      externalId,
      channel: 'web',
      state,
      slots: { create: Object.entries(slots).map(([key, value]) => ({ key, value })) },
    },
  });
}

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
    data: { tenantId: TENANT_ID, name: 'Ana', phone: externalId, status: 'contacted', source: 'web' },
  });
  // La calificación debe quedar completa (igual que en el resto de las
  // pruebas de esta suite): con prospect_name faltante,
  // buildFastQualificationTurn intercepta el turno ANTES de que el mensaje
  // llegue al modelo y nunca se entra al estado scheduling — el brief
  // original solo seedeaba selected_unit_id, lo que rompía el turno con "what
  // first name should I use for you?" en vez de la disponibilidad esperada.
  const conversation = await seedConversationWithSlots(externalId, 'proposing_tour', {
    transaction_intent: 'rent',
    selected_unit_id: unit.id,
    prospect_name: 'Ana',
    preferred_area: 'Vancouver',
    preferred_province: 'British Columbia',
    location_confirmed: 'yes',
    bedrooms: '2',
    pets: 'none',
    budget: '2600',
    move_in_date: 'August',
  });
  await prisma.chatConversation.update({
    where: { id: conversation.id },
    data: { leadId: lead.id, unitId: unit.id },
  });
  return { conversationId: conversation.id, unitId: unit.id, leadId: lead.id };
}

const messaging = new WebChatMockAdapter();

describe('chatbot routing integration (handleInboundMessage)', () => {
  beforeEach(async () => {
    await cleanup();
    await seedTenant();
  });

  afterEach(async () => {
    // El spy sobre getAdapters().showmojo apunta al singleton cacheado por
    // proceso: sin restaurarlo aquí, se quedaría espiando entre pruebas.
    vi.restoreAllMocks();
    await cleanup();
  });

  it('never calls the model before transaction_intent is known — the initial menu turn stays deterministic', async () => {
    const { glm, reason } = glmReturning('{}');

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'routing-greeting-1', body: 'hi', channel: 'web' },
      { glm, messaging },
    );

    expect(reason).not.toHaveBeenCalled();
    expect(reply.replyText).toMatch(/rent|buy|sell/i);
  });

  it('routes a rental conversation through the model once transaction_intent is rent and no deterministic builder matches', async () => {
    const { glm, reason } = glmReturning(JSON.stringify({
      reply: 'Sure — this unit has a dedicated parking stall included.',
      intent: 'discover',
      confidence: 'high',
      profile: { set: {}, clear: [] },
    }));

    // Todos los campos de calificación de renta ya están llenos, así que
    // buildFastQualificationTurn (y por tanto buildDeterministicQualificationTurn)
    // no tiene ninguna pregunta pendiente que hacer para este mensaje ambiguo:
    // ningún builder determinista puede responder esto, por diseño.
    await seedConversationWithSlots('routing-rental-1', 'proposing_tour', {
      transaction_intent: 'rent',
      prospect_name: 'Carlos',
      preferred_area: 'Burnaby',
      preferred_province: 'British Columbia',
      location_confirmed: 'yes',
      bedrooms: '2',
      pets: 'cat',
      budget: '2600',
      move_in_date: 'August',
    });

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'routing-rental-1', body: 'does it have parking?', channel: 'web' },
      { glm, messaging },
    );

    expect(reason).toHaveBeenCalledTimes(1);
    expect(reply.replyText).toBe('Sure — this unit has a dedicated parking stall included.');
  });

  it('routes an ownership (buy) conversation through the model once transaction_intent is buy, never through the deterministic buyer builder', async () => {
    const { glm, reason } = glmReturning(JSON.stringify({
      reply: 'Got it — a $850k budget for a townhouse in Burnaby.',
      intent: 'discover',
      confidence: 'high',
      profile: { set: { purchase_budget: '850000' }, clear: [] },
    }));

    await seedConversationWithSlots('routing-ownership-buy-1', 'collecting_budget', {
      transaction_intent: 'buy',
      prospect_name: 'Sarah',
    });

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'routing-ownership-buy-1', body: 'My budget is around 850k for a townhouse in Burnaby', channel: 'web' },
      { glm, messaging },
    );

    expect(reason).toHaveBeenCalledTimes(1);
    expect(reply.replyText).toBe('Got it — a $850k budget for a townhouse in Burnaby.');
    expect(reply.extractedSlots).toMatchObject({ purchase_budget: '850000' });
  });

  it('routes an ownership (sell) conversation through the model once transaction_intent is sell', async () => {
    const { glm, reason } = glmReturning(JSON.stringify({
      reply: 'Thanks — noted the address and timeline.',
      intent: 'discover',
      confidence: 'high',
      profile: { set: { seller_property_address: '45 Oak Street, Richmond' }, clear: [] },
    }));

    await seedConversationWithSlots('routing-ownership-sell-1', 'collecting_budget', {
      transaction_intent: 'sell',
      prospect_name: 'Marcus',
    });

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'routing-ownership-sell-1', body: 'The property is at 45 Oak Street, Richmond', channel: 'web' },
      { glm, messaging },
    );

    expect(reason).toHaveBeenCalledTimes(1);
    expect(reply.replyText).toBe('Thanks — noted the address and timeline.');
  });

  it('falls back to a real, non-generic deterministic reply for rental when the provider genuinely fails (Finding 1, end-to-end through the real handler)', async () => {
    const { glm, reason } = throwingGlm();

    await seedConversationWithSlots('routing-rental-outage-1', 'proposing_tour', {
      transaction_intent: 'rent',
      prospect_name: 'Carlos',
      preferred_area: 'Burnaby',
      preferred_province: 'British Columbia',
      location_confirmed: 'yes',
      bedrooms: '2',
      pets: 'cat',
      budget: '2600',
      move_in_date: 'August',
    });

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'routing-rental-outage-1', body: 'does it have parking?', channel: 'web' },
      { glm, messaging },
    );

    expect(reason).toHaveBeenCalledTimes(1);
    // Este es exactamente el texto genérico que quedaba atascado antes del
    // fix de la revisión final (Finding 1) — si vuelve a aparecer aquí, el
    // respaldo de renta ante fallo del proveedor volvió a ser código muerto.
    expect(reply.replyText).not.toBe('Could you clarify that in one sentence?');
  });

  it('falls back to the real deterministic ownership builder when the provider genuinely fails for a buy/sell conversation', async () => {
    const { glm, reason } = throwingGlm();

    await seedConversationWithSlots('routing-ownership-outage-1', 'collecting_budget', {
      transaction_intent: 'buy',
    });

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'routing-ownership-outage-1', body: 'My name is Sarah', channel: 'web' },
      { glm, messaging },
    );

    expect(reason).toHaveBeenCalledTimes(1);
    // buildOwnershipConversationTurn's buyerTurn produces this exact
    // template for a name given with no name on file yet — proves the
    // deterministic ownership fallback is genuinely reachable and working,
    // not dead code like the rental fallback was before Finding 1's fix.
    expect(reply.replyText).toContain('pleasure to meet you, Sarah');
  });

  it('creates a lead with source "messenger" for a channel: "messenger" inbound message', async () => {
    const { glm } = glmReturning('{}');

    await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'routing-messenger-1', body: 'hi', channel: 'messenger' },
      { glm, messaging },
    );

    const lead = await prisma.lead.findFirst({
      where: { tenantId: TENANT_ID, phone: 'routing-messenger-1' },
    });
    expect(lead?.source).toBe('messenger');
    expect(lead?.preferredChannel).toBe('messenger');
  });

  it('marks Lead.optedOutAt when an inbound message contains an explicit opt-out phrase', async () => {
    const { glm } = glmReturning('{"reply":"Entendido.","intent":"other","slots":{},"profile":{"set":{},"clear":[]},"confidence":"low"}');

    await handleInboundMessage(
      { tenantId: TENANT_ID, from: '+16045550199', body: 'Hola, busco depa de 2 recámaras', channel: 'web' },
      { glm, messaging },
    );
    await handleInboundMessage(
      { tenantId: TENANT_ID, from: '+16045550199', body: 'ya no me manden mensajes por favor', channel: 'web' },
      { glm, messaging },
    );

    const lead = await prisma.lead.findFirst({ where: { tenantId: TENANT_ID, phone: '+16045550199' } });
    expect(lead?.optedOutAt).not.toBeNull();
  });

  it('does not mark Lead.optedOutAt for an ordinary message', async () => {
    const { glm } = glmReturning('{"reply":"Claro, cuéntame más.","intent":"other","slots":{},"profile":{"set":{},"clear":[]},"confidence":"low"}');

    await handleInboundMessage(
      { tenantId: TENANT_ID, from: '+16045550198', body: 'Hola, busco depa de 2 recámaras', channel: 'web' },
      { glm, messaging },
    );

    const lead = await prisma.lead.findFirst({ where: { tenantId: TENANT_ID, phone: '+16045550198' } });
    expect(lead?.optedOutAt).toBeNull();
  });

  it('does not false-positive on a curly-quote "don\'t" negation (Fix 8)', async () => {
    const { glm } = glmReturning('{"reply":"Claro.","intent":"other","slots":{},"profile":{"set":{},"clear":[]},"confidence":"low"}');

    await handleInboundMessage(
      { tenantId: TENANT_ID, from: '+16045550197', body: 'Hi, I’m looking for a 2 bedroom', channel: 'web' },
      { glm, messaging },
    );
    // Curly/smart apostrophe (U+2019), what iOS/Android autocorrect actually
    // produces — the negative lookbehind in OPT_OUT_PATTERNS only matches
    // the ASCII apostrophe, so without normalizing smart quotes first this
    // would false-positive as an opt-out despite the "don't" negation.
    await handleInboundMessage(
      { tenantId: TENANT_ID, from: '+16045550197', body: 'please don’t unsubscribe me, I love this', channel: 'web' },
      { glm, messaging },
    );

    const lead = await prisma.lead.findFirst({ where: { tenantId: TENANT_ID, phone: '+16045550197' } });
    expect(lead?.optedOutAt).toBeNull();
  });

  it('sin calendario conectado no ofrece horarios, pasa a handoff y no crea showings', async () => {
    const { conversationId } = await seedReadyToSchedule('+16045550111');
    // El mock de GLM debe devolver el JSON estructurado que interpretRentalTurn
    // espera (no texto libre): intent 'request_tour' es lo que hace que el
    // turno entre al estado scheduling.
    const { glm } = glmReturning(JSON.stringify({
      reply: 'Sure, let us book a tour.',
      intent: 'request_tour',
      confidence: 'high',
      profile: { set: {}, clear: [] },
    }));

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: '+16045550111', body: 'quiero agendar una visita', channel: 'web' },
      { glm, messaging: new WebChatMockAdapter() },
    );

    expect(reply.replyText.toLowerCase()).toContain('advisor');
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
    const { glm } = glmReturning(JSON.stringify({
      reply: 'Sure, let us book a tour.',
      intent: 'request_tour',
      confidence: 'high',
      profile: { set: {}, clear: [] },
    }));
    // La producción llega a ShowMojo (si es que llegara, que sería
    // justamente la regresión que esta prueba busca atrapar) a través del
    // singleton cacheado de getAdapters().showmojo — espiar una instancia
    // local de ShowMojoMockAdapter que nunca se inyecta a nadie no prueba
    // nada, porque jamás podría ser llamada sin importar lo que haga el
    // código real.
    const { getAdapters } = await import('../config/adapters.js');
    const spy = vi.spyOn(getAdapters().showmojo, 'getAvailableSlots');

    await handleInboundMessage(
      { tenantId: TENANT_ID, from: '+16045550222', body: 'quiero agendar una visita', channel: 'web' },
      { glm, messaging: new WebChatMockAdapter() },
    );

    expect(spy).not.toHaveBeenCalled();
  });

  it('no responde ni llama a GLM cuando la conversación está en handoff', async () => {
    // Fase 1.2: `handoff` ya se usa en tres lugares (booking exitoso, sin
    // calendario conectado, pausa manual del staff) pero nada verificaba
    // ese estado antes de este guard — el bot seguía auto-respondiendo.
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
    const messagingSpy = { channel: 'web', send, parseWebhook: vi.fn() } as unknown as MessagingAdapter;

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'web:handoff-guard-1', body: 'hello?', channel: 'web' },
      { glm, messaging: messagingSpy },
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
});
