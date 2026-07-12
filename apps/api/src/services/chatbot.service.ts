/**
 * Omnichannel chatbot with a conversation state machine.
 *
 * The bot uses structured GLM output, keeps conversation history, collects
 * prospect slots, proposes units, and hands scheduling off to ShowMojo.
 */
import type { GlmAdapter, MessagingAdapter, ShowMojoAdapter } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { writeAudit } from './audit.service.js';
import { getAvailableSlots, scheduleTour } from './scheduling.service.js';

export type ConversationState =
  | 'greeting'
  | 'collecting_budget'
  | 'collecting_movein'
  | 'proposing_units'
  | 'proposing_tour'
  | 'scheduling'
  | 'handoff';

export interface InboundChatMessage {
  tenantId: string;
  from: string;
  body: string;
  channel: 'whatsapp' | 'sms' | 'telegram' | 'web' | 'email';
  mediaUrls?: string[];
}

export interface BotReply {
  replyText: string;
  newState: ConversationState;
  leadCreated: boolean;
  handoff: boolean;
  extractedSlots?: Record<string, string>;
  proposedUnits?: Array<{ id: string; name: string; rent: number }>;
}

export interface AvailableUnit {
  id: string;
  name: string;
  rentCents: number;
  city: string;
  propertyName: string;
  bedrooms: number | null;
  bathrooms: number | null;
  availableFrom: Date | null;
  petPolicy: string | null;
}

