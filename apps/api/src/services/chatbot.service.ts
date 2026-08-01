/**
 * Omnichannel chatbot with a conversation state machine.
 *
 * The bot uses structured GLM output, keeps conversation history, collects
 * prospect slots, proposes units, and hands scheduling off to ShowMojo.
 */
import type { GlmAdapter, MessagingAdapter, ShowMojoAdapter } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { writeAudit } from './audit.service.js';
import { formatKnowledgeContext, rankKnowledgeChunks } from './knowledge-retrieval.service.js';
import { getAvailableSlots, scheduleTour } from './scheduling.service.js';
import { createShortlist, rotateShortlistToken } from './shortlist.service.js';
import { nextDeliveryRetryAt } from './message-delivery-retry.service.js';
import { buildOwnershipConversationTurn } from './ownership-conversation.service.js';
import {
  buildRentalAreaAccepted,
  buildRentalAreaConfirmation,
  buildRentalAreaPriorityBudgetReply,
  buildRentalAreaQuestion,
  buildRentalAreaRetry,
  buildRentalBudgetQuestion,
  buildRentalBedroomsQuestion,
  buildRentalIntentReply,
  buildRentalMoveInAcknowledgement,
  buildRentalMoveInQuestion,
  buildRentalNameClarification,
  buildRentalNamePrompt,
  buildRentalNoInventoryAreaPriorityReply,
  buildRentalOpeningReply,
  buildRentalPetFollowup,
  buildRentalPetsQuestion,
  buildRentalSameBudgetLoopReply,
  buildRentalWelcomeByName,
} from './rental-conversation.service.js';

export type ConversationState =
  | 'greeting'
  | 'collecting_budget'
  | 'collecting_movein'
  | 'proposing_units'
  | 'proposing_tour'
  | 'scheduling'
  | 'handoff';

const RECOMMENDATION_STATE_SLOT_KEYS = [
  'selected_unit_id',
  'recommended_unit_id',
  'scheduling_unit_id',
  'pending_slots',
  'match_reason',
  'shortlist_scope',
] as const;

const SEARCH_CRITERIA_SLOT_KEYS = [
  'preferred_area', 'preferred_province', 'bedrooms', 'bedrooms_min', 'bedrooms_max',
  'pets', 'budget', 'move_in_date',
] as const;

export function recommendationStateSlotsToClear(
  existingSlots: Record<string, string>,
  incomingSlots: Record<string, string>,
): string[] {
  const criteriaChanged = SEARCH_CRITERIA_SLOT_KEYS.some((key) =>
    Boolean(incomingSlots[key])
    && Boolean(existingSlots[key])
    && incomingSlots[key].toLowerCase() !== existingSlots[key].toLowerCase(),
  );
  return criteriaChanged ? [...RECOMMENDATION_STATE_SLOT_KEYS] : [];
}

export function shouldPrioritizeSearchCriteria(
  _existingSlots: Record<string, string>,
  incomingSlots: Record<string, string>,
): boolean {
  return SEARCH_CRITERIA_SLOT_KEYS.some((key) => Boolean(incomingSlots[key]));
}

export function canResolveActiveShortlist(state: ConversationState): boolean {
  return state === 'proposing_tour' || state === 'proposing_units';
}

export function resolveSingleOptionAffirmation(message: string, unitIds: string[]): string | undefined {
  if (unitIds.length !== 1) return undefined;
  const normalized = message.trim().toLowerCase().replace(/[.!?]+$/g, '');
  return /^(?:yes|y|yeah|yep|sure|ok|okay|that one|the one|option 1|first one)$/.test(normalized)
    ? unitIds[0]
    : undefined;
}

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
  province?: string;
  propertyName: string;
  address?: string;
  bedrooms: number | null;
  bathrooms: number | null;
  availableFrom: Date | null;
  petPolicy: string | null;
  parking?: string | null;
  utilities?: string | null;
  slug?: string;
  photoUrl?: string;
  photoUrls?: string[];
  landingUrl?: string;
}

export type ConversationIntent =
  | 'start'
  | 'rent'
  | 'buy'
  | 'sell'
  | 'provide_information'
  | 'confirm'
  | 'correct_information'
  | 'ask_clarification'
  | 'request_matches'
  | 'request_more_options'
  | 'select_options'
  | 'schedule_tour'
  | 'handoff'
  | 'other';

export interface InterpretedTurn {
  reply: string;
  intent?: ConversationIntent;
  slots?: Record<string, string>;
  selected_options?: number[];
  selection_scope?: 'single' | 'multiple' | 'all';
  next_state?: ConversationState;
  clearSlots?: string[];
}

export function shouldUseDeterministicFastPath(message: string): boolean {
  return /^\/(start|begin|reset)(\b|$)/i.test(message.trim());
}