export async function handleInboundMessage(
  input: InboundChatMessage,
  deps: { glm: GlmAdapter; messaging: MessagingAdapter; showmojo: ShowMojoAdapter },
): Promise<BotReply> {
  const externalId = getConversationExternalId(input);
  const conversation = await prisma.chatConversation.upsert({
    where: {
      tenantId_externalId: { tenantId: input.tenantId, externalId },
    },
    update: { channel: input.channel },
    create: {
      tenantId: input.tenantId,
      externalId,
      channel: input.channel,
      state: 'greeting',
    },
    include: {
      messages: { orderBy: { createdAt: 'asc' }, take: 20 },
      slots: true,
    },
  });

  await prisma.chatMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'user',
      content: input.body,
      mediaUrls: input.mediaUrls ?? [],
    },
  });

  const existingSlots: Record<string, string> = {};
  for (const slot of conversation.slots) {
    existingSlots[slot.key] = slot.value;
  }
  const availableUnits = await getAvailableUnits(input.tenantId, existingSlots);
  const currentState = conversation.state as ConversationState;

  const glmResult = await callGlm(deps.glm, {
    currentState,
    tenantId: input.tenantId,
    userMessage: input.body,
    history: conversation.messages.map((m) => ({ role: m.role, content: m.content })),
    existingSlots,
    availableUnits,
  });

  if (glmResult.slots) {
    for (const [key, value] of Object.entries(glmResult.slots)) {
      if (value) {
        await prisma.conversationSlot.upsert({
          where: { conversationId_key: { conversationId: conversation.id, key } },
          update: { value },
          create: { conversationId: conversation.id, key, value },
        });
      }
    }
  }

  const effectiveSlots = { ...existingSlots, ...(glmResult.slots ?? {}) };
  const matchingUnits = rankMatchingUnits(await getAvailableUnits(input.tenantId, effectiveSlots), effectiveSlots);
  const recommendedUnit = matchingUnits[0];
  const matchReason = recommendedUnit ? buildUnitMatchReason(recommendedUnit, effectiveSlots) : undefined;

  let newState = glmResult.next_state ?? currentState;
  let finalReply = glmResult.reply;

  if (newState === 'proposing_tour' && matchingUnits.length > 0) {
    finalReply = buildUnitRecommendationReply(matchingUnits, effectiveSlots);
    if (recommendedUnit) {
      await prisma.chatConversation.update({
        where: { id: conversation.id },
        data: { unitId: recommendedUnit.id },
      });
      await prisma.conversationSlot.upsert({
        where: { conversationId_key: { conversationId: conversation.id, key: 'match_reason' } },
        update: { value: matchReason ?? '' },
        create: { conversationId: conversation.id, key: 'match_reason', value: matchReason ?? '' },
      });
      await prisma.conversationSlot.upsert({
        where: { conversationId_key: { conversationId: conversation.id, key: 'recommended_unit_id' } },
        update: { value: recommendedUnit.id },
        create: { conversationId: conversation.id, key: 'recommended_unit_id', value: recommendedUnit.id },
      });
    }
  }

  if (newState === 'scheduling' && currentState !== 'scheduling') {
    const unitId = conversation.unitId ?? recommendedUnit?.id ?? (await inferUnitFromSlots(input.tenantId, effectiveSlots));
    if (unitId) {
      const slotsResult = await getAvailableSlots(input.tenantId, unitId, deps.showmojo);
      if (slotsResult.slots.length > 0) {
        await prisma.conversationSlot.upsert({
          where: { conversationId_key: { conversationId: conversation.id, key: 'pending_slots' } },
          update: { value: JSON.stringify(slotsResult.slots) },
          create: { conversationId: conversation.id, key: 'pending_slots', value: JSON.stringify(slotsResult.slots) },
        });
        await prisma.conversationSlot.upsert({
          where: { conversationId_key: { conversationId: conversation.id, key: 'scheduling_unit_id' } },
          update: { value: unitId },
          create: { conversationId: conversation.id, key: 'scheduling_unit_id', value: unitId },
        });

        const slotsText = slotsResult.slots.map((slot) => `${slot.index + 1}. ${slot.label}`).join('\n');
        finalReply =
          `Perfect. These are the available tour times:\n\n` +
          `${slotsText}\n\n` +
          `Reply with the number of the option you prefer (1-${slotsResult.slots.length}).`;
      }
    }
  } else if (currentState === 'scheduling') {
    const slotChoice = parseInt(input.body.trim(), 10);
    const pendingSlotsRaw = existingSlots['pending_slots'];
    const schedulingUnitId = existingSlots['scheduling_unit_id'];

    if (!isNaN(slotChoice) && pendingSlotsRaw && schedulingUnitId) {
      const pendingSlots = JSON.parse(pendingSlotsRaw) as Array<{
        index: number;
        startAt: string;
        endAt: string;
        brokerName?: string;
      }>;
      const chosen = pendingSlots.find((slot) => slot.index === slotChoice - 1);
      if (chosen) {
        const lead = await prisma.lead.findFirst({
          where: { phone: input.from },
        });
        if (lead) {
          try {
            const result = await scheduleTour({
              tenantId: input.tenantId,
              unitId: schedulingUnitId,
              leadId: lead.id,
              slotIndex: chosen.index,
              prospectName: lead.name ?? lead.phone ?? 'Prospect',
              prospectPhone: lead.phone ?? undefined,
              prospectEmail: lead.email ?? undefined,
              conversationId: conversation.id,
              adapter: deps.showmojo,
            });
            finalReply =
              `Tour scheduled.\n\n` +
              `${new Date(result.scheduledAt).toLocaleDateString('en-CA', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })} at ${new Date(result.scheduledAt).toLocaleTimeString('en-CA', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              })}\n\n` +
              `The broker will confirm availability shortly. Should I send the confirmation here or through another channel?`;
            newState = 'handoff';
          } catch {
            finalReply = 'There was a problem scheduling the tour. Would you like to try another time?';
            newState = 'scheduling';
          }
        }
      }
    }
  }

  await prisma.chatConversation.update({
    where: { id: conversation.id },
    data: { state: newState, ...(recommendedUnit ? { unitId: recommendedUnit.id } : {}) },
  });

  await prisma.chatMessage.create({
    data: { conversationId: conversation.id, role: 'assistant', content: finalReply },
  });

  const leadCreated = await ensureLead(input.tenantId, conversation.id, input.from, input.body, input.channel, recommendedUnit?.id);

  await deps.messaging.send({
    to: input.from,
    body: finalReply,
    channel: input.channel,
  });

  await writeAudit({
    tenantId: input.tenantId,
    actorId: 'chatbot_agent',
    actorType: 'ai_agent',
    action: 'chatbot.message_handled',
    entityType: 'chat_conversation',
    entityId: conversation.id,
    payload: {
      from: input.from,
      channel: input.channel,
      newState,
      handoff: newState === 'handoff',
      leadCreated,
      slots: glmResult.slots,
    },
  });

  return {
    replyText: finalReply,
    newState,
    leadCreated,
    handoff: newState === 'handoff',
    extractedSlots: glmResult.slots,
    proposedUnits: newState === 'proposing_tour'
      ? matchingUnits.slice(0, 3).map((unit) => ({
        id: unit.id,
        name: unit.name,
        rent: unit.rentCents,
      }))
      : undefined,
  };
}

async function callGlm(
  glm: GlmAdapter,
  ctx: {
    currentState: ConversationState;
    tenantId: string;
    userMessage: string;
    history: Array<{ role: string; content: string }>;
    existingSlots: Record<string, string>;
    availableUnits: AvailableUnit[];
  },
): Promise<{
  reply: string;
  slots?: Record<string, string>;
  next_state?: ConversationState;
}> {
  const knowledgeContext = await getTenantKnowledgeContext(ctx.tenantId);
  const systemPrompt = buildSystemPrompt(
    ctx.currentState,
    ctx.availableUnits,
    ctx.existingSlots,
    knowledgeContext,
  );
  const historyText = ctx.history
    .slice(-10)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');

  try {
    const res = await glm.reason({
      systemPrompt,
      userPrompt: `History:\n${historyText}\n\nCurrent user message: ${ctx.userMessage}`,
      responseSchema: {
        type: 'object',
        properties: {
          reply: { type: 'string', description: 'Bot reply to the user (max 2-3 sentences)' },
          slots: {
            type: 'object',
            description: 'Information extracted from the message (budget, move_in_date, occupants, pets, etc.)',
            properties: {
              budget: { type: 'string' },
              move_in_date: { type: 'string' },
              occupants: { type: 'string' },
              pets: { type: 'string' },
              preferred_area: { type: 'string' },
            },
          },
          next_state: {
            type: 'string',
            enum: ['greeting', 'collecting_budget', 'collecting_movein', 'proposing_units', 'proposing_tour', 'scheduling', 'handoff'],
          },
        },
        required: ['reply', 'next_state'],
      },
      temperature: 0.7,
    });

    const parsed = JSON.parse(res.content) as {
      reply: string;
      slots?: Record<string, string>;
      next_state?: ConversationState;
    };
    return {
      reply: parsed.reply ?? 'What else can I help with?',
      slots: parsed.slots,
      next_state: parsed.next_state,
    };
  } catch {
    return {
      reply: 'Thanks for your message. What is your monthly budget, and when would you like to move in?',
      next_state: ctx.currentState === 'greeting' ? 'collecting_budget' : ctx.currentState,
    };
  }
}

function buildSystemPrompt(
  state: ConversationState,
  availableUnits: Array<AvailableUnit>,
  slots: Record<string, string>,
  knowledgeContext = '',
): string {
  const unitsText = availableUnits.length > 0
    ? availableUnits.map((unit) => {
      const details = [
        unit.bedrooms !== null ? `${unit.bedrooms} bed` : undefined,
        unit.bathrooms !== null ? `${unit.bathrooms} bath` : undefined,
        unit.petPolicy ?? undefined,
      ].filter(Boolean).join(', ');
      return `- ${unit.propertyName} ${unit.name} in ${unit.city}: $${(unit.rentCents / 100).toFixed(0)}/month${details ? ` (${details})` : ''}`;
    }).join('\n')
    : 'There are no available units right now.';

  const slotsText = Object.keys(slots).length > 0
    ? '\nKnown user information:\n' + Object.entries(slots).map(([key, value]) => `  ${key}: ${value}`).join('\n')
    : '';

  return [
    'You are the virtual assistant for a Property Management company in British Columbia, Canada.',
    'You answer inquiries from people interested in renting properties.',
    'Reply in a friendly, concise, professional tone. Use at most 2-3 sentences per message.',
    'Do not provide legal or financial advice; hand those questions off to a human.',
    'Your goal is to qualify the prospect and schedule a property tour.',
    '',
    `Current conversation state: ${state}`,
    'Funnel states: greeting -> collecting_budget -> collecting_movein -> proposing_units -> proposing_tour -> scheduling -> handoff',
    '- greeting: initial greeting, ask what the prospect is looking for',
    '- collecting_budget: ask for monthly budget',
    '- collecting_movein: ask for move-in date',
    '- proposing_units: suggest matching units',
    '- proposing_tour: offer to schedule a tour',
    '- scheduling: move into tour scheduling through ShowMojo',
    '- handoff: hand off to a human when the question is out of scope',
    '',
    'Available units:',
    unitsText,
    slotsText,
    knowledgeContext ? `\nCompany/property knowledge:\n${knowledgeContext}` : '',
    '',
    'Reply in JSON with: reply (your message), slots (extracted info), next_state (next state).',
  ].join('\n');
}