export function sanitizeInterpretedTurn(turn: InterpretedTurn): InterpretedTurn {
  const slots: Record<string, string> = {};
  for (const [key, value] of Object.entries(turn.slots ?? {}) as Array<[string, unknown]>) {
    if (typeof value === 'string') slots[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') slots[key] = String(value);
  }
  return { ...turn, slots };
}

export function buildPostTourAcknowledgement(
  message: string,
  prospectName?: string,
): InterpretedTurn | undefined {
  const normalized = message.trim().toLowerCase().replace(/[.!]+$/g, '');
  if (!/^(?:(?:ok(?:ay)?|alright|perfect|great)[,\s]*)?(?:thanks|thank you|thank u|thx)(?: so much)?$|^(?:ok(?:ay)?|got it|sounds good|perfect|great|see you then|talk soon|that'?s all|i'?ll be there|have a good day)$/.test(normalized)) {
    return undefined;
  }
  const name = prospectName?.trim();
  return {
    reply: `You're very welcome${name ? `, ${name}` : ''}. Your tour is all set. If anything changes or you have a question before the visit, just send me a message here.`,
    slots: {},
    next_state: 'handoff',
  };
}

export function buildPostTourContextTurn(
  message: string,
  slots: Record<string, string>,
): InterpretedTurn | undefined {
  if (!slots.tour_scheduled_at) return undefined;
  const normalized = message.toLowerCase();
  if (/^(?:here|telegram|in this chat|this chat)$/i.test(message.trim())) {
    return {
      reply: "Absolutely — I’ll keep the confirmation and any updates right here in Telegram.",
      slots: { confirmation_channel: 'telegram' },
      next_state: 'handoff',
    };
  }
  if (/\b(?:address|where is it|location|directions)\b/.test(normalized) && slots.scheduled_unit_address) {
    return {
      reply: `Of course. Your tour is at:\n${formatStoredAddress(slots.scheduled_unit_address)}${slots.scheduled_unit_label ? `\nfor ${slots.scheduled_unit_label}` : ''}.`,
      slots: {},
      next_state: 'handoff',
    };
  }
  if (/\b(?:reschedule|change (?:the )?(?:time|date)|another time)\b/.test(normalized)) {
    return {
      reply: "Of course — I can help you reschedule. Tell me which day or time would work better, and I’ll check the available alternatives.",
      slots: { post_tour_action: 'reschedule' },
      next_state: 'handoff',
    };
  }
  if (/\b(?:cancel|cannot make it|can't make it|won't make it)\b/.test(normalized)) {
    return {
      reply: "I can help with that. I’ll treat this as a cancellation request and make sure the property manager is notified.",
      slots: { post_tour_action: 'cancel' },
      next_state: 'handoff',
    };
  }
  if (/\b(?:what.*bring|documents?|identification|id)\b/.test(normalized)) {
    return {
      reply: "You normally only need a piece of photo ID for the visit. If the property manager needs anything else, they’ll let you know here.",
      slots: {},
      next_state: 'handoff',
    };
  }
  if (/\b(?:who.*meet|who.*show|agent|broker)\b/.test(normalized)) {
    return {
      reply: "The assigned property representative will meet you there. I’ll keep any confirmation or updated instructions in this conversation.",
      slots: {},
      next_state: 'handoff',
    };
  }
  return buildPostTourAcknowledgement(message, slots.prospect_name);
}

export function buildFocusedPropertyAnswer(
  message: string,
  unit: AvailableUnit | undefined,
): { answer: string; resume: true; action?: 'photos' } | undefined {
  if (!unit) return undefined;
  const normalized = message.toLowerCase();
  const label = `${unit.propertyName} — ${unit.name}`;
  if (/^\s*(?:pictures?|photos?|images?|show me (?:the )?(?:pictures?|photos?))\s*[.!?]*$/i.test(message)) {
    return {
      answer: `Of course — here are the photos for ${label}.`,
      resume: true,
      action: 'photos',
    };
  }
  if (/\bparking|park\b/.test(normalized)) {
    return {
      answer: unit.parking
        ? `Yes — ${label} includes ${unit.parking}.`
        : `I don’t have confirmed parking details for ${label}, so I’d rather verify that than guess.`,
      resume: true,
    };
  }
  if (/\bpets?|cats?|dogs?\b/.test(normalized) && /\?|does|allow|accept/.test(normalized)) {
    return {
      answer: unit.petPolicy
        ? `${label} lists its pet policy as: ${unit.petPolicy}.`
        : `The pet policy for ${label} still needs to be confirmed.`,
      resume: true,
    };
  }
  if (/\baddress|where is (?:it|that)\b/.test(normalized) && unit.address) {
    return {
      answer: `${label} is at:\n${formatReadableAddress(unit.address, unit.city, unit.province)}.`,
      resume: true,
    };
  }
  return undefined;
}

export function buildOptionDeclineTurn(
  message: string,
  slots: Record<string, string>,
): InterpretedTurn | undefined {
  if (
    slots.recommendation_kind !== 'alternative'
    || !/^(?:no|nope|not really|that won'?t work)[.!]?$/i.test(message.trim())
  ) return undefined;
  const bedrooms = Number.parseInt(slots.bedrooms ?? '', 10);
  const bedroomWords: Record<number, string> = { 0: 'studio', 1: 'one-bedroom', 2: 'two-bedroom', 3: 'three-bedroom', 4: 'four-bedroom' };
  const requirement = bedroomWords[bedrooms] ?? `${slots.bedrooms}-bedroom`;
  return {
    reply:
      `Understood — I won’t relax the ${requirement} requirement. ` +
      `I don’t currently have an exact match in ${slots.preferred_area ?? 'that area'} within the $${Number(slots.budget ?? 0).toLocaleString('en-CA')} budget. ` +
      `Would you rather keep the area and revisit the budget, or keep the budget and consider a nearby city?`,
    slots: {},
    next_state: 'collecting_movein',
  };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
};

function conversationalNumber(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? NUMBER_WORDS[value.toLowerCase()] : parsed;
}

export function extractContextualConversationSlots(
  message: string,
  existingSlots: Record<string, string>,
): Record<string, string> {
  const normalized = message.trim().toLowerCase();
  if (
    /\b(?:not sure|don'?t know|do not know|need to think|maybe later|haven'?t decided)\b/i.test(normalized)
    || /\b(?:don'?t understand|do not understand|what do you mean|why do you need)\b/i.test(normalized)
  ) return {};

  const slots: Record<string, string> = {};
  const bedroomRange = normalized.match(/\b(one|two|three|four|\d)\s+(?:or|to|-)\s+(one|two|three|four|\d)\s+bedrooms?\b/);
  if (bedroomRange) {
    const first = conversationalNumber(bedroomRange[1]);
    const second = conversationalNumber(bedroomRange[2]);
    if (first !== undefined && second !== undefined) {
      slots.bedrooms_min = String(Math.min(first, second));
      slots.bedrooms_max = String(Math.max(first, second));
    }
  } else {
    const bedrooms = normalized.match(/\b(one|two|three|four|five|\d)(\+)?\s*bedrooms?\b/);
    const value = bedrooms ? conversationalNumber(bedrooms[1]) : undefined;
    if (value !== undefined) slots.bedrooms = `${value}${bedrooms?.[2] ?? ''}`;
  }

  const stretchBudget = normalized.replace(/,/g, '').match(/\b(?:stretch|maximum|max|up to)\D{0,12}\$?\s*(\d{3,5})\b/);
  const preferredBudget = normalized.replace(/,/g, '').match(/\b(?:around|about|ideally|prefer)\D{0,12}\$?\s*(\d{3,5})\b/);
  const allAmounts = [...normalized.replace(/,/g, '').matchAll(/\$?\s*(\d{3,5})\b/g)].map((match) => match[1]);
  const looksLikeMonthAndYear = /\b(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/.test(normalized)
    && /\b20\d{2}\b/.test(normalized);
  if (preferredBudget) slots.budget_preferred = preferredBudget[1];
  if (stretchBudget) slots.budget = stretchBudget[1];
  else if (
    allAmounts.length === 1
    && !looksLikeMonthAndYear
    && (existingSlots.budget || /\b(?:budget|rent|month|monthly|maximum|max)\b/.test(normalized))
  ) {
    slots.budget = allAmounts[0];
  }

  if (/\bcats?\b/.test(normalized)) slots.pets = 'cat';
  else if (/\bdogs?\b/.test(normalized)) slots.pets = 'dog';
  else if (/\b(?:no pets?|pet[- ]?free)\b/.test(normalized)) slots.pets = 'none';

  const explicitChildren = normalized.match(/\b(one|two|three|four|five|\d)\s+(?:children|kids?)\b/);
  let occupants = explicitChildren ? conversationalNumber(explicitChildren[1]) ?? 0 : 0;
  const relations = ['husband', 'wife', 'partner', 'mother', 'father', 'parent', 'brother', 'sister', 'roommate'];
  occupants += relations.filter((relation) => new RegExp(`\\b${relation}\\b`).test(normalized)).length;
  if (occupants > 0 && /\b(?:i|my|myself|me)\b/.test(normalized)) occupants += 1;
  if (occupants > 0) slots.occupants = String(occupants);
  const explicitOccupants = normalized.match(/\b(one|two|three|four|five|six|\d{1,2})\s+(?:people|persons?|occupants?)\b/);
  if (explicitOccupants) {
    const count = conversationalNumber(explicitOccupants[1]);
    if (count !== undefined) slots.occupants = String(count);
  }

  const monthAliases: Record<string, string> = {
    jan: 'January', january: 'January', feb: 'February', february: 'February',
    mar: 'March', march: 'March', apr: 'April', april: 'April', may: 'May',
    jun: 'June', june: 'June', jul: 'July', july: 'July', aug: 'August', august: 'August',
    sep: 'September', sept: 'September', september: 'September', oct: 'October', october: 'October',
    nov: 'November', november: 'November', dec: 'December', december: 'December',
  };
  const mentionedMonth = Object.entries(monthAliases).find(([alias]) => new RegExp(`\\b${alias}\\b`).test(normalized));
  if (mentionedMonth) {
    const year = normalized.match(/\b20\d{2}\b/)?.[0];
    slots.move_in_date = `${mentionedMonth[1]}${year ? ` ${year}` : ''}`;
  }
  if (/\b(?:asap|as soon as possible|immediately|right away)\b/.test(normalized)) {
    slots.move_in_date = 'As soon as possible';
  }

  const cityCorrection = Object.entries(CANADIAN_CITY_ALIASES).find(([alias]) =>
    new RegExp(`\\b${alias.replace(/\s+/g, '\\s+')}\\b`, 'i').test(normalized)
    && (/\b(?:actually|instead|i meant|not)\b/.test(normalized) || !existingSlots.preferred_area)
  );
  if (cityCorrection) {
    slots.preferred_area = cityCorrection[1];
    slots.preferred_province = 'British Columbia';
    slots.location_confirmation = 'confirmed';
  }

  return slots;
}

export function buildConversationRepairTurn(
  message: string,
  slots: Record<string, string>,
): InterpretedTurn | undefined {
  const alreadyAnswered = /\b(?:i already told you|i said that|as i said|you already asked)\b/i.test(message);
  if (!alreadyAnswered && !/\b(?:don'?t understand|do not understand|what do you mean|why do you need|why are you asking|i(?:'m| am) confused|huh)\b/i.test(message)) {
    return undefined;
  }
  let reply: string;
  if (!slots.prospect_name) reply = "I’m only asking for your first name so I can make the conversation more personal. What is your first name?";
  else if (!slots.preferred_area) reply = "The area helps me avoid showing homes that are too far away. Which city or neighbourhood would work for you?";
  else if (!slots.bedrooms) reply = "I’m asking how many bedrooms you need so I can avoid showing homes that are too small.";
  else if (!slots.pets) reply = "I ask because pet policies vary by building, and I don’t want to recommend a home that won’t accept your pet. Will any pets be moving with you?";
  else if (!slots.budget) reply = "The budget keeps me from suggesting homes that would stretch your finances. What monthly maximum should I use?";
  else reply = "The move-in timing helps me check whether a home will actually be available when you need it. Do you have a target month?";
  if (alreadyAnswered) reply = `You're right — I won’t ask you to repeat it. ${reply}`;
  return { reply, slots: {}, next_state: 'collecting_movein' };
}

export function resolveReferencedOptions(
  message: string,
  optionCount: number,
  rents: number[] = [],
  labels: string[] = [],
): number[] {
  const normalized = message.toLowerCase();
  const all = Array.from({ length: optionCount }, (_, index) => index + 1);
  const excluded = normalized.match(/\bnot\s+(?:option\s*)?(\d+)\b/)?.[1];
  if (excluded) return all.filter((option) => option !== Number(excluded));
  if (/\bfirst\b/.test(normalized) && /\blast\b/.test(normalized)) return [1, optionCount];
  if (/\bcheaper\s+two\b/.test(normalized) && rents.length === optionCount) {
    return rents.map((rent, index) => ({ rent, option: index + 1 }))
      .sort((a, b) => a.rent - b.rent).slice(0, 2).map((item) => item.option).sort();
  }
  if (/\bboth\b/.test(normalized)) return optionCount === 2 ? all : [];
  if (/\ball(?:\s+of\s+them|\s+(?:the\s+)?options)?\b/.test(normalized)) return all;
  const explicit = [...normalized.matchAll(/\b(?:option\s*)?([1-9])\b/g)]
    .map((match) => Number(match[1])).filter((option) => option <= optionCount);
  if (explicit.length > 0) return [...new Set(explicit)];
  const byLabel = labels
    .map((label, index) => ({
      index: index + 1,
      words: label.toLowerCase().split(/\W+/).filter((word) => word.length >= 4),
    }))
    .filter((item) => item.words.some((word) => normalized.includes(word)))
    .map((item) => item.index);
  return [...new Set(byLabel)];
}

export function alignInterpretedSlotsWithExpectedField(
  turn: InterpretedTurn,
  userMessage: string,
  existingSlots: Record<string, string>,
): InterpretedTurn {
  if (existingSlots.transaction_intent !== 'rent') return turn;
  const normalizedMessage = userMessage.trim().toLowerCase();
  const slots = { ...(turn.slots ?? {}) };

  if (!existingSlots.prospect_name && slots.prospect_name) {
    const confusion = /\b(?:don'?t|do not|can'?t|cannot|didn'?t)\s+(?:get|understand|follow)\b|what do you mean|i(?:'m| am) confused|huh/i.test(userMessage);
    const plausibleName = /^[\p{L}][\p{L}' -]{1,49}$/u.test(slots.prospect_name)
      && slots.prospect_name.trim().split(/\s+/).length <= 3;
    if (confusion || !plausibleName) delete slots.prospect_name;
  }

  if (
    existingSlots.location_confirmation === 'pending'
    && /^(?:yes|yeah|yep|correct|right|that'?s right)$/i.test(normalizedMessage)
  ) {
    return { ...turn, intent: 'confirm', slots };
  }

  const numericAnswer = userMessage.trim().match(/^(\d{1,2})$/)?.[1];
  if (numericAnswer && existingSlots.preferred_area && !existingSlots.bedrooms) {
    if (slots.bedrooms !== `${numericAnswer}+`) slots.bedrooms = numericAnswer;
    delete slots.occupants;
  }
  const describedHouseholdMembers = normalizedMessage.match(
    /\b(?:husband|wife|partner|son|daughter|child|children|kid|mother|father|parent|brother|sister|roommate)\b/g,
  )?.length ?? 0;
  if (describedHouseholdMembers > 0 && slots.occupants) {
    slots.occupants = String(describedHouseholdMembers + (/\b(?:i|my|myself|me)\b/.test(normalizedMessage) ? 1 : 0));
  }

  if (
    existingSlots.prospect_name
    && !existingSlots.preferred_area
    && existingSlots.location_confirmation !== 'pending'
    && !slots.preferred_area
    && CANADIAN_CITY_ALIASES[normalizedMessage]
  ) {
    slots.preferred_area = CANADIAN_CITY_ALIASES[normalizedMessage];
  }

  if (
    existingSlots.bedrooms
    && !existingSlots.pets
  ) {
    if (/^(?:yes|yeah|yep|i do)$/i.test(normalizedMessage)) {
      delete slots.pets;
      slots.pet_presence = 'yes';
    } else if (/\bdogs?\b/i.test(normalizedMessage)) slots.pets = 'dog';
    else if (/\bcats?\b/i.test(normalizedMessage)) slots.pets = 'cat';
    else if (/^(?:no|none|no pets?|pet[- ]?free)$/i.test(normalizedMessage)) slots.pets = 'none';
  }

  if (
    existingSlots.pets
    && !existingSlots.budget
    && !slots.budget
  ) {
    const budget = userMessage.replace(/,/g, '').match(/\$?\s*(\d{3,5})/)?.[1];
    if (budget) slots.budget = budget;
  }

  if (
    existingSlots.budget
    && !existingSlots.move_in_date
    && !slots.move_in_date
  ) {
    const monthAliases: Record<string, string> = {
      jan: 'January', january: 'January',
      feb: 'February', february: 'February',
      mar: 'March', march: 'March',
      apr: 'April', april: 'April',
      may: 'May',
      jun: 'June', june: 'June',
      jul: 'July', july: 'July',
      aug: 'August', august: 'August',
      sep: 'September', sept: 'September', september: 'September',
      oct: 'October', october: 'October',
      nov: 'November', november: 'November',
      dec: 'December', december: 'December',
    };
    const month = monthAliases[normalizedMessage.replace(/[.!?]/g, '')];
    if (month) slots.move_in_date = month;
  }

  return { ...turn, slots };
}

export function validateInterpretedLocation(
  turn: InterpretedTurn,
  existingSlots: Record<string, string>,
): InterpretedTurn {
  if (
    turn.intent === 'confirm'
    && existingSlots.location_confirmation === 'pending'
    && existingSlots.pending_area
    && existingSlots.pending_province
  ) {
    return {
      ...turn,
      reply: `Perfect — ${existingSlots.pending_area}, ${existingSlots.pending_province}. How many bedrooms do you need?`,
      slots: {
        ...(turn.slots ?? {}),
        preferred_area: existingSlots.pending_area,
        preferred_province: existingSlots.pending_province,
        location_confirmation: 'confirmed',
        location_confirmed: 'yes',
      },
      next_state: 'collecting_movein',
    };
  }

  const extractedArea = turn.slots?.preferred_area;
  if (!extractedArea || existingSlots.preferred_area || existingSlots.location_confirmation === 'pending') return turn;
  const locationText = turn.slots?.preferred_province
    ? `${extractedArea}, ${turn.slots.preferred_province}`
    : extractedArea;
  const location = parseCanadianLocation(locationText);
  if (!location) return turn;
  const { preferred_area: _area, preferred_province: _province, ...otherSlots } = turn.slots ?? {};
  return {
    ...turn,
    reply: `Just to confirm, do you mean ${location.area}, ${location.province}?`,
    slots: {
      ...otherSlots,
      pending_area: location.area,
      pending_province: location.province,
      location_confirmation: 'pending',
    },
    next_state: 'collecting_budget',
  };
}

const conversationTaskTails = new Map<string, Promise<void>>();

export async function serializeConversationTask<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = conversationTaskTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  conversationTaskTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (conversationTaskTails.get(key) === tail) conversationTaskTails.delete(key);
  }
}

export async function handleInboundMessage(
  input: InboundChatMessage,
  deps: { glm: GlmAdapter; messaging: MessagingAdapter; showmojo: ShowMojoAdapter },
): Promise<BotReply> {
  const key = `${input.tenantId}:${getConversationExternalId(input)}`;
  return serializeConversationTask(key, () => handleInboundMessageUnlocked(input, deps));
}

async function handleInboundMessageUnlocked(
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
      messages: { orderBy: { createdAt: 'desc' }, take: 20 },
      slots: true,
    },
  });

  await prisma.propertyShortlist.updateMany({
    where: { conversationId: conversation.id, remindersStopped: false },
    data: { remindersStopped: true, nextReminderAt: null },
  });

  await prisma.chatMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'user',
      content: input.body,
      mediaUrls: input.mediaUrls ?? [],
    },
  });

  // /start (Telegram) significa "empezar de cero": resetear estado y slots
  // para que el bot vuelva a saludar y calificar desde el principio, sin
  // heredar datos de una conversación anterior del mismo chat.
  const isStartCommand = /^\/(start|begin|reset)(\b|$)/i.test(input.body.trim());
  let conversationState = conversation.state as ConversationState;
  let conversationSlots = conversation.slots;
  if (isStartCommand) {
    await prisma.conversationSlot.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.chatConversation.update({
      where: { id: conversation.id },
      data: { state: 'greeting', unitId: null },
    });
    conversationState = 'greeting';
    conversationSlots = [];
  }

  const existingSlots: Record<string, string> = {};
  for (const slot of conversationSlots) {
    existingSlots[slot.key] = slot.value;
  }
  const availableUnits = await getAvailableUnits(input.tenantId, existingSlots);
  const currentState = conversationState;
  const focusedUnit = availableUnits.find((unit) => unit.id === conversation.unitId);
  const contextualSlots = extractContextualConversationSlots(input.body, existingSlots);
  const searchCriteriaOverride = shouldPrioritizeSearchCriteria(existingSlots, contextualSlots);

  const tenantName = await getTenantName(input.tenantId);
  const latestShortlist = canResolveActiveShortlist(currentState)
    ? await prisma.propertyShortlist.findFirst({ where: { conversationId: conversation.id, status: 'awaiting_preference' }, orderBy: { createdAt: 'desc' } })
    : null;
  const focusedAnswer = buildFocusedPropertyAnswer(input.body, focusedUnit);
  const optionDecline = latestShortlist ? buildOptionDeclineTurn(input.body, existingSlots) : undefined;
  const resumeQuestion = focusedAnswer ? buildQualificationGuardReply(existingSlots) : undefined;
  const focusedTurn: InterpretedTurn | undefined = focusedAnswer
    ? {
        reply: `${focusedAnswer.answer}${resumeQuestion ? `\n\n${resumeQuestion}` : ''}`,
        slots: {},
        next_state: currentState,
      }
    : undefined;
  const repairTurn = buildConversationRepairTurn(input.body, existingSlots);
  const qualificationTurn = buildDeterministicQualificationTurn(input.body, existingSlots, tenantName);
  const deterministicResult = existingSlots.tour_scheduled_at
    ? buildPostTourContextTurn(input.body, existingSlots)
    : qualificationTurn
      ?? focusedTurn
      ?? optionDecline
      ?? repairTurn
      ?? undefined;
  let glmResult: InterpretedTurn = deterministicResult ?? await callGlm(deps.glm, {
    currentState,
    tenantId: input.tenantId,
    userMessage: input.body,
    history: prepareConversationHistory(conversation.messages, isStartCommand),
    existingSlots,
    availableUnits,
  });

  if (searchCriteriaOverride && glmResult.intent === 'select_options') {
    glmResult = {
      ...glmResult,
      intent: 'request_matches',
      selected_options: undefined,
      selection_scope: undefined,
      next_state: 'proposing_tour',
    };
  }

  const implicitlySelectedUnitId = latestShortlist && !searchCriteriaOverride
    ? resolveSingleOptionAffirmation(input.body, latestShortlist.unitIds)
    : undefined;
  if (implicitlySelectedUnitId) {
    await prisma.propertyShortlist.update({
      where: { id: latestShortlist!.id },
      data: { selectedUnitId: implicitlySelectedUnitId, status: 'selected' },
    });
    glmResult = {
      reply: "Perfect — let's find a tour time that works for you.",
      slots: { selected_unit_id: implicitlySelectedUnitId },
      intent: 'schedule_tour',
      next_state: 'scheduling',
    };
  }

  if (latestShortlist && !searchCriteriaOverride) {
    const shortlistRents = latestShortlist.unitIds.map((id) =>
      availableUnits.find((unit) => unit.id === id)?.rentCents ?? Number.MAX_SAFE_INTEGER
    );
    const shortlistLabels = latestShortlist.unitIds.map((id) => {
      const unit = availableUnits.find((candidate) => candidate.id === id);
      return unit ? `${unit.propertyName} ${unit.name} ${unit.city}` : '';
    });
    const referencedOptions = resolveReferencedOptions(
      input.body,
      latestShortlist.unitIds.length,
      shortlistRents,
      shortlistLabels,
    );
    if (referencedOptions.length > 0) {
      glmResult = {
        ...glmResult,
        intent: 'select_options',
        selected_options: referencedOptions,
        selection_scope: referencedOptions.length === latestShortlist.unitIds.length
          ? 'all'
          : referencedOptions.length > 1 ? 'multiple' : 'single',
      };
    }
  }

  if (latestShortlist && glmResult.intent === 'select_options') {
    const requestedIndexes = (glmResult.selected_options ?? [])
      .map((option) => option - 1)
      .filter((index) => index >= 0 && index < latestShortlist.unitIds.length);
    const wantsEveryOption = glmResult.selection_scope === 'all'
      || (requestedIndexes.length > 1 && requestedIndexes.length === latestShortlist.unitIds.length);
    if (wantsEveryOption || requestedIndexes.length > 1) {
      const token = await rotateShortlistToken(latestShortlist.id);
      await prisma.propertyShortlist.update({
        where: { id: latestShortlist.id },
        data: { remindersStopped: false, reminderCount: 0, nextReminderAt: new Date(Date.now() + 2 * 60 * 60 * 1000) },
      });
      glmResult = {
        reply: `Absolutely — I'll keep those options on your list. You can compare their photos, details, and tour times here:\n\n${buildShortlistMarkdownLink(token)}`,
        slots: { shortlist_scope: wantsEveryOption ? 'all' : requestedIndexes.map((index) => index + 1).join(',') },
        next_state: 'proposing_units',
      };
    } else if (requestedIndexes.length === 1) {
      const selectedUnitId = latestShortlist.unitIds[requestedIndexes[0]];
      const token = await rotateShortlistToken(latestShortlist.id);
      await prisma.propertyShortlist.update({
        where: { id: latestShortlist.id },
        data: { selectedUnitId, status: 'selected', remindersStopped: false, reminderCount: 0, nextReminderAt: new Date(Date.now() + 2 * 60 * 60 * 1000) },
      });
      await prisma.chatConversation.update({ where: { id: conversation.id }, data: { unitId: selectedUnitId } });
      glmResult = {
        reply: `Nice choice. I've put all of your matches together here so you can compare the photos and choose a tour time:\n\n${buildShortlistMarkdownLink(token)}`,
        slots: { selected_unit_id: selectedUnitId },
        next_state: 'proposing_units',
      };
    }
  }

  if (glmResult.intent === 'request_matches' || glmResult.intent === 'request_more_options') {
    glmResult.next_state = 'proposing_tour';
  } else if (glmResult.intent === 'schedule_tour') {
    glmResult.next_state = 'scheduling';
  } else if (glmResult.intent === 'handoff') {
    glmResult.next_state = 'handoff';
  }
  if (glmResult.intent === 'rent' || glmResult.intent === 'buy' || glmResult.intent === 'sell') {
    glmResult.slots = { ...(glmResult.slots ?? {}), transaction_intent: glmResult.intent };
  }
  glmResult = sanitizeInterpretedTurn(glmResult);
  if (glmResult.clearSlots?.length) {
    await prisma.conversationSlot.deleteMany({
      where: { conversationId: conversation.id, key: { in: glmResult.clearSlots } },
    });
    for (const key of glmResult.clearSlots) delete existingSlots[key];
  }
  if (
    contextualSlots.preferred_area
    && existingSlots.preferred_area
    && contextualSlots.preferred_area.toLowerCase() !== existingSlots.preferred_area.toLowerCase()
  ) {
    const correctedArea = contextualSlots.preferred_area;
    const correctedProvince = contextualSlots.preferred_province ?? 'British Columbia';
    await prisma.conversationSlot.deleteMany({
      where: {
        conversationId: conversation.id,
        key: { in: ['preferred_area', 'preferred_province', 'location_confirmed'] },
      },
    });
    delete existingSlots.preferred_area;
    delete existingSlots.preferred_province;
    delete existingSlots.location_confirmed;
    delete contextualSlots.preferred_area;
    delete contextualSlots.preferred_province;
    contextualSlots.pending_area = correctedArea;
    contextualSlots.pending_province = correctedProvince;
    contextualSlots.location_confirmation = 'pending';
    if (glmResult.slots) {
      delete glmResult.slots.preferred_area;
      delete glmResult.slots.preferred_province;
    }
    glmResult.reply = `Thanks for correcting that. Just to confirm, do you mean ${correctedArea}, ${correctedProvince}?`;
    glmResult.intent = 'correct_information';
  }
  glmResult.slots = { ...contextualSlots, ...(glmResult.slots ?? {}) };
  glmResult = alignInterpretedSlotsWithExpectedField(glmResult, input.body, existingSlots);
  glmResult = validateInterpretedLocation(glmResult, existingSlots);

  const staleRecommendationSlots = recommendationStateSlotsToClear(existingSlots, glmResult.slots ?? {});
  if (staleRecommendationSlots.length > 0) {
    await prisma.conversationSlot.deleteMany({
      where: { conversationId: conversation.id, key: { in: staleRecommendationSlots } },
    });
    await prisma.chatConversation.update({ where: { id: conversation.id }, data: { unitId: null } });
    for (const key of staleRecommendationSlots) delete existingSlots[key];
  }

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
  const candidateInventory = glmResult.intent === 'request_more_options' && latestShortlist
    ? excludePreviouslyShownUnits(availableUnits, latestShortlist.unitIds)
    : availableUnits;
  const matchingUnits = rankMatchingUnits(
    filterQualifiedUnits(candidateInventory, effectiveSlots),
    effectiveSlots,
  );
  let presentedUnits = matchingUnits;
  let recommendedUnit = presentedUnits[0];
  let matchReason = recommendedUnit ? buildUnitMatchReason(recommendedUnit, effectiveSlots) : undefined;

  let newState = glmResult.next_state ?? currentState;
  let finalReply = glmResult.reply;

  const isRentalQualification =
    effectiveSlots.transaction_intent === 'rent'
    && !isStartCommand
    && newState !== 'handoff'
    && newState !== 'scheduling';
  if (isRentalQualification) {
    const qualificationQuestion = buildQualificationGuardReply(effectiveSlots, glmResult.slots);
    if (qualificationQuestion && glmResult.intent !== 'ask_clarification') {
      finalReply = qualificationQuestion;
      newState = 'collecting_movein';
    } else if (shouldTransitionToMatches(currentState, effectiveSlots)) {
      newState = 'proposing_tour';
    }
  }

  const shouldGenerateRecommendations = newState === 'proposing_tour'
    && (
      currentState !== 'proposing_tour'
      || glmResult.intent === 'request_matches'
      || glmResult.intent === 'request_more_options'
    );

  if (shouldGenerateRecommendations && matchingUnits.length === 0) {
    const alternative = buildClosestAlternativeRecommendation(candidateInventory, effectiveSlots);
    if (alternative) {
      presentedUnits = alternative.units;
      recommendedUnit = presentedUnits[0];
      matchReason = recommendedUnit ? buildUnitMatchReason(recommendedUnit, effectiveSlots) : undefined;
      finalReply = alternative.reply;
      effectiveSlots.recommendation_kind = 'alternative';
      await prisma.conversationSlot.upsert({
        where: { conversationId_key: { conversationId: conversation.id, key: 'recommendation_kind' } },
        update: { value: 'alternative' },
        create: { conversationId: conversation.id, key: 'recommendation_kind', value: 'alternative' },
      });
    } else {
      const recovery = buildInventoryRecoveryTurn(candidateInventory, effectiveSlots);
      finalReply = recovery.reply;
      const recoverySlots = recovery.slots ?? {};
      Object.assign(effectiveSlots, recoverySlots);
      for (const [key, value] of Object.entries(recoverySlots)) {
        await prisma.conversationSlot.upsert({
          where: { conversationId_key: { conversationId: conversation.id, key } },
          update: { value },
          create: { conversationId: conversation.id, key, value },
        });
      }
      newState = 'collecting_movein';
    }
  }

  if (shouldGenerateRecommendations && presentedUnits.length > 0) {
    await createShortlist({
      tenantId: input.tenantId,
      conversationId: conversation.id,
      unitIds: presentedUnits.slice(0, 3).map((unit) => unit.id),
    });
    if (matchingUnits.length > 0) {
      finalReply = buildUnitRecommendationReply(presentedUnits, effectiveSlots);
      effectiveSlots.recommendation_kind = 'exact';
      await prisma.conversationSlot.upsert({
        where: { conversationId_key: { conversationId: conversation.id, key: 'recommendation_kind' } },
        update: { value: 'exact' },
        create: { conversationId: conversation.id, key: 'recommendation_kind', value: 'exact' },
      });
    }
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

  if (
    newState === 'scheduling'
    && currentState !== 'scheduling'
    && !effectiveSlots.selected_unit_id
  ) {
    finalReply = 'Before we choose a tour time, which property would you like to visit?';
    newState = 'proposing_tour';
  } else if (newState === 'scheduling' && currentState !== 'scheduling') {
    const unitId = effectiveSlots.selected_unit_id
      ?? conversation.unitId
      ?? recommendedUnit?.id
      ?? (await inferUnitFromSlots(input.tenantId, effectiveSlots));
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
          where: {
            tenantId: input.tenantId,
            ...(conversation.leadId ? { id: conversation.leadId } : { phone: input.from }),
          },
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
            const scheduledUnit = availableUnits.find((unit) => unit.id === schedulingUnitId);
            const scheduledAddress = scheduledUnit?.address
              ? `${scheduledUnit.address}, ${scheduledUnit.city}${scheduledUnit.province ? `, ${scheduledUnit.province}` : ''}`
              : undefined;
            const scheduledLabel = scheduledUnit ? `${scheduledUnit.propertyName} — ${scheduledUnit.name}` : undefined;
            const completedTourSlots: Record<string, string> = {
              tour_scheduled_at: result.scheduledAt,
              ...(scheduledAddress ? { scheduled_unit_address: scheduledAddress } : {}),
              ...(scheduledLabel ? { scheduled_unit_label: scheduledLabel } : {}),
            };
            for (const [key, value] of Object.entries(completedTourSlots)) {
              await prisma.conversationSlot.upsert({
                where: { conversationId_key: { conversationId: conversation.id, key } },
                update: { value },
                create: { conversationId: conversation.id, key, value },
              });
            }
            finalReply =
              `Your tour request has been submitted${scheduledLabel ? ` for ${scheduledLabel}` : ''}.\n\n` +
              `${scheduledAddress ? `Address:\n${formatStoredAddress(scheduledAddress)}\n\n` : ''}` +
              `${new Date(result.scheduledAt).toLocaleDateString('en-CA', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })} at ${new Date(result.scheduledAt).toLocaleTimeString('en-CA', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              })}\n\n` +
              `The broker will confirm availability shortly. I’ll keep the confirmation and any updates right here in this conversation.`;
            newState = 'handoff';
          } catch {
            finalReply = 'There was a problem scheduling the tour. Would you like to try another time?';
            newState = 'scheduling';
          }
        }
      }
    }
  }

  const presentedUnit = shouldGenerateRecommendations && shouldPersistPresentedUnit(newState, presentedUnits.length)
    ? recommendedUnit
    : undefined;
  await prisma.chatConversation.update({
    where: { id: conversation.id },
    data: { state: newState, ...(presentedUnit ? { unitId: presentedUnit.id } : {}) },
  });

  const assistantMessage = await prisma.chatMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'assistant',
      content: finalReply,
      deliveryStatus: 'pending',
    },
  });

  const leadCreated = await ensureLead(input.tenantId, conversation.id, input.from, input.body, input.channel, presentedUnit?.id);
  if (effectiveSlots.prospect_name) {
    await prisma.lead.updateMany({
      where: { tenantId: input.tenantId, conversations: { some: { id: conversation.id } } },
      data: { name: effectiveSlots.prospect_name },
    });
  }

  const recommendationPlan = shouldDeliverRecommendationPlan({
    shouldGenerateRecommendations,
    newState,
    presentedUnits,
  })
    ? buildRecommendationDeliveryPlan(presentedUnits, {
      ...effectiveSlots,
      recommendation_kind: effectiveSlots.recommendation_kind ?? (matchingUnits.length > 0 ? 'exact' : 'alternative'),
    })
    : undefined;

  if (false && shouldGenerateRecommendations && typeof deps.messaging.sendPhoto === 'function') {
    for (const [index, unit] of presentedUnits.slice(0, 3).entries()) {
      if (!unit.photoUrl) continue;
      const caption = `*Option ${index + 1}: ${unit.propertyName} — ${unit.name}*`;
      try {
        await deps.messaging.sendPhoto!(input.from, unit.photoUrl!, caption);
      } catch {
        // A broken/missing photo must not prevent the listing text from arriving.
      }
    }
  }

  // El reply se envía como una secuencia de mensajes cortos con pausas y
  // typing indicator para que la conversación se sienta humana. El mensaje
  // completo ya quedó persistido arriba para auditoría/dasboard.
  const deliveredMessageIds: string[] = [];
  try {
    if (recommendationPlan) {
      if (recommendationPlan.intro) {
        deliveredMessageIds.push(...await sendHumanLike(input.from, recommendationPlan.intro, input.channel, deps.messaging));
      }
      for (const option of recommendationPlan.options) {
        deliveredMessageIds.push(...await sendHumanLike(input.from, option.text, input.channel, deps.messaging));
        await sendPhotoIfAvailable(deps.messaging, input.from, option.photoUrl);
      }
      if (recommendationPlan.outro) {
        deliveredMessageIds.push(...await sendHumanLike(input.from, recommendationPlan.outro, input.channel, deps.messaging));
      }
    } else {
      deliveredMessageIds.push(...await sendHumanLike(input.from, finalReply, input.channel, deps.messaging));
    }
    await prisma.chatMessage.update({
      where: { id: assistantMessage.id },
      data: {
        deliveryStatus: 'sent',
        deliveryError: null,
        deliveryNextAttemptAt: null,
        deliveryAttempts: 1,
        providerMessageIds: deliveredMessageIds,
      },
    });
  } catch (error) {
    await prisma.chatMessage.update({
      where: { id: assistantMessage.id },
      data: {
        deliveryStatus: 'failed',
        deliveryError: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown delivery error',
        deliveryAttempts: 1,
        deliveryNextAttemptAt: nextDeliveryRetryAt(1),
        providerMessageIds: deliveredMessageIds,
      },
    });
    throw error;
  }
  if (
    focusedAnswer?.action === 'photos'
    && focusedUnit?.photoUrls?.length
    && typeof deps.messaging.sendPhoto === 'function'
  ) {
    for (const [index, photoUrl] of focusedUnit.photoUrls.entries()) {
      try {
        await deps.messaging.sendPhoto(
          input.from,
          photoUrl,
          index === 0 ? `*${focusedUnit.propertyName} — ${focusedUnit.name}*` : undefined,
        );
      } catch {
        // Keep the conversation alive if one gallery image is unavailable.
      }
    }
  }

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
      ? presentedUnits.slice(0, 3).map((unit) => ({
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
): Promise<InterpretedTurn> {
  const knowledgeContext = await getTenantKnowledgeContext(ctx.tenantId, ctx.userMessage);
  const tenantName = await getTenantName(ctx.tenantId);
  const systemPrompt = buildSystemPrompt(
    ctx.currentState,
    ctx.availableUnits,
    ctx.existingSlots,
    knowledgeContext,
    tenantName,
  );
  const historyText = ctx.history
    .slice(-10)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');

  const slotsText = Object.keys(ctx.existingSlots).length > 0
    ? '\nKnown user information:\n' + Object.entries(ctx.existingSlots).map(([key, value]) => `  ${key}: ${value}`).join('\n')
    : '';

  try {
    const res = await glm.reason({
      systemPrompt,
      userPrompt: `Agency: ${tenantName}\nHistory:\n${historyText}${slotsText}\n\nCurrent user message: ${ctx.userMessage}`,
      responseSchema: {
        type: 'object',
        properties: {
          reply: { type: 'string', description: 'Bot reply to the user (max 2-3 sentences)' },
          intent: {
            type: 'string',
            enum: ['start', 'rent', 'buy', 'sell', 'provide_information', 'confirm', 'correct_information', 'ask_clarification', 'request_matches', 'request_more_options', 'select_options', 'schedule_tour', 'handoff', 'other'],
          },
          selected_options: {
            type: 'array',
            items: { type: 'integer' },
            description: 'One-based option numbers referenced by the user. Empty unless selecting displayed options.',
          },
          selection_scope: {
            type: 'string',
            enum: ['single', 'multiple', 'all'],
          },
          slots: {
            type: 'object',
            description: 'Information extracted from the message (budget, move_in_date, occupants, pets, etc.)',
            properties: {
              prospect_name: { type: 'string' },
              transaction_intent: { type: 'string', enum: ['rent', 'buy', 'sell'] },
              budget: { type: 'string' },
              move_in_date: { type: 'string' },
              occupants: { type: 'string' },
              pets: { type: 'string' },
              preferred_area: { type: 'string' },
              preferred_province: { type: 'string' },
              bedrooms: { type: 'string', description: 'Number of bedrooms (0 for studio)' },
            },
          },
          next_state: {
            type: 'string',
            enum: ['greeting', 'collecting_budget', 'collecting_movein', 'proposing_units', 'proposing_tour', 'scheduling', 'handoff'],
          },
        },
        required: ['reply', 'intent', 'next_state'],
      },
      temperature: 0.7,
    });

    const parsed = parseGlmJsonResponse(res.content);
    return {
      reply: parsed.reply ?? 'What else can I help with?',
      intent: parsed.intent,
      slots: parsed.slots,
      selected_options: parsed.selected_options,
      selection_scope: parsed.selection_scope,
      next_state: parsed.next_state,
    };
  } catch {
    return buildGlmFallback(ctx.currentState, tenantName, ctx.userMessage, ctx.existingSlots);
  }
}

export function parseGlmJsonResponse(content: string): {
  reply: string;
  intent?: ConversationIntent;
  slots?: Record<string, string>;
  selected_options?: number[];
  selection_scope?: 'single' | 'multiple' | 'all';
  next_state?: ConversationState;
} {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  return JSON.parse(normalized) as {
    reply: string;
    intent?: ConversationIntent;
    slots?: Record<string, string>;
    selected_options?: number[];
    selection_scope?: 'single' | 'multiple' | 'all';
    next_state?: ConversationState;
  };
}

export function buildQualificationGuardReply(
  slots: Record<string, string>,
  recentSlots: Record<string, string> = {},
): string | undefined {
  if (!slots.prospect_name) {
    return buildRentalNamePrompt();
  }
  if (slots.location_confirmation === 'pending') return undefined;
  if (!slots.preferred_area) {
    if (recentSlots.prospect_name) {
      return buildRentalWelcomeByName(slots.prospect_name);
    }
    return buildRentalAreaQuestion(slots.move_in_date);
  }
  if (!slots.bedrooms) {
    return buildRentalBedroomsQuestion();
  }
  const normalizedPets = slots.pets?.trim().toLowerCase();
  if (!normalizedPets || !['none', 'cat', 'dog', 'other'].includes(normalizedPets)) {
    if (slots.pet_presence === 'yes') {
      return buildRentalPetFollowup();
    }
    return 'Do you have any pets I should account for when checking building policies?';
  }
  if (!slots.budget) {
    return buildRentalBudgetQuestion(normalizedPets);
  }
  if (!slots.move_in_date) {
    return buildRentalMoveInQuestion(slots.budget);
  }
  return undefined;
}

export function shouldTransitionToMatches(
  currentState: ConversationState,
  slots: Record<string, string>,
): boolean {
  const isQualifyingState = currentState === 'greeting'
    || currentState === 'collecting_budget'
    || currentState === 'collecting_movein';
  if (!isQualifyingState || slots.transaction_intent !== 'rent') return false;
  if (slots.pending_search_adjustment && slots.pending_search_adjustment !== 'resolved') return false;
  return buildQualificationGuardReply(slots) === undefined
    && slots.location_confirmation === 'confirmed';
}

export function shouldPersistPresentedUnit(state: ConversationState, presentedUnitCount: number): boolean {
  return state === 'proposing_tour' && presentedUnitCount > 0;
}

export function buildGlmFallback(
  state: ConversationState,
  tenantName: string,
  userMessage = '',
  existingSlots: Record<string, string> = {},
): { reply: string; slots?: Record<string, string>; next_state: ConversationState } {
  const continuation = buildFastQualificationTurn(userMessage, existingSlots, tenantName);
  if (continuation) return continuation;

  if (state === 'greeting') {
    const isConversationOpening =
      /^\/(start|begin|reset)(\b|$)/i.test(userMessage.trim()) ||
      /^(hi|hello|hey|hola|good (morning|afternoon|evening))[!. ]*$/i.test(userMessage.trim());

    if (!isConversationOpening) {
      return {
        reply: 'Absolutely, I can help with that. Do you have an area in mind, or are you open to a few neighborhoods?',
        next_state: 'collecting_budget',
      };
    }

    return {
      reply: buildRentalOpeningReply(tenantName),
      next_state: 'greeting',
    };
  }

  return {
    reply: "I'm still with you. Let me continue from the information you've already shared.",
    next_state: state,
  };
}

type FastQualificationTurn = {
  reply: string;
  slots: Record<string, string>;
  next_state: ConversationState;
  intent?: ConversationIntent;
};

const CANADIAN_PROVINCES: Record<string, string> = {
  bc: 'British Columbia',
  'british columbia': 'British Columbia',
  ab: 'Alberta',
  alberta: 'Alberta',
  sk: 'Saskatchewan',
  saskatchewan: 'Saskatchewan',
  mb: 'Manitoba',
  manitoba: 'Manitoba',
  on: 'Ontario',
  ontario: 'Ontario',
  qc: 'Quebec',
  quebec: 'Quebec',
  nb: 'New Brunswick',
  'new brunswick': 'New Brunswick',
  ns: 'Nova Scotia',
  'nova scotia': 'Nova Scotia',
  pe: 'Prince Edward Island',
  pei: 'Prince Edward Island',
  'prince edward island': 'Prince Edward Island',
  nl: 'Newfoundland and Labrador',
  'newfoundland and labrador': 'Newfoundland and Labrador',
  yt: 'Yukon',
  yukon: 'Yukon',
  nt: 'Northwest Territories',
  'northwest territories': 'Northwest Territories',
  nu: 'Nunavut',
  nunavut: 'Nunavut',
};
const METRO_VANCOUVER_CITIES = new Set([
  'vancouver', 'burnaby', 'surrey', 'richmond', 'north vancouver', 'west vancouver',
  'new westminster', 'coquitlam', 'port coquitlam', 'port moody', 'delta', 'langley',
]);
const CITY_COORDINATES: Record<string, [number, number]> = {
  vancouver: [49.2827, -123.1207],
  burnaby: [49.2488, -122.9805],
  surrey: [49.1913, -122.8490],
  richmond: [49.1666, -123.1336],
  'north vancouver': [49.3200, -123.0724],
  'west vancouver': [49.3270, -123.1593],
  'new westminster': [49.2057, -122.9110],
  coquitlam: [49.2838, -122.7932],
  'port coquitlam': [49.2625, -122.7811],
  'port moody': [49.2849, -122.8678],
  delta: [49.0847, -123.0586],
  langley: [49.1044, -122.6604],
};
const CANADIAN_CITY_ALIASES: Record<string, string> = {
  poco: 'Port Coquitlam',
  'port coquitlam': 'Port Coquitlam',
  'new west': 'New Westminster',
  'new westminster': 'New Westminster',
  'north van': 'North Vancouver',
  'north vancouver': 'North Vancouver',
  'west van': 'West Vancouver',
  'west vancouver': 'West Vancouver',
  vancouver: 'Vancouver',
  burnaby: 'Burnaby',
  surrey: 'Surrey',
  richmond: 'Richmond',
};

export function wantsAllShortlistOptions(message: string): boolean {
  return /\b(?:both|all(?:\s+of\s+them)?|all\s+(?:the\s+)?options)\b/i.test(message.trim());
}

function normalizeCanadianCity(value: string): string {
  const cleaned = value.trim();
  return CANADIAN_CITY_ALIASES[cleaned.toLowerCase()] ?? toHumanTitleCase(cleaned);
}

function toHumanTitleCase(value: string): string {
  return value.trim().split(/\s+/).map((part) =>
    part.split(/([-'])/).map((piece) =>
      /^[-']$/.test(piece) ? piece : piece.charAt(0).toLocaleUpperCase() + piece.slice(1).toLocaleLowerCase()
    ).join('')
  ).join(' ');
}

function cityDistanceKm(from: string | undefined, to: string): number {
  if (!from) return 999;
  const origin = CITY_COORDINATES[normalizeCanadianCity(from).toLowerCase()];
  const destination = CITY_COORDINATES[normalizeCanadianCity(to).toLowerCase()];
  if (!origin || !destination) return 999;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(destination[0] - origin[0]);
  const dLon = radians(destination[1] - origin[1]);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(origin[0])) * Math.cos(radians(destination[0])) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseCanadianLocation(message: string): { area: string; province: string } | undefined {
  const cleaned = message.trim().replace(/[.!?]+$/, '').trim();
  if (!cleaned || /^\d+$/.test(cleaned)) return undefined;

  const commaParts = cleaned.split(',').map((part) => part.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    const provinceText = commaParts.slice(1).join(' ').toLowerCase();
    return {
      area: normalizeCanadianCity(commaParts[0]),
      province: CANADIAN_PROVINCES[provinceText] ?? commaParts.slice(1).join(', '),
    };
  }

  const provinceSuffix = Object.keys(CANADIAN_PROVINCES)
    .sort((a, b) => b.length - a.length)
    .find((province) => cleaned.toLowerCase().endsWith(` ${province}`));
  if (provinceSuffix) {
    return {
      area: normalizeCanadianCity(cleaned.slice(0, -(provinceSuffix.length + 1))),
      province: CANADIAN_PROVINCES[provinceSuffix],
    };
  }

  return { area: normalizeCanadianCity(cleaned), province: 'British Columbia' };
}

function normalizeProvince(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/\.$/, '');
  return (CANADIAN_PROVINCES[normalized] ?? normalized).toLowerCase();
}

function canonicalizeMoveInTiming(message: string): string {
  const normalized = message.trim().toLowerCase().replace(/[.!?]/g, '');
  if (/\b(?:asap|as soon as possible|immediately|right away)\b/.test(normalized)) {
    return 'As soon as possible';
  }

  const monthAliases: Record<string, string> = {
    jan: 'January', january: 'January',
    feb: 'February', february: 'February',
    mar: 'March', march: 'March',
    apr: 'April', april: 'April',
    may: 'May',
    jun: 'June', june: 'June',
    jul: 'July', july: 'July',
    aug: 'August', august: 'August',
    sep: 'September', sept: 'September', september: 'September',
    oct: 'October', october: 'October',
    nov: 'November', november: 'November',
    dec: 'December', december: 'December',
  };
  const directMonth = monthAliases[normalized];
  if (directMonth) {
    const year = message.match(/\b20\d{2}\b/)?.[0];
    return `${directMonth}${year ? ` ${year}` : ''}`;
  }

  const detectedMonth = Object.entries(monthAliases)
    .find(([alias]) => new RegExp(`\\b${alias}\\b`).test(normalized))?.[1];
  if (!detectedMonth) return message.trim();

  const year = message.match(/\b20\d{2}\b/)?.[0];
  return `${detectedMonth}${year ? ` ${year}` : ''}`;
}

export function buildFastQualificationTurn(
  userMessage: string,
  existingSlots: Record<string, string>,
  tenantName = 'Pacific Ridge Property Management',
): FastQualificationTurn | undefined {
  const message = userMessage.trim();
  const normalized = message.toLowerCase().replace(/[.!?]/g, '').trim();
  const openingReply = buildRentalOpeningReply(tenantName);

  if (/^\/(start|begin|reset)(\b|$)/i.test(message)) {
    return { reply: openingReply, slots: {}, next_state: 'greeting' };
  }

  if (!existingSlots.transaction_intent) {
    const intent =
      /^(a|1|rent|rental|renting|lease)$/.test(normalized) ? 'rent'
        : /^(b|2|buy|buying|purchase)$/.test(normalized) ? 'buy'
          : /^(c|3|sell|selling)$/.test(normalized) ? 'sell'
            : undefined;

    if (!intent) return { reply: openingReply, slots: {}, next_state: 'greeting' };
    if (intent === 'buy' || intent === 'sell') {
      return buildOwnershipConversationTurn(message, existingSlots);
    }
    return {
      reply: buildRentalIntentReply(),
      slots: { transaction_intent: 'rent' },
      next_state: 'collecting_budget',
    };
  }

  if (existingSlots.transaction_intent !== 'rent') return undefined;

  const hasQualificationData = ['preferred_area', 'bedrooms', 'pets', 'budget', 'move_in_date']
    .some((key) => Boolean(existingSlots[key]));
  if (!existingSlots.prospect_name && !hasQualificationData) {
    if (
      /\b(?:don'?t|do not|can'?t|cannot|didn'?t)\s+(?:get|understand|follow)\b/i.test(message)
      || /\b(?:what do you mean|can you explain|i(?:'m| am) confused|huh)\b/i.test(message)
    ) {
      return {
        reply: buildRentalNameClarification(),
        slots: {},
        intent: 'ask_clarification',
        next_state: 'collecting_budget',
      };
    }
    const explicitlyIntroduced = /^(?:i am|i'm|my name is|call me)\s+/i.test(message);
    const candidate = message
      .replace(/^(?:i am|i'm|my name is|call me)\s+/i, '')
      .trim();
    if (!/^[\p{L}][\p{L}' -]{1,49}$/u.test(candidate)) return undefined;
    const candidateWords = candidate.toLowerCase().split(/\s+/);
    const conversationalWords = new Set([
      'i', "i'm", 'you', 'that', 'this', 'what', 'why', 'how', 'please', 'thanks',
      'okay', 'ok', 'yes', 'no', 'maybe', 'understand', 'get', 'confused', 'help',
    ]);
    if (
      (!explicitlyIntroduced && candidateWords.length > 3)
      || candidateWords.some((word) => conversationalWords.has(word))
    ) return undefined;
    const name = candidate
      ? toHumanTitleCase(candidate)
      : candidate;
    return {
      reply: buildRentalWelcomeByName(name),
      slots: { prospect_name: name },
      next_state: 'collecting_budget',
    };
  }

  if (!existingSlots.preferred_area && existingSlots.location_confirmation === 'pending') {
    if (/^(a|1|yes|y|yeah|yep|correct|that's right|that is right)$/.test(normalized)) {
      const area = existingSlots.pending_area;
      const province = existingSlots.pending_province;
      if (!area || !province) return undefined;
      return {
        reply: buildRentalAreaAccepted(area, province),
        slots: {
          preferred_area: area,
          preferred_province: province,
          location_confirmation: 'confirmed',
          location_confirmed: 'yes',
        },
        next_state: 'collecting_movein',
      };
    }
    if (/^(b|2|no|n|nope|another|different)$/.test(normalized)) {
      return {
        reply: buildRentalAreaRetry(),
        slots: { location_confirmation: 'retry' },
        next_state: 'collecting_budget',
      };
    }
    return {
      reply: buildRentalAreaConfirmation(existingSlots.pending_area ?? 'that city', existingSlots.pending_province ?? 'that province'),
      slots: {},
      next_state: 'collecting_budget',
    };
  }

  if (!existingSlots.preferred_area) {
    const location = parseCanadianLocation(message);
    if (!location) return undefined;
    return {
      reply: buildRentalAreaConfirmation(location.area, location.province),
      slots: {
        pending_area: location.area,
        pending_province: location.province,
        location_confirmation: 'pending',
      },
      next_state: 'collecting_budget',
    };
  }

  if (!existingSlots.bedrooms) {
    const bedrooms =
      /^(a|studio)$/.test(normalized) ? '0'
        : /^(b|1|one)(?: bedroom)?$/.test(normalized) ? '1'
          : /^(c|2|two)(?: bedrooms?)?$/.test(normalized) ? '2'
            : /^(?:3\+|three\+|3 plus|three plus)(?: bedrooms?)?$/.test(normalized) ? '3+'
              : /^(d|3|three)(?: bedrooms?)?$/.test(normalized) ? '3'
              : undefined;
    if (!bedrooms) return undefined;
    return {
      reply: buildRentalPetsQuestion(bedrooms),
      slots: { bedrooms },
      next_state: 'collecting_movein',
    };
  }

  if (!existingSlots.pets) {
    const pets =
      /^(a|no|none|no pets?)$/.test(normalized) ? 'none'
        : /^(b|cat|cats)$/.test(normalized) ? 'cat'
          : /^(c|dog|dogs)$/.test(normalized) ? 'dog'
            : /^(d|other)$/.test(normalized) ? 'other'
              : undefined;
    if (!pets) return undefined;
    return {
      reply: buildRentalBudgetQuestion(pets),
      slots: { pets },
      next_state: 'collecting_budget',
    };
  }

  if (!existingSlots.budget) {
    const amount = message.replace(/,/g, '').match(/\$?\s*(\d{3,5})/)?.[1];
    if (!amount) return undefined;
    return {
      reply: buildRentalMoveInQuestion(amount),
      slots: { budget: amount },
      next_state: 'collecting_movein',
    };
  }

  if (!existingSlots.move_in_date && message) {
    const moveInTiming = canonicalizeMoveInTiming(message);
    return {
      reply: buildRentalMoveInAcknowledgement(moveInTiming),
      slots: { move_in_date: moveInTiming },
      next_state: 'proposing_tour',
    };
  }

  if (/match|option|available|show|listing|properties|units|what(?: else)? do you have|anything else|other (?:homes|options|listings)/i.test(message)) {
    return {
      reply: "I have your preferences. I'll show you the best available matches.",
      slots: {},
      intent: /\b(?:more|else|other|additional)\b/i.test(message) ? 'request_more_options' : 'request_matches',
      next_state: 'proposing_tour',
    };
  }

  if (
    existingSlots.selected_unit_id
    && /^(yes|y|sure|okay|ok|please|schedule|book|set it up)$/i.test(normalized)
  ) {
    return {
      reply: "Absolutely — let's find a tour time that works for you.",
      slots: {},
      next_state: 'scheduling',
    };
  }

  return undefined;
}

export function buildDeterministicQualificationTurn(
  userMessage: string,
  existingSlots: Record<string, string>,
  tenantName = 'Pacific Ridge Property Management',
): InterpretedTurn | undefined {
  const noMatchTurn = buildNoMatchAdjustmentTurn(userMessage, existingSlots);
  if (noMatchTurn) return noMatchTurn;

  const ownershipTurn = buildOwnershipConversationTurn(userMessage, existingSlots);
  if (ownershipTurn) return ownershipTurn;

  const intent = existingSlots.transaction_intent;
  if (!intent || intent === 'rent' || shouldUseDeterministicFastPath(userMessage)) {
    return buildFastQualificationTurn(userMessage, existingSlots, tenantName);
  }
  return undefined;
}

export function buildNoInventoryRecoveryTurn(slots: Record<string, string>): InterpretedTurn {
  const area = slots.preferred_area ?? 'that area';
  const bedrooms = describeRequestedBedrooms(slots).adjective;
  const budget = Number.parseInt(slots.budget ?? '', 10);
  const budgetLabel = Number.isNaN(budget) ? 'your current budget' : `$${budget.toLocaleString('en-CA')}/month`;
  return {
    reply: buildRentalNoInventoryAreaPriorityReply(area, bedrooms, budgetLabel),
    slots: { pending_search_adjustment: 'confirm_area_priority' },
    next_state: 'collecting_movein',
  };
}

function describeRequestedBedrooms(slots: Record<string, string>): {
  adjective: string;
  noun: string;
  count?: number;
} {
  const raw = slots.bedrooms?.trim();
  if (!raw) return { adjective: 'requested', noun: 'the requested size' };
  if (raw === '0') return { adjective: 'studio', noun: 'studios', count: 0 };
  if (raw.endsWith('+')) {
    const count = Number.parseInt(raw, 10);
    return {
      adjective: Number.isNaN(count) ? raw : `${count}+ bedroom`,
      noun: Number.isNaN(count) ? raw : `${count}+ bedrooms`,
      count: Number.isNaN(count) ? undefined : count,
    };
  }
  const count = Number.parseInt(raw, 10);
  if (Number.isNaN(count)) return { adjective: `${raw}-bedroom`, noun: `${raw} bedrooms` };
  return {
    adjective: `${count}-bedroom`,
    noun: `${count} bedrooms`,
    count,
  };
}

function formatMonthlyAmount(amountCents: number | undefined): string | undefined {
  if (!amountCents || Number.isNaN(amountCents)) return undefined;
  return `$${(amountCents / 100).toLocaleString('en-CA')}/month`;
}

function formatIsoDate(date: Date | null | undefined): string | undefined {
  if (!date) return undefined;
  return date.toISOString().slice(0, 10);
}

function formatReadableAddress(
  address: string | undefined,
  city: string | undefined,
  province: string | undefined,
): string {
  return [
    address?.trim(),
    [city?.trim(), province?.trim()].filter(Boolean).join(', '),
  ].filter(Boolean).join('\n');
}

function formatStoredAddress(address: string): string {
  const parts = address.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return address;
  return [parts[0], parts.slice(1).join(', ')].join('\n');
}

export function buildShortlistMarkdownLink(token: string): string {
  const baseUrl = (process.env.WEB_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
  const url = `${baseUrl}/shortlist/${token}`;
  return `[Open your shortlist](${url})\n${url}`;
}

function formatRecommendationOption(unit: AvailableUnit, index: number): string {
  return [
    `*Option ${index + 1}: ${unit.propertyName} — ${unit.name}*`,
    `• *Rent:* $${(unit.rentCents / 100).toLocaleString('en-CA')}/month`,
    `• *Location:* ${unit.city}${unit.province ? `, ${unit.province}` : ''}`,
    unit.address ? `• *Address:*\n${formatReadableAddress(unit.address, unit.city, unit.province)}` : undefined,
    unit.bedrooms !== null ? `• *Bedrooms:* ${unit.bedrooms}` : undefined,
    unit.bathrooms !== null ? `• *Bathrooms:* ${unit.bathrooms}` : undefined,
    unit.petPolicy ? `• *Pets:* ${unit.petPolicy}` : undefined,
    formatIsoDate(unit.availableFrom) ? `• *Available:* ${formatIsoDate(unit.availableFrom)}` : undefined,
  ].filter(Boolean).join('\n');
}

function formatOptionChoices(optionCount: number): string {
  const labels = Array.from({ length: optionCount }, (_, index) => `Option ${index + 1}`);
  if (labels.length <= 1) return labels[0] ?? 'Option 1';
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)}`;
}

function renderRecommendationPlan(plan: RecommendationDeliveryPlan): string {
  return [plan.intro, ...plan.options.map((option) => option.text), plan.outro]
    .filter(Boolean)
    .join('\n\n');
}

function omitSlotKeys(slots: Record<string, string>, keys: string[]): Record<string, string> {
  const clone = { ...slots };
  for (const key of keys) delete clone[key];
  return clone;
}

function bedroomLabelForReply(slots: Record<string, string>): string {
  return describeRequestedBedrooms(slots).adjective;
}

export function buildInventoryRecoveryTurn(
  units: AvailableUnit[],
  slots: Record<string, string>,
): InterpretedTurn {
  const area = slots.preferred_area ?? 'that area';
  const province = slots.preferred_province ?? 'British Columbia';
  const budget = parseBudget(slots.budget);
  const bedroomLabel = describeRequestedBedrooms(slots);
  const needsImmediateMoveIn = /\b(?:as soon as possible|asap|immediately|right away)\b/i.test(slots.move_in_date ?? '');

  if (needsImmediateMoveIn) {
    const futureMatches = rankMatchingUnits(
      filterQualifiedUnits(units, omitSlotKeys(slots, ['preferred_area', 'budget', 'move_in_date'])),
      slots,
    ).filter((unit) => Boolean(unit.availableFrom && unit.availableFrom > new Date()));
    if (futureMatches.length > 0) {
      const soonest = [...futureMatches].sort((left, right) =>
        (left.availableFrom?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.availableFrom?.getTime() ?? Number.MAX_SAFE_INTEGER)
        || left.rentCents - right.rentCents
      )[0];
      const availableDate = formatIsoDate(soonest.availableFrom);
      return {
        reply:
          `I don't currently have a ${bedroomLabel.adjective} home available right away. ` +
          `The first one I can offer is in ${soonest.city}${availableDate ? `, available on ${availableDate}` : ''}. ` +
          `Would that timing work for you?`,
        slots: {
          pending_search_adjustment: 'offer_move_in_date',
          suggested_move_in_date: availableDate ?? '',
          suggested_area: soonest.city,
          suggested_province: soonest.province ?? province,
        },
        next_state: 'collecting_movein',
      };
    }
  }

  const sameAreaAnyBudget = rankMatchingUnits(
    filterQualifiedUnits(units, omitSlotKeys(slots, ['budget'])),
    slots,
  );
  if (sameAreaAnyBudget.length > 0 && budget) {
    const minimumRent = Math.min(...sameAreaAnyBudget.map((unit) => unit.rentCents));
    if (minimumRent > budget) {
      return {
        reply:
          `I found the main constraint. The lowest current price I found for ${bedroomLabel.noun} in ${area} ` +
          `is ${formatMonthlyAmount(minimumRent)}. Would that budget work for you?`,
        slots: {
          pending_search_adjustment: 'offer_budget',
          suggested_budget: String(Math.round(minimumRent / 100)),
        },
        next_state: 'collecting_budget',
      };
    }
  }

  const exactElsewhereAnyBudget = rankMatchingUnits(
    filterQualifiedUnits(units, omitSlotKeys(slots, ['preferred_area', 'budget'])),
    slots,
  ).filter((unit) => unit.city.toLowerCase() !== area.toLowerCase());
  if (exactElsewhereAnyBudget.length > 0) {
    const closest = [...exactElsewhereAnyBudget].sort((left, right) =>
      cityDistanceKm(area, left.city) - cityDistanceKm(area, right.city)
      || left.rentCents - right.rentCents
    )[0];
    return {
      reply:
        `I checked carefully, and I don't currently have any ${bedroomLabel.adjective} rentals in ${area}. ` +
        `The closest place I do have one is ${closest.city}. Would you like me to check ${closest.city} instead?`,
      slots: {
        pending_search_adjustment: 'offer_area',
        suggested_area: closest.city,
        suggested_province: closest.province ?? province,
      },
      next_state: 'collecting_movein',
    };
  }

  const requestedBedrooms = Number.parseInt(slots.bedrooms ?? '', 10);
  const sameAreaFlexibleBedrooms = rankMatchingUnits(
    filterQualifiedUnits(units, omitSlotKeys(slots, ['bedrooms'])),
    slots,
  ).filter((unit) =>
    unit.city.toLowerCase() === area.toLowerCase()
    && unit.bedrooms !== null
    && !Number.isNaN(requestedBedrooms)
    && unit.bedrooms < requestedBedrooms
  );
  if (sameAreaFlexibleBedrooms.length > 0) {
    const closest = [...sameAreaFlexibleBedrooms].sort((left, right) =>
      Math.abs((left.bedrooms ?? 0) - requestedBedrooms) - Math.abs((right.bedrooms ?? 0) - requestedBedrooms)
      || right.rentCents - left.rentCents
    )[0];
    return {
      reply:
        `I don't have a ${bedroomLabel.adjective} home in ${area} right now, but I do have ` +
        `${closest.bedrooms}-bedroom options there. Would you like me to look at ${closest.bedrooms} bedrooms instead?`,
      slots: {
        pending_search_adjustment: 'offer_bedrooms',
        suggested_bedrooms: String(closest.bedrooms),
      },
      next_state: 'collecting_movein',
    };
  }

  return buildNoInventoryRecoveryTurn(slots);
}

export function buildNoMatchAdjustmentTurn(
  userMessage: string,
  slots: Record<string, string>,
): InterpretedTurn | undefined {
  const pending = slots.pending_search_adjustment;
  if (!pending) return undefined;
  const normalized = userMessage.trim().toLowerCase().replace(/[.!?]+$/g, '');
  const yes = /^(?:yes|y|yeah|yep|correct|keep it)$/.test(normalized);
  const no = /^(?:no|n|nope|not necessarily|i'm flexible|im flexible)$/.test(normalized);

  if (pending === 'offer_area') {
    const suggestedArea = slots.suggested_area;
    const suggestedProvince = slots.suggested_province ?? 'British Columbia';
    if (yes && suggestedArea) {
      return {
        reply: `Perfect. I'll switch the search to ${suggestedArea} and pull the closest matches there now.`,
        slots: {
          preferred_area: suggestedArea,
          preferred_province: suggestedProvince,
          pending_search_adjustment: 'resolved',
        },
        next_state: 'proposing_tour',
        intent: 'request_matches',
      };
    }
    if (no) {
      return {
        reply: `No problem. Which nearby city would you like me to try next while we keep the ${bedroomLabelForReply(slots)} requirement?`,
        slots: { pending_search_adjustment: 'collect_area' },
        next_state: 'collecting_movein',
      };
    }
    const typedLocation = parseCanadianLocation(userMessage);
    if (typedLocation) {
      return {
        reply: `Perfect. I'll switch the search to ${typedLocation.area} and pull the closest matches there now.`,
        slots: {
          preferred_area: typedLocation.area,
          preferred_province: typedLocation.province,
          pending_search_adjustment: 'resolved',
        },
        next_state: 'proposing_tour',
        intent: 'request_matches',
      };
    }
    return {
      reply: `Would you like me to check ${suggestedArea ?? 'that nearby city'} instead?`,
      slots: {},
      next_state: 'collecting_movein',
    };
  }

  if (pending === 'offer_budget') {
    const suggestedBudget = slots.suggested_budget;
    if (yes && suggestedBudget) {
      return {
        reply: `Perfect. I'll rerun the search with a maximum of $${Number(suggestedBudget).toLocaleString('en-CA')}/month.`,
        slots: { budget: suggestedBudget, pending_search_adjustment: 'resolved' },
        next_state: 'proposing_tour',
        intent: 'request_matches',
      };
    }
    const directBudget = userMessage.replace(/,/g, '').match(/\$?\s*(\d{3,5})/)?.[1];
    if (directBudget) {
      return {
        reply: `Perfect. I'll rerun the search with a maximum of $${Number(directBudget).toLocaleString('en-CA')}/month.`,
        slots: { budget: directBudget, pending_search_adjustment: 'resolved' },
        next_state: 'proposing_tour',
        intent: 'request_matches',
      };
    }
    if (no) {
      return {
        reply: `No problem. Which nearby city would you like me to try while I keep your budget at $${Number(slots.budget ?? 0).toLocaleString('en-CA')}?`,
        slots: { pending_search_adjustment: 'collect_area' },
        next_state: 'collecting_movein',
      };
    }
    return {
      reply: `Would ${suggestedBudget ? `$${Number(suggestedBudget).toLocaleString('en-CA')}/month` : 'that budget'} work for you?`,
      slots: {},
      next_state: 'collecting_budget',
    };
  }

  if (pending === 'offer_bedrooms') {
    const suggestedBedrooms = slots.suggested_bedrooms;
    if (yes && suggestedBedrooms) {
      return {
        reply: `Perfect. I'll look for ${suggestedBedrooms} bedrooms in ${slots.preferred_area ?? 'that area'} now.`,
        slots: { bedrooms: suggestedBedrooms, pending_search_adjustment: 'resolved' },
        next_state: 'proposing_tour',
        intent: 'request_matches',
      };
    }
    const directBedrooms = userMessage.match(/^(\d{1,2})(?:\+)?$/)?.[1];
    if (directBedrooms) {
      return {
        reply: `Perfect. I'll look for ${directBedrooms} bedrooms in ${slots.preferred_area ?? 'that area'} now.`,
        slots: { bedrooms: directBedrooms, pending_search_adjustment: 'resolved' },
        next_state: 'proposing_tour',
        intent: 'request_matches',
      };
    }
    if (no) {
      return {
        reply: `No problem. Then let's keep the ${bedroomLabelForReply(slots)} requirement. Which nearby city would you like me to try next?`,
        slots: { pending_search_adjustment: 'collect_area' },
        next_state: 'collecting_movein',
      };
    }
    return {
      reply: `Would you like me to look at ${suggestedBedrooms ?? 'that'} bedrooms instead?`,
      slots: {},
      next_state: 'collecting_movein',
    };
  }

  if (pending === 'offer_move_in_date') {
    const suggestedMoveInDate = slots.suggested_move_in_date;
    const areaPriority = Boolean(
      slots.preferred_area
      && normalized.includes(slots.preferred_area.toLowerCase())
      && /\b(?:want|need|prefer|keep)\b/.test(normalized),
    );
    const explicitlyAcceptsTiming = /\b(?:timing|date)\s+(?:yes|works|is fine|okay|ok)\b/.test(normalized)
      || /\byes\s+(?:to|for)\s+(?:the\s+)?(?:timing|date)\b/.test(normalized);
    const yesLike = yes || explicitlyAcceptsTiming || /^(?:ok|okay|sure|works|that works|fine)\b/.test(normalized);
    const noLike = no || /^(?:no|nope)\b/.test(normalized);

    if (yesLike && suggestedMoveInDate) {
      const date = new Date(`${suggestedMoveInDate}T00:00:00`);
      const moveInLabel = date.toLocaleString('en-CA', { month: 'long', year: 'numeric' });
      return {
        reply: `Perfect. I'll keep searching with a move-in around ${moveInLabel}.`,
        slots: {
          move_in_date: moveInLabel,
          pending_search_adjustment: 'resolved',
        },
        next_state: 'proposing_tour',
        intent: 'request_matches',
      };
    }
    if (noLike && areaPriority && slots.suggested_area) {
      return {
        reply:
          `Understood — if ${slots.preferred_area ?? 'that area'} is the priority, changing the move-in date alone won't solve it. ` +
          `The closest real alternative I can offer is ${slots.suggested_area}. Would you like me to show you that nearby option?`,
        slots: {
          pending_search_adjustment: 'offer_area',
          suggested_area: slots.suggested_area,
          suggested_province: slots.suggested_province ?? 'British Columbia',
        },
        next_state: 'collecting_movein',
      };
    }
    if (noLike) {
      return {
        reply: 'No problem. What is the latest move-in month that would still work for you?',
        slots: { pending_search_adjustment: 'collect_move_in_date' },
        next_state: 'collecting_movein',
      };
    }

    const monthAliases: Record<string, string> = {
      jan: 'January', january: 'January',
      feb: 'February', february: 'February',
      mar: 'March', march: 'March',
      apr: 'April', april: 'April',
      may: 'May',
      jun: 'June', june: 'June',
      jul: 'July', july: 'July',
      aug: 'August', august: 'August',
      sep: 'September', sept: 'September', september: 'September',
      oct: 'October', october: 'October',
      nov: 'November', november: 'November',
      dec: 'December', december: 'December',
    };
    const month = monthAliases[normalized];
    if (month) {
      return {
        reply: `Perfect. I'll keep searching with a move-in around ${month}.`,
        slots: {
          move_in_date: month,
          pending_search_adjustment: 'resolved',
        },
        next_state: 'proposing_tour',
        intent: 'request_matches',
      };
    }
    return {
      reply: `Would ${suggestedMoveInDate ?? 'that timing'} work for you?`,
      slots: {},
      next_state: 'collecting_movein',
    };
  }

  if (pending === 'confirm_area_priority') {
    if (yes) {
      return {
        reply: buildRentalAreaPriorityBudgetReply(slots.preferred_area ?? 'the area'),
        slots: { pending_search_adjustment: 'collect_budget' },
        next_state: 'collecting_budget',
      };
    }
    if (no) {
      return {
        reply: 'Which nearby city or area would you be open to considering?',
        slots: { pending_search_adjustment: 'collect_area' },
        next_state: 'collecting_movein',
      };
    }
    return {
      reply: `To narrow this down one step at a time: is keeping ${slots.preferred_area ?? 'the same area'} your top priority?`,
      slots: {},
      next_state: 'collecting_movein',
    };
  }

  if (pending === 'collect_budget') {
    const amount = userMessage.replace(/,/g, '').match(/\$?\s*(\d{3,5})/)?.[1];
    if (!amount) {
      return { reply: 'What maximum monthly budget would be comfortable?', slots: {}, next_state: 'collecting_budget' };
    }
    if (slots.budget && Number(amount) <= Number(slots.budget)) {
      return {
        reply: buildRentalSameBudgetLoopReply(
          slots.preferred_area ?? 'that area',
          slots.budget,
          bedroomLabelForReply(slots),
        ),
        slots: { pending_search_adjustment: 'collect_area' },
        next_state: 'collecting_movein',
      };
    }
    return {
      reply: `Thanks - I'll search ${slots.preferred_area ?? 'the same area'} again with a maximum of $${Number(amount).toLocaleString('en-CA')}/month.`,
      slots: { budget: amount, pending_search_adjustment: 'resolved' },
      next_state: 'proposing_tour',
      intent: 'request_matches',
    };
  }

  if (pending === 'collect_area') {
    return {
      reply: `Thanks — I'll check ${userMessage.trim()} while keeping your $${Number(slots.budget ?? 0).toLocaleString('en-CA')} budget fixed.`,
      slots: { preferred_area: userMessage.trim(), pending_search_adjustment: 'resolved' },
      next_state: 'proposing_tour',
      intent: 'request_matches',
    };
  }
  if (pending === 'collect_move_in_date') {
    const monthAliases: Record<string, string> = {
      jan: 'January', january: 'January',
      feb: 'February', february: 'February',
      mar: 'March', march: 'March',
      apr: 'April', april: 'April',
      may: 'May',
      jun: 'June', june: 'June',
      jul: 'July', july: 'July',
      aug: 'August', august: 'August',
      sep: 'September', sept: 'September', september: 'September',
      oct: 'October', october: 'October',
      nov: 'November', november: 'November',
      dec: 'December', december: 'December',
    };
    const cleaned = normalized.replace(/[.!?]/g, '');
    const month = monthAliases[cleaned];
    if (!month) {
      return {
        reply: 'What move-in month should I use?',
        slots: {},
        next_state: 'collecting_movein',
      };
    }
    return {
      reply: `Perfect. I'll keep searching with a move-in around ${month}.`,
      slots: { move_in_date: month, pending_search_adjustment: 'resolved' },
      next_state: 'proposing_tour',
      intent: 'request_matches',
    };
  }
  return undefined;
}

function buildSystemPrompt(
  state: ConversationState,
  availableUnits: Array<AvailableUnit>,
  slots: Record<string, string>,
  knowledgeContext = '',
  tenantName = 'our property management company',
): string {
  const unitsText = availableUnits.length > 0
    ? availableUnits.map((unit) => {
      const details = [
        unit.bedrooms !== null ? `${unit.bedrooms} bed` : undefined,
        unit.bathrooms !== null ? `${unit.bathrooms} bath` : undefined,
        unit.petPolicy ?? undefined,
      ].filter(Boolean).join(', ');
      return `- inventory_id=${unit.id}: ${unit.propertyName} ${unit.name} in ${unit.city}: $${(unit.rentCents / 100).toFixed(0)}/month${details ? ` (${details})` : ''}`;
    }).join('\n')
    : 'There are no available units right now.';

  const slotsText = Object.keys(slots).length > 0
    ? '\nKnown user information:\n' + Object.entries(slots).map(([key, value]) => `  ${key}: ${value}`).join('\n')
    : '';

  return [
    `You are the Virtual Agent for ${tenantName}, a property management company in British Columbia, Canada.`,
    'You answer inquiries from people interested in renting properties.',
    '',
    'CONVERSATION STYLE (very important):',
    '- Be warm, natural and conversational — like a friendly human leasing assistant, not a robot.',
    '- Follow basic hospitality etiquette: acknowledge what the person said before moving to the next question, and never respond with a bare questionnaire prompt.',
    '- When the prospect first shares their name, greet them by name, thank them, and explicitly offer your help before asking the next question.',
    '- Use the prospect name sparingly: when first greeting them, for an important confirmation, or when closing. Do not repeat it in every response.',
    '- Acknowledge corrections explicitly, replace the old fact, and never keep contradictory values.',
    '- Extract every useful fact in a message. If someone mentions household, pets, budget, and timing together, do not ask for those facts again.',
    '- Treat confusion, objections, uncertainty, and questions as conversational acts, not as literal answers to the pending field.',
    '- If the prospect asks an incidental question, answer it first, preserve progress, and then naturally resume the one missing qualification question.',
    '- Never equate liking a property, viewing tour times, and confirming a booking; those are separate commitments.',
    '- After a tour is scheduled, answer logistics, address, rescheduling, or cancellation from the active appointment context. Do not restart recommendations unless explicitly asked.',
    '- Use the prospect name sparingly after that welcome; do not repeat it in every message.',
    '- If you misunderstood or must ask again, briefly acknowledge the confusion instead of repeating the identical sentence.',
    '- Vary your wording; never repeat the same question you just asked.',
    '- Use at most 1-2 short sentences per message. Keep it brief and human.',
    '- Understand the meaning of the user message before extracting data. A question, objection, correction, or expression of confusion is not a name, location, budget, or other fact.',
    '- Only save prospect_name when the user clearly introduces themselves or gives a plausible standalone personal name. If they do not understand a question, explain it naturally and ask again.',
    '- Determine the user intent from meaning and conversation context, including references such as "both", "the cheaper one", "what else", corrections, and abbreviations.',
    '- When the user refers to displayed options, return intent select_options and one-based selected_options. Use selection_scope all for "both/all" when it refers to every displayed option.',
    '- When the user asks to see matches, use intent request_matches. For additional/different inventory, use request_more_options.',
    '- Never invent, rename, or quote a property as available in reply. Inventory recommendations are rendered by the backend after you return request_matches/request_more_options.',
    '- When the conversation starts (greeting state), ALWAYS begin with a warm greeting, introduce yourself as the Virtual Agent of the agency by name, and explicitly ask whether the person is looking to rent, buy, or sell a property. Never jump straight to asking for budget on first contact.',
    `- The agency name is "${tenantName}". Refer to yourself as the Virtual Agent of ${tenantName}.`,
    '- Do not provide legal or financial advice; hand those questions off to a human.',
    '',
    'Your goal is to qualify the prospect and schedule a property tour.',
    '',
    `Current conversation state: ${state}`,
    'Funnel states: greeting -> collecting_budget -> collecting_movein -> proposing_units -> proposing_tour -> scheduling -> handoff',
    '- greeting: introduce yourself as the Virtual Agent and ask whether the person wants to rent, buy, or sell. Do NOT ask for budget yet.',
    '- collecting_budget: continue collecting the next missing qualification detail; do not assume this state always means budget.',
    '- collecting_movein: continue collecting the next missing qualification detail, one question at a time.',
    '- proposing_units: suggest matching units',
    '- proposing_tour: offer to schedule a tour',
    '- scheduling: move into tour scheduling through ShowMojo',
    '- handoff: hand off to a human when the question is out of scope',
    '',
    'QUALIFICATION BEFORE RECOMMENDING:',
    '- For rentals, collect information in this order: first name, city/province confirmation, bedrooms, pets, monthly budget, move-in timing.',
    '- Never ask for a later item while an earlier item in that sequence is missing. If the user volunteers information out of order, extract and retain it, then ask for the earliest missing item.',
    '- Do not suggest, name, or rank any unit until you know all of: preferred area/location priorities, bedrooms needed, pets (including none), monthly budget, and move-in timing.',
    '- Learn these needs conversationally, one useful question at a time. Acknowledge what the prospect just said before asking.',
    '- Ask about lifestyle priorities such as transit, work location, parking, accessibility, or furnished housing when relevant to what the prospect says.',
    '- Never infer a preferred city from an old conversation or from the available inventory.',
    '',
    'Available units:',
    unitsText,
    slotsText,
    knowledgeContext ? `\nCompany/property knowledge:\n${knowledgeContext}` : '',
    '',
    'Return exactly one JSON object with this shape:',
    '{"intent":"one allowed semantic intent","reply":"your natural response","selected_options":[1,2],"selection_scope":"single|multiple|all","slots":{"prospect_name":"known value","transaction_intent":"rent|buy|sell","budget":"known value","move_in_date":"known value","occupants":"known value","pets":"known value","preferred_area":"known value","preferred_province":"known value","bedrooms":"known value"},"next_state":"one valid conversation state"}',
    'Always include intent, reply, and next_state. Put extracted renter facts only inside slots. Omit unknown values and omit selected_options unless the user actually refers to displayed options.',
    'Classify facts by their meaning, not by the current funnel state: a place or region such as "Metro Vancouver" is preferred_area, never budget. Budget must be a monetary amount or range.',
  ].join('\n');
}

async function getTenantName(tenantId: string): Promise<string> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true },
  });
  return tenant?.name ?? 'our property management company';
}

async function getTenantKnowledgeContext(tenantId: string, query: string): Promise<string> {
  const [onboarding, documents, chunks] = await Promise.all([
    prisma.tenantOnboardingProfile.findUnique({ where: { tenantId } }),
    prisma.knowledgeDocument.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: { filename: true, category: true, description: true, textContent: true },
    }),
    prisma.knowledgeChunk.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
      take: 300,
      select: {
        sourceType: true,
        sourceId: true,
        title: true,
        content: true,
        chunkIndex: true,
      },
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
  const rankedChunks = rankKnowledgeChunks(chunks, query).slice(0, 5);
  if (rankedChunks.length > 0) {
    lines.push(formatKnowledgeContext(rankedChunks));
  }
  return lines.join('\n');
}

async function getAvailableUnits(
  tenantId: string,
  _slots: Record<string, string>,
): Promise<AvailableUnit[]> {
  const units = await prisma.unit.findMany({
    where: {
      tenantId,
      isActive: true,
    },
    include: {
      property: { select: { name: true, address: true, city: true, province: true } },
      listingPhotos: {
        take: 4,
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      },
    },
    take: 50,
  });
  return units.map((unit) => ({
    id: unit.id,
    name: unit.name,
    rentCents: unit.rentCents,
    propertyName: unit.property.name,
    address: unit.property.address,
    city: unit.property.city,
    province: unit.property.province,
    bedrooms: unit.bedrooms,
    bathrooms: unit.bathrooms,
    availableFrom: unit.availableFrom,
    petPolicy: unit.petPolicy,
    parking: unit.parking,
    utilities: unit.utilities,
    slug: unit.slug,
    photoUrl: unit.listingPhotos[0]?.enhancedUrl ?? unit.listingPhotos[0]?.originalUrl,
    photoUrls: unit.listingPhotos.map((photo) => photo.enhancedUrl ?? photo.originalUrl),
    landingUrl: `${(process.env.WEB_URL ?? 'http://localhost:5173').replace(/\/+$/, '')}/listings/${unit.slug}?tenant=${encodeURIComponent(tenantId)}`,
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
  const linkedConversation = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
    select: { leadId: true },
  });
  if (linkedConversation?.leadId) {
    await prisma.lead.update({
      where: { id: linkedConversation.leadId },
      data: { ...getExistingLeadChannelUpdate(channel), ...(unitId ? { unitId } : {}) },
    });
    return false;
  }
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

export function prepareConversationHistory(
  newestFirst: Array<{ role: string; content: string }>,
  isStartCommand: boolean,
): Array<{ role: string; content: string }> {
  if (isStartCommand) return [];
  const chronological = [...newestFirst].reverse().map(({ role, content }) => ({ role, content }));
  let latestStartIndex = -1;
  chronological.forEach((message, index) => {
    if (message.role === 'user' && /^\/(start|begin|reset)(\b|$)/i.test(message.content.trim())) {
      latestStartIndex = index;
    }
  });
  return latestStartIndex >= 0 ? chronological.slice(latestStartIndex + 1) : chronological;
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

export function excludePreviouslyShownUnits(units: AvailableUnit[], shownUnitIds: string[]): AvailableUnit[] {
  const shown = new Set(shownUnitIds);
  return units.filter((unit) => !shown.has(unit.id));
}

export function filterQualifiedUnits(units: AvailableUnit[], slots: Record<string, string>): AvailableUnit[] {
  const area = slots.preferred_area?.trim().toLowerCase();
  const province = normalizeProvince(slots.preferred_province);
  const bedroomsIsMinimum = slots.bedrooms?.trim().endsWith('+') ?? false;
  const bedrooms = bedroomsIsMinimum ? Number.NaN : Number.parseInt(slots.bedrooms ?? '', 10);
  const bedroomsMin = bedroomsIsMinimum
    ? Number.parseInt(slots.bedrooms ?? '', 10)
    : Number.parseInt(slots.bedrooms_min ?? '', 10);
  const bedroomsMax = Number.parseInt(slots.bedrooms_max ?? '', 10);
  const budget = parseBudget(slots.budget);
  const pets = slots.pets?.toLowerCase();
  const moveInDeadline = parseMoveInDeadline(slots.move_in_date);
  const requiresImmediateAvailability = /\b(?:as soon as possible|asap|immediately|right away)\b/i.test(slots.move_in_date ?? '');
  return units.filter((unit) => {
    const city = unit.city.toLowerCase();
    const areaMatches = !area || (area.includes('metro vancouver') ? METRO_VANCOUVER_CITIES.has(city) : city.includes(area) || area.includes(city));
    const provinceMatches = !province || normalizeProvince(unit.province) === province;
    const exactBedroomsMatch = Number.isNaN(bedrooms) || (unit.bedrooms !== null && unit.bedrooms === bedrooms);
    const minimumBedroomsMatch = Number.isNaN(bedroomsMin) || (unit.bedrooms !== null && unit.bedrooms >= bedroomsMin);
    const maximumBedroomsMatch = Number.isNaN(bedroomsMax) || (unit.bedrooms !== null && unit.bedrooms <= bedroomsMax);
    const bedroomsMatch = exactBedroomsMatch && minimumBedroomsMatch && maximumBedroomsMatch;
    const budgetMatches = !budget || unit.rentCents <= budget;
    const policy = unit.petPolicy?.toLowerCase() ?? '';
    const petsMatch = !pets || pets === 'none' || (pets.includes('cat') ? /cat|pet friendly/.test(policy) : pets.includes('dog') ? /dog|pet friendly/.test(policy) : true);
    const availabilityMatches = !moveInDeadline
      || (requiresImmediateAvailability
        ? Boolean(unit.availableFrom && unit.availableFrom <= moveInDeadline)
        : !unit.availableFrom || unit.availableFrom <= moveInDeadline);
    return areaMatches && provinceMatches && bedroomsMatch && budgetMatches && petsMatch && availabilityMatches;
  });
}

function parseMoveInDeadline(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  if (/\b(?:as soon as possible|asap|immediately|right away)\b/i.test(value)) return new Date();
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const month = monthNames.findIndex((name) => value.toLowerCase().includes(name));
  if (month < 0) return undefined;
  const statedYear = Number.parseInt(value.match(/\b(20\d{2})\b/)?.[1] ?? '', 10);
  const now = new Date();
  let year = Number.isNaN(statedYear) ? now.getFullYear() : statedYear;
  if (Number.isNaN(statedYear) && month < now.getMonth()) year += 1;
  return new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
}

function legacyBuildClosestAlternativeRecommendation(
  units: AvailableUnit[],
  slots: Record<string, string>,
): { units: AvailableUnit[]; reply: string } | undefined {
  const { preferred_area: rawRequestedArea, budget: requestedBudget, bedrooms: requestedBedrooms, ...baseSlots } = slots;
  const requestedArea = rawRequestedArea ? normalizeCanadianCity(rawRequestedArea) : undefined;
  const province = normalizeProvince(slots.preferred_province);
  const wantedBedrooms = Number.parseInt(requestedBedrooms ?? '', 10);
  const budget = parseBudget(requestedBudget);
  const sameProvince = units.filter((unit) => !province || normalizeProvince(unit.province) === province);
  const card = (unit: AvailableUnit, index = 0) => {
    const details = [
      `*Option ${index + 1}: ${unit.propertyName} — ${unit.name}*`,
      `• *Rent:* $${(unit.rentCents / 100).toLocaleString('en-CA')}/month`,
      `• *Location:* ${unit.city}${unit.province ? `, ${unit.province}` : ''}`,
      unit.address ? `• *Address:* ${unit.address}, ${unit.city}${unit.province ? `, ${unit.province}` : ''}` : undefined,
      unit.bedrooms !== null ? `• *Bedrooms:* ${unit.bedrooms}` : undefined,
      unit.bathrooms !== null ? `• *Bathrooms:* ${unit.bathrooms}` : undefined,
      unit.petPolicy ? `• *Pets:* ${unit.petPolicy}` : undefined,
      unit.availableFrom ? `• *Available:* ${unit.availableFrom.toLocaleDateString('en-CA')}` : undefined,
    ].filter(Boolean);
    return `\n\n${details.join('\n')}`;
  };

  const requestedAreaIsMetroVancouver = requestedArea
    ? requestedArea.toLowerCase().includes('metro vancouver') || METRO_VANCOUVER_CITIES.has(requestedArea.toLowerCase())
    : false;
  const cityAlternatives = filterQualifiedUnits(sameProvince, {
    ...baseSlots,
    ...(requestedBudget ? { budget: requestedBudget } : {}),
    ...(requestedBedrooms ? { bedrooms: requestedBedrooms } : {}),
  }).filter((unit) =>
    (!requestedArea || !unit.city.toLowerCase().includes(requestedArea.toLowerCase()))
    && (!requestedAreaIsMetroVancouver || METRO_VANCOUVER_CITIES.has(unit.city.toLowerCase())),
  );
  if (cityAlternatives.length > 0) {
    const closest = [...cityAlternatives].sort((a, b) =>
      cityDistanceKm(requestedArea, a.city) - cityDistanceKm(requestedArea, b.city)
      || a.rentCents - b.rentCents
    )[0];
    const bedroomsLabel = Number.isNaN(wantedBedrooms) ? 'home' : `${wantedBedrooms}-bedroom home`;
    return {
      units: [closest],
      reply:
        `I took another look. I didn't find a ${bedroomsLabel} in ${requestedArea} that stays within your budget, ` +
        `but I did find one in ${closest.city} for $${(closest.rentCents / 100).toLocaleString('en-CA')}/month.` +
        card(closest) +
        `\n\nWould ${closest.city} work for you?`,
    };
  }

  const budgetAlternatives = filterQualifiedUnits(sameProvince, {
    ...baseSlots,
    ...(requestedArea ? { preferred_area: requestedArea } : {}),
    ...(requestedBedrooms ? { bedrooms: requestedBedrooms } : {}),
  }).filter((unit) => !budget || unit.rentCents > budget)
    .sort((a, b) => a.rentCents - b.rentCents);
  if (budgetAlternatives.length > 0 && budget) {
    const closest = budgetAlternatives[0];
    const difference = closest.rentCents - budget;
    return {
      units: [closest],
      reply:
        `I found something that matches the location and bedroom count. The closest fit is ` +
        `$${(closest.rentCents / 100).toLocaleString('en-CA')}/month — ` +
        `$${(difference / 100).toLocaleString('en-CA')} above your budget.` +
        card(closest) +
        `\n\nWould you be comfortable stretching the budget to $${(closest.rentCents / 100).toLocaleString('en-CA')}?`,
    };
  }

  const bedroomAlternatives = filterQualifiedUnits(sameProvince, {
    ...baseSlots,
    ...(requestedArea ? { preferred_area: requestedArea } : {}),
    ...(requestedBudget ? { budget: requestedBudget } : {}),
  }).filter((unit) => unit.bedrooms !== null)
    .sort((a, b) => Math.abs((a.bedrooms ?? 0) - wantedBedrooms) - Math.abs((b.bedrooms ?? 0) - wantedBedrooms));
  if (bedroomAlternatives.length > 0 && !Number.isNaN(wantedBedrooms)) {
    const closest = bedroomAlternatives[0];
    return {
      units: [closest],
      reply:
        `I couldn't find exactly ${wantedBedrooms} bedrooms in ${requestedArea}, but I found a ` +
        `${closest.bedrooms}-bedroom home there for $${(closest.rentCents / 100).toLocaleString('en-CA')}/month.` +
        card(closest) +
        `\n\nWould ${closest.bedrooms === 1 ? 'a one-bedroom home' : `${closest.bedrooms} bedrooms`} work for you?`,
    };
  }

  const combinedAlternatives = filterQualifiedUnits(sameProvince, {
    ...baseSlots,
    ...(requestedBedrooms ? { bedrooms: requestedBedrooms } : {}),
  }).filter((unit) =>
    (!requestedAreaIsMetroVancouver || METRO_VANCOUVER_CITIES.has(unit.city.toLowerCase()))
    && (!budget || unit.rentCents > budget),
  ).sort((a, b) => {
    const aOverBudget = budget ? Math.max(0, a.rentCents - budget) : 0;
    const bOverBudget = budget ? Math.max(0, b.rentCents - budget) : 0;
    const aScore = cityDistanceKm(requestedArea, a.city) + aOverBudget / 10_000;
    const bScore = cityDistanceKm(requestedArea, b.city) + bOverBudget / 10_000;
    return aScore - bScore || aOverBudget - bOverBudget;
  });
  if (combinedAlternatives.length > 0) {
    const alternatives = combinedAlternatives.slice(0, 3);
    const closest = alternatives[0];
    const difference = budget ? Math.max(0, closest.rentCents - budget) : 0;
    const petFit = slots.pets?.toLowerCase().includes('cat')
      ? ' It accepts cats.'
      : slots.pets?.toLowerCase().includes('dog')
        ? ' It accepts dogs.'
        : '';
    return {
      units: alternatives,
      reply:
        `I didn't find an exact match in ${requestedArea}. The closest available fit changes two things: ` +
        `the location is ${closest.city}, and the rent is ` +
        `$${(closest.rentCents / 100).toLocaleString('en-CA')}/month for ` +
        `${closest.bedrooms ?? 'a similar number of'} bedrooms` +
        (difference > 0 ? `, which is $${(difference / 100).toLocaleString('en-CA')} above your budget.` : '.') +
        petFit +
        alternatives.map((unit, index) => card(unit, index)).join('') +
        (alternatives.length > 1
          ? `\n\nThese are the closest real options in the current inventory. Which would you like to keep: ${alternatives.map((_, index) => `Option ${index + 1}`).join(', ')}, or all of them?`
          : `\n\nWould you be open to ${closest.city} at that price?`),
    };
  }

  return undefined;
}

export function buildUnitMatchReason(unit: AvailableUnit, slots: Record<string, string>): string {
  const reasons: string[] = [];
  const budget = parseBudget(slots.budget);
  const area = slots.preferred_area?.toLowerCase();
  const pets = slots.pets?.toLowerCase();
  const occupants = parseInt(slots.occupants ?? '', 10);
  const wantedBedrooms = parseInt(slots.bedrooms ?? '', 10);
  const moveInMonth = normalizeMonth(slots.move_in_date);

  if (budget && unit.rentCents <= budget) {
    const savingsCents = budget - unit.rentCents;
    if (savingsCents > 0) {
      reasons.push(`is under your $${(budget / 100).toLocaleString('en-CA')} budget by $${(savingsCents / 100).toLocaleString('en-CA')}/month`);
    } else {
      reasons.push(`fits the $${(budget / 100).toLocaleString('en-CA')} budget`);
    }
  }
  if (area && (`${unit.city} ${unit.propertyName}`).toLowerCase().includes(area)) reasons.push(`matches the ${slots.preferred_area} area`);
  if (pets && pets !== 'none' && unit.petPolicy?.toLowerCase().includes(pets)) reasons.push(`supports ${pets} needs`);
  if (!Number.isNaN(wantedBedrooms) && unit.bedrooms !== null && unit.bedrooms >= wantedBedrooms) {
    reasons.push(`has ${unit.bedrooms} bedroom${unit.bedrooms === 1 ? '' : 's'}`);
  } else if (!Number.isNaN(occupants) && unit.bedrooms !== null && unit.bedrooms >= Math.min(occupants, 3)) {
    reasons.push(`has enough bedrooms for ${occupants} people`);
  }
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
  const wantedBedrooms = parseInt(slots.bedrooms ?? '', 10);
  const moveInMonth = normalizeMonth(slots.move_in_date);

  if (budget) {
    if (unit.rentCents <= budget) {
      score += 30;
      // Bonus por valor: entre más barato (dentro del presupuesto), mejor.
      // Esto prioriza el ahorro del prospecto y desempata unidades que cumplen
      // los demás criterios por igual. Máx ~20 pts para una unidad muy barata.
      score += Math.min(20, (budget - unit.rentCents) / 10000);
    } else {
      score += -20;
      score -= Math.max(0, unit.rentCents - budget) / 10000;
    }
  }
  if (area && (`${unit.city} ${unit.propertyName}`).toLowerCase().includes(area)) score += 25;
  if (pets && pets !== 'none' && unit.petPolicy?.toLowerCase().includes(pets)) score += 15;
  // Preferir unidades que cumplan el número exacto de habitaciones pedido.
  if (!Number.isNaN(wantedBedrooms) && unit.bedrooms !== null) {
    if (unit.bedrooms === wantedBedrooms) score += 12;
    else if (unit.bedrooms > wantedBedrooms) score += 6; // algo mejor, pero no ideal (más caro)
    else score -= 15; // muy pequeña
  } else if (!Number.isNaN(occupants) && unit.bedrooms !== null && unit.bedrooms >= Math.min(occupants, 3)) {
    score += 10;
  }
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

export function legacyBuildUnitRecommendationReply(units: AvailableUnit[], slots: Record<string, string>): string {
  const options = units.slice(0, 3).map((unit, index) => {
    const lines = [
      `*Option ${index + 1}: ${unit.propertyName} — ${unit.name}*`,
      `• *Rent:* $${(unit.rentCents / 100).toLocaleString('en-CA')}/month`,
      `• *Location:* ${unit.city}`,
      unit.address ? `• *Address:* ${unit.address}, ${unit.city}${unit.province ? `, ${unit.province}` : ''}` : undefined,
      unit.bedrooms !== null ? `• *Bedrooms:* ${unit.bedrooms}` : undefined,
      unit.bathrooms !== null ? `• *Bathrooms:* ${unit.bathrooms}` : undefined,
      unit.petPolicy ? `• *Pets:* ${unit.petPolicy}` : undefined,
      unit.availableFrom ? `• *Available:* ${unit.availableFrom.toLocaleDateString('en-CA')}` : undefined,
    ].filter(Boolean);
    return lines.join('\n');
  }).join('\n\n');
  const reason = buildUnitMatchReason(units[0], slots);
  const occupants = Number.parseInt(slots.occupants ?? '', 10);
  const selectedBedrooms = units[0]?.bedrooms;
  const spaceCaution = !Number.isNaN(occupants)
    && selectedBedrooms !== null
    && selectedBedrooms !== undefined
    && occupants > selectedBedrooms + 1
      ? ` One important tradeoff: a ${selectedBedrooms}-bedroom home may feel tight for ${occupants === 3 ? 'three' : occupants} people.`
      : '';

  const choices = units.slice(0, 3).map((_, index) => index + 1).join(', ');
  return `Thanks for walking me through what you need. I found ${units.length === 1 ? 'one option' : 'a few options'} worth a look:${spaceCaution}\n\n${options}\n\n*My top pick is Option 1* because it ${reason}. Which would you like to explore: Option ${choices.replace(/, ([^,]+)$/, ', or $1')}?`;
}

/**
 * Envía un reply como una secuencia de mensajes cortos con typing indicator
 * y pausas proporcionales, para que la conversación se sienta humana.
 *
 * - Parte el reply por dobles saltos de línea (\n\n) y por longitud.
 * - Antes de cada chunk: muestra "escribiendo…" y espera un delay proporcional.
 * - El typing de Telegram expira a los ~5s; si un delay es mayor, lo refresca.
 */
export type RecommendationDeliveryPlan = {
  intro: string;
  options: Array<{ index: number; text: string; photoUrl?: string }>;
  outro: string;
};

export function shouldDeliverRecommendationPlan(input: {
  shouldGenerateRecommendations: boolean;
  newState: ConversationState;
  presentedUnits: AvailableUnit[];
}): boolean {
  return input.shouldGenerateRecommendations
    && input.newState === 'proposing_tour'
    && input.presentedUnits.length > 0;
}

export async function sendPhotoIfAvailable(
  messaging: MessagingAdapter,
  to: string,
  photoUrl: string | undefined,
  caption?: string,
): Promise<void> {
  if (!photoUrl || typeof messaging.sendPhoto !== 'function') return;
  try {
    await messaging.sendPhoto(to, photoUrl, caption);
  } catch {
    // A broken/missing photo must not prevent the listing text from arriving.
  }
}

export function buildRecommendationDeliveryPlan(
  units: AvailableUnit[],
  slots: Record<string, string>,
): RecommendationDeliveryPlan {
  const topUnits = units.slice(0, 3);
  const first = topUnits[0];
  if (!first) return { intro: '', options: [], outro: '' };

  const requestedArea = slots.preferred_area ? normalizeCanadianCity(slots.preferred_area) : undefined;
  const normalizedFirstCity = normalizeCanadianCity(first.city);
  const budget = parseBudget(slots.budget);
  const requestedBedroomsRaw = slots.bedrooms?.trim();
  const requestedBedrooms = Number.parseInt(requestedBedroomsRaw ?? '', 10);
  const requiresMinimumBedrooms = requestedBedroomsRaw?.endsWith('+') ?? false;
  const areaMismatch = Boolean(requestedArea && normalizedFirstCity && normalizedFirstCity !== requestedArea);
  const budgetMismatch = Boolean(budget && first.rentCents > budget);
  const bedroomMismatch = !Number.isNaN(requestedBedrooms)
    && first.bedrooms !== null
    && (requiresMinimumBedrooms ? first.bedrooms < requestedBedrooms : first.bedrooms !== requestedBedrooms);
  const isAlternative =
    slots.recommendation_kind === 'alternative'
    || areaMismatch
    || budgetMismatch
    || bedroomMismatch;
  const priceLabel = `$${(first.rentCents / 100).toLocaleString('en-CA')}/month`;
  const budgetDifference = budget ? Math.max(0, first.rentCents - budget) : 0;
  const requestedHomeLabel = Number.isNaN(requestedBedrooms)
    ? 'home'
    : `${requestedBedrooms}${requiresMinimumBedrooms ? '+' : ''}-bedroom home`;
  const petFit = slots.pets?.toLowerCase().includes('cat')
    ? ' It accepts cats.'
    : slots.pets?.toLowerCase().includes('dog')
      ? ' It accepts dogs.'
      : '';

  const options = topUnits.map((unit, index) => ({
    index: index + 1,
    text: formatRecommendationOption(unit, index),
    photoUrl: unit.photoUrl,
  }));

  if (isAlternative) {
    let intro = 'These are the closest real options I found in the current inventory.';
    if (areaMismatch && budgetMismatch) {
      intro =
        `I didn't find an exact match in ${requestedArea}. The closest available fit changes two things: ` +
        `the location is ${first.city}, and the rent is ${priceLabel} for ${first.bedrooms ?? 'a similar number of'} bedrooms` +
        (budgetDifference > 0 ? `, which is $${(budgetDifference / 100).toLocaleString('en-CA')} above your budget.` : '.') +
        petFit;
    } else if (areaMismatch) {
      intro =
        `I took another look. I didn't find a ${requestedHomeLabel} in ${requestedArea} that stays within your budget, ` +
        `but I did find one in ${first.city} for ${priceLabel}.${petFit}`;
    } else if (budgetMismatch) {
      intro =
        `I found something that matches the location and bedroom count. The closest fit is ${priceLabel} — ` +
        `$${(budgetDifference / 100).toLocaleString('en-CA')} above your budget.${petFit}`;
    } else if (bedroomMismatch) {
      intro =
        `I couldn't find exactly ${requestedBedrooms} bedrooms in ${requestedArea ?? first.city}, but I found a ` +
        `${first.bedrooms}-bedroom home there for ${priceLabel}.${petFit}`;
    }

    const outro = topUnits.length > 1
      ? `These are the closest real options in the current inventory. Which would you like to keep: ${formatOptionChoices(topUnits.length)}, or all of them?`
      : areaMismatch
        ? `Would ${first.city} work for you?`
        : budgetMismatch
          ? `Would you be comfortable stretching the budget to $${(first.rentCents / 100).toLocaleString('en-CA')}?`
          : bedroomMismatch
            ? `Would ${first.bedrooms === 1 ? '1 bedroom' : `${first.bedrooms} bedrooms`} work for you?`
            : 'Would you like to explore this one?';

    return { intro, options, outro };
  }

  const reason = buildUnitMatchReason(first, slots);
  const occupants = Number.parseInt(slots.occupants ?? '', 10);
  const selectedBedrooms = first.bedrooms;
  const spaceCaution = !Number.isNaN(occupants)
    && selectedBedrooms !== null
    && selectedBedrooms !== undefined
    && occupants > selectedBedrooms + 1
      ? ` One important tradeoff: a ${selectedBedrooms}-bedroom home may feel tight for ${occupants === 3 ? 'three' : occupants} people.`
      : '';

  return {
    intro: `Thanks for walking me through what you need. I found ${topUnits.length === 1 ? 'one option' : 'a few options'} worth a look:${spaceCaution}`,
    options,
    outro: topUnits.length === 1
      ? `This home is a strong match because it ${reason}. Would you like to explore it?`
      : `*My top pick is Option 1* because it ${reason}. Which would you like to explore: ${formatOptionChoices(topUnits.length)}?`,
  };
}

export function buildClosestAlternativeRecommendation(
  units: AvailableUnit[],
  slots: Record<string, string>,
): { units: AvailableUnit[]; reply: string } | undefined {
  const legacy = legacyBuildClosestAlternativeRecommendation(units, slots);
  if (!legacy) return undefined;
  const reply = renderRecommendationPlan(buildRecommendationDeliveryPlan(legacy.units, {
    ...slots,
    recommendation_kind: 'alternative',
  }));
  return { units: legacy.units, reply };
}

export function buildUnitRecommendationReply(units: AvailableUnit[], slots: Record<string, string>): string {
  return renderRecommendationPlan(buildRecommendationDeliveryPlan(units, {
    ...slots,
    recommendation_kind: slots.recommendation_kind ?? 'exact',
  }));
}

export async function sendWithRetry<T>(operation: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function sendHumanLike(
  to: string,
  reply: string,
  channel: string,
  messaging: MessagingAdapter,
): Promise<string[]> {
  const chunks = splitIntoChunks(reply);
  const sendTyping = typeof messaging.sendTyping === 'function' ? messaging.sendTyping.bind(messaging) : undefined;
  const messageIds: string[] = [];

  for (const chunk of chunks) {
    const delay = typingDelayFor(chunk);

    if (sendTyping) {
      await sendTyping(to);
      // Refresca el typing si el delay supera la expiración de Telegram (~5s).
      let elapsed = 0;
      while (elapsed + TYPING_REFRESH_MS < delay) {
        await sleep(TYPING_REFRESH_MS);
        elapsed += TYPING_REFRESH_MS;
        await sendTyping(to);
      }
      await sleep(delay - elapsed);
    } else {
      // Canales sin typing (SMS/WhatsApp/web): pausa simple para no ametrallar.
      await sleep(delay);
    }

    const sent = await sendWithRetry(() => messaging.send({ to, body: chunk, channel: channel as never }));
    messageIds.push(sent.messageId);
  }
  return messageIds;
}

/** Pausa visual breve que conserva un ritmo humano sin ocultar latencia real. */
export function typingDelayFor(text: string): number {
  return Math.min(MAX_TYPING_MS, MIN_TYPING_MS + text.length * MS_PER_CHAR);
}

/**
 * Parte un reply en mensajes cortos por dobles saltos de línea.
 * Cada bloque resultante respeta la sintaxis Markdown (parte por \n\n, que
 * Telegram trata como límites de párrafo seguros). Los bloques muy largos
 * se parten adicionalmente por límite de caracteres.
 */
export function splitIntoChunks(reply: string): string[] {
  const MAX_CHUNK = 320;
  const trimmed = reply.trim();
  if (!trimmed) return [];
  if (trimmed.length <= MAX_CHUNK) return [trimmed];

  const paragraphs = trimmed.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

  const chunks: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= MAX_CHUNK) {
      chunks.push(para);
      continue;
    }
    // Párrafo largo (ej. lista numerada): partir por línea manteniendo coherencia.
    const lines = para.split('\n');
    let current = '';
    for (const line of lines) {
      if ((current + '\n' + line).trim().length > MAX_CHUNK && current) {
        chunks.push(current.trim());
        current = line;
      } else {
        current = current ? `${current}\n${line}` : line;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MIN_TYPING_MS = 700;
const MS_PER_CHAR = 8;
const MAX_TYPING_MS = 1_800;
const TYPING_REFRESH_MS = 3500; // refresco del typing antes de que expire (~5s).