async function getTenantKnowledgeContext(tenantId: string): Promise<string> {
  const [onboarding, documents] = await Promise.all([
    prisma.tenantOnboardingProfile.findUnique({ where: { tenantId } }),
    prisma.knowledgeDocument.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: { filename: true, category: true, description: true, textContent: true },
    }),
  ]);

  const lines: string[] = [];
  if (onboarding) {
    if (onboarding.aiTone) lines.push(`Tone: ${onboarding.aiTone}`);
    if (onboarding.aiInstructions) lines.push(`Instructions: ${onboarding.aiInstructions}`);
    if (onboarding.pricingNotes) lines.push(`Pricing: ${onboarding.pricingNotes}`);
    if (onboarding.showingPreferences) lines.push(`Showing preferences: ${onboarding.showingPreferences}`);
    if (onboarding.petPolicy) lines.push(`Default pet policy: ${onboarding.petPolicy}`);
  }
  for (const document of documents) {
    const detail = document.textContent ?? document.description;
    if (detail) lines.push(`${document.category} document ${document.filename}: ${detail.slice(0, 700)}`);
  }
  return lines.join('\n');
}

async function getAvailableUnits(
  tenantId: string,
  slots: Record<string, string>,
): Promise<AvailableUnit[]> {
  const budget = slots.budget ? parseInt(slots.budget.replace(/[^0-9]/g, '')) * 100 : undefined;
  const units = await prisma.unit.findMany({
    where: {
      tenantId,
      isActive: true,
      ...(budget ? { rentCents: { lte: budget } } : {}),
    },
    include: { property: { select: { name: true, city: true } } },
    take: 5,
  });
  return units.map((unit) => ({
    id: unit.id,
    name: unit.name,
    rentCents: unit.rentCents,
    propertyName: unit.property.name,
    city: unit.property.city,
    bedrooms: unit.bedrooms,
    bathrooms: unit.bathrooms,
    availableFrom: unit.availableFrom,
    petPolicy: unit.petPolicy,
  }));
}

async function inferUnitFromSlots(
  tenantId: string,
  slots: Record<string, string>,
): Promise<string | null> {
  const units = await getAvailableUnits(tenantId, slots);
  return units[0]?.id ?? null;
}

async function ensureLead(
  tenantId: string,
  conversationId: string,
  fromPhone: string,
  firstMessage: string,
  channel: string,
  unitId?: string,
): Promise<boolean> {
  const existing = await prisma.lead.findFirst({
    where: { tenantId, phone: fromPhone },
  });
  if (existing) {
    await prisma.lead.update({
      where: { id: existing.id },
      data: { ...getExistingLeadChannelUpdate(channel), ...(unitId ? { unitId } : {}) },
    });
    await prisma.chatConversation.update({
      where: { id: conversationId },
      data: { leadId: existing.id },
    });
    return false;
  }

  const lead = await prisma.lead.create({
    data: {
      tenantId,
      phone: fromPhone,
      message: firstMessage.slice(0, 500),
      source: getLeadSourceForChannel(channel),
      status: 'new_',
      preferredChannel: channel,
      unitId,
    },
  });
  await prisma.chatConversation.update({
    where: { id: conversationId },
    data: { leadId: lead.id },
  });
  return true;
}

function getLeadSourceForChannel(channel: string): 'telegram' | 'web' | 'email' | 'sms' | 'whatsapp' {
  if (channel === 'telegram') return 'telegram';
  if (channel === 'web') return 'web';
  if (channel === 'email') return 'email';
  if (channel === 'sms') return 'sms';
  return 'whatsapp';
}

export function getConversationExternalId(input: Pick<InboundChatMessage, 'channel' | 'from'>): string {
  if (['sms', 'whatsapp', 'telegram'].includes(input.channel)) {
    return `${input.channel}:${input.from}`;
  }
  return input.from;
}

export function getReplyAddressFromConversation(externalId: string): string {
  return externalId.replace(/^(sms|whatsapp|telegram):/, '');
}

export function getExistingLeadChannelUpdate(channel: string): { preferredChannel: string } {
  return { preferredChannel: channel };
}

export function rankMatchingUnits(units: AvailableUnit[], slots: Record<string, string>): AvailableUnit[] {
  return [...units].sort((a, b) => scoreUnit(b, slots) - scoreUnit(a, slots));
}

export function buildUnitMatchReason(unit: AvailableUnit, slots: Record<string, string>): string {
  const reasons: string[] = [];
  const budget = parseBudget(slots.budget);
  const area = slots.preferred_area?.toLowerCase();
  const pets = slots.pets?.toLowerCase();
  const occupants = parseInt(slots.occupants ?? '', 10);
  const moveInMonth = normalizeMonth(slots.move_in_date);

  if (budget && unit.rentCents <= budget) reasons.push(`fits the $${(budget / 100).toLocaleString('en-CA')} budget`);
  if (area && (`${unit.city} ${unit.propertyName}`).toLowerCase().includes(area)) reasons.push(`matches the ${slots.preferred_area} area`);
  if (pets && pets !== 'none' && unit.petPolicy?.toLowerCase().includes(pets)) reasons.push(`supports ${pets} needs`);
  if (!Number.isNaN(occupants) && unit.bedrooms !== null && unit.bedrooms >= Math.min(occupants, 3)) reasons.push(`has enough bedrooms for ${occupants} people`);
  if (moveInMonth && unit.availableFrom && unit.availableFrom.toLocaleString('en-CA', { month: 'long' }).toLowerCase() === moveInMonth) reasons.push(`aligns with the ${slots.move_in_date} move-in timing`);

  return reasons.length > 0 ? reasons.join(', ') : 'it is an active listing in the current inventory';
}

export function buildStaffOverrideMatchReason(propertyName: string, unitName: string): string {
  return `Selected by staff override: ${propertyName} ${unitName}.`;
}

function scoreUnit(unit: AvailableUnit, slots: Record<string, string>): number {
  let score = 0;
  const budget = parseBudget(slots.budget);
  const area = slots.preferred_area?.toLowerCase();
  const pets = slots.pets?.toLowerCase();
  const occupants = parseInt(slots.occupants ?? '', 10);
  const moveInMonth = normalizeMonth(slots.move_in_date);

  if (budget) {
    score += unit.rentCents <= budget ? 30 : -20;
    score -= Math.max(0, unit.rentCents - budget) / 10000;
  }
  if (area && (`${unit.city} ${unit.propertyName}`).toLowerCase().includes(area)) score += 25;
  if (pets && pets !== 'none' && unit.petPolicy?.toLowerCase().includes(pets)) score += 15;
  if (!Number.isNaN(occupants) && unit.bedrooms !== null && unit.bedrooms >= Math.min(occupants, 3)) score += 10;
  if (moveInMonth && unit.availableFrom && unit.availableFrom.toLocaleString('en-CA', { month: 'long' }).toLowerCase() === moveInMonth) score += 10;
  return score;
}

function parseBudget(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value.replace(/[^0-9]/g, ''), 10);
  return Number.isNaN(parsed) ? undefined : parsed * 100;
}

function normalizeMonth(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/january|february|march|april|may|june|july|august|september|october|november|december/i);
  return match?.[0].toLowerCase();
}

function buildUnitRecommendationReply(units: AvailableUnit[], slots: Record<string, string>): string {
  const options = units.slice(0, 3).map((unit) => {
    const details = [
      unit.bedrooms !== null ? `${unit.bedrooms} bed` : undefined,
      unit.bathrooms !== null ? `${unit.bathrooms} bath` : undefined,
      unit.petPolicy ?? undefined,
      unit.availableFrom ? `available ${unit.availableFrom.toLocaleDateString('en-CA')}` : undefined,
    ].filter(Boolean).join(', ');
    const suffix = details ? ` (${details})` : '';
    return `- ${unit.propertyName} ${unit.name} in ${unit.city}: $${(unit.rentCents / 100).toLocaleString('en-CA')}/month${suffix}`;
  }).join('\n');
  const reason = buildUnitMatchReason(units[0], slots);

  return `Thanks. Based on your criteria, these active listings may fit:\n\n${options}\n\nBest match: ${units[0].propertyName} ${units[0].name}, because it ${reason}. Would you like to schedule a tour?`;
}
