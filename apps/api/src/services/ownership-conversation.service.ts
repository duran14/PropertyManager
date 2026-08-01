import type { ConversationState } from './chatbot.service.js';

export type OwnershipConversationTurn = {
  reply: string;
  slots: Record<string, string>;
  next_state: ConversationState;
  clearSlots?: string[];
};

const PROVINCES: Record<string, string> = {
  bc: 'British Columbia',
  'british columbia': 'British Columbia',
  ab: 'Alberta',
  alberta: 'Alberta',
};

const CITY_ALIASES: Record<string, string> = {
  poco: 'Port Coquitlam',
  'port coquitlam': 'Port Coquitlam',
  'new west': 'New Westminster',
  'new westminster': 'New Westminster',
};

const BUYER_KEYS = [
  'preferred_area', 'preferred_province', 'pending_area', 'pending_province',
  'location_confirmation', 'buyer_property_type', 'bedrooms',
  'purchase_budget', 'financing_status', 'purchase_timeline', 'buyer_urgency',
  'buyer_household', 'buyer_pets', 'buyer_priorities', 'contact_email', 'contact_phone',
];
const SELLER_KEYS = [
  'seller_property_address', 'seller_property_type', 'seller_bedrooms',
  'occupancy_status', 'selling_timeline', 'seller_goal',
];

function normalize(message: string) {
  return message.trim().toLowerCase().replace(/[.!?]+$/g, '');
}

function titleCase(value: string) {
  return value.trim().split(/\s+/).map((part) =>
    part.split(/([-'])/).map((piece) =>
      /^[-']$/.test(piece) ? piece : piece.charAt(0).toUpperCase() + piece.slice(1).toLowerCase()
    ).join('')
  ).join(' ');
}

function parseIntent(message: string, allowMenuOptions: boolean): 'buy' | 'sell' | undefined {
  const value = normalize(message);
  if ((allowMenuOptions && /^(b|2)$/.test(value)) || /^(?:buy|buying|purchase)$/.test(value) || /\b(?:buy|purchase)\b/.test(value)) return 'buy';
  if ((allowMenuOptions && /^(c|3)$/.test(value)) || /^(?:sell|selling)$/.test(value) || /\b(?:sell|selling)\b/.test(value)) return 'sell';
  return undefined;
}

function isConfusion(message: string) {
  return /\b(?:don'?t understand|don'?t get|what do you mean|confused|why do you need|why are you asking)\b/i.test(message);
}

function parseName(message: string) {
  const candidate = message.replace(/^(?:my name is|i am|i'm|call me)\s+/i, '').trim();
  if (isConfusion(message) || !/^[\p{L}][\p{L}' -]{0,49}$/u.test(candidate)) return undefined;
  const blocked = /^(?:yes|no|maybe|thanks|hello|hi|help|buy|sell)$/i;
  return blocked.test(candidate) ? undefined : titleCase(candidate);
}

function parseLocation(message: string) {
  let cleaned = message.trim()
    .replace(/^(?:in|around|near)\s+/i, '')
    .replace(/\s+please$/i, '')
    .replace(/[,.]+$/g, '')
    .trim();
  if (!cleaned || /\d/.test(cleaned)) return undefined;
  const provinceMatch = cleaned.match(/\s+(BC|British Columbia|AB|Alberta)$/i);
  const province = provinceMatch ? PROVINCES[provinceMatch[1].toLowerCase()] : 'British Columbia';
  if (provinceMatch) cleaned = cleaned.slice(0, provinceMatch.index).trim();
  const area = CITY_ALIASES[cleaned.toLowerCase()] ?? titleCase(cleaned);
  return { area, province };
}

function parsePropertyType(message: string) {
  const value = normalize(message).replace(/\s+please$/, '');
  if (/\b(?:open|anything|any type)\b/.test(value)) return 'any';
  if (/\b(?:condo|apartment)\b/.test(value)) return 'condo';
  if (/\b(?:townhouse|townhome)\b/.test(value)) return 'townhouse';
  if (/\bduplex\b/.test(value)) return 'duplex';
  if (/\b(?:detached|single family|house|family home)\b/.test(value)) return 'detached';
  if (/\bloft\b/.test(value)) return 'loft';
  return undefined;
}

function parseBedrooms(message: string) {
  const value = normalize(message);
  if (/\bstudio\b/.test(value)) return '0';
  const match = value.match(/\b(\d{1,2}|one|two|three|four|five)\b/);
  if (!match) return undefined;
  return ({ one: '1', two: '2', three: '3', four: '4', five: '5' } as Record<string, string>)[match[1]] ?? match[1];
}

function parseMoney(message: string) {
  const value = normalize(message).replace(/,/g, '');
  const match = value.match(/(?:\$?\s*)(\d+(?:\.\d+)?)\s*(million|m|k)?\b/);
  if (!match) return undefined;
  let amount = Number(match[1]);
  if (match[2] === 'million' || match[2] === 'm') amount *= 1_000_000;
  if (match[2] === 'k') amount *= 1_000;
  if (amount < 50_000 || amount > 100_000_000) return undefined;
  return String(Math.round(amount));
}

function parseFinancing(message: string) {
  const value = normalize(message);
  if (/\bcash(?: buyer)?\b/.test(value)) return 'cash';
  if (/\b(?:not sure|unsure)\b/.test(value)) return 'unsure';
  if (/\b(?:not pre[\s-]?approved|need (?:a )?pre[\s-]?approval|not yet)\b/.test(value)) return 'not_preapproved';
  if (/\b(?:pre[\s-]?approved|already preapproved)\b/.test(value)) return 'preapproved';
  return undefined;
}

function parseOccupancy(message: string) {
  const value = normalize(message);
  if (/\b(?:tenant(?:ed| occupied| lives there)?|rented)\b/.test(value)) return 'tenanted';
  if (/\bvacant\b/.test(value)) return 'vacant';
  if (/\b(?:i live|we live|owner occupied)\b/.test(value)) return 'owner_occupied';
  return undefined;
}

function parseSellerGoal(message: string) {
  const value = normalize(message);
  if (/\b(?:ready|list|relocat)\b/.test(value)) return 'ready_to_list';
  if (/\b(?:value|valuation|appraisal)\b/.test(value)) return 'valuation';
  if (/\b(?:explor|consider|inherit|estate)\b/.test(value)) return 'exploring';
  return undefined;
}

function parseBuyerPets(message: string) {
  const value = normalize(message);
  if (/\b(?:no pets?|none|pet[- ]?free)\b/.test(value)) return 'none';
  if (/\bcats?\b/.test(value)) return 'cat';
  if (/\bdogs?\b/.test(value)) return 'dog';
  return value.length > 1 ? message.trim() : undefined;
}

function parseContact(message: string): Record<string, string> | undefined {
  const email = message.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0];
  if (email) return { contact_email: email.toLowerCase() };
  const phone = message.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/)?.[0];
  if (phone) return { contact_phone: phone.trim() };
  return undefined;
}

function isAffirmative(message: string) {
  return /^(?:yes|y|yeah|yep|correct|that'?s right)$/i.test(normalize(message));
}

function buyerTurn(message: string, slots: Record<string, string>): OwnershipConversationTurn {
  if (!slots.prospect_name) {
    const name = parseName(message);
    return name
      ? {
          reply: `It's a pleasure to meet you, ${name}. I'll help you organize the purchase search. Which city or area are you considering?`,
          slots: { prospect_name: name },
          next_state: 'collecting_budget',
        }
      : {
          reply: "Of course — I'm simply asking for your first name, or the name you'd like me to call you.",
          slots: {},
          next_state: 'collecting_budget',
        };
  }

  const correction = message.match(/\b(?:actually|instead|change (?:it )?to|make that)\b[\s,:-]*(?:make that\s+)?(.+?)(?:\s+instead)?$/i);
  if (correction && slots.preferred_area) {
    const location = parseLocation(correction[1]);
    if (location) {
      return {
        reply: `Thanks for correcting that. Just to confirm, do you mean ${location.area}, ${location.province}?`,
        slots: { pending_area: location.area, pending_province: location.province, location_confirmation: 'pending' },
        clearSlots: ['preferred_area', 'preferred_province', 'location_confirmed'],
        next_state: 'collecting_budget',
      };
    }
  }

  if (!slots.preferred_area && slots.location_confirmation === 'pending') {
    if (isAffirmative(message)) {
      return {
        reply: `Perfect — ${slots.pending_area}, ${slots.pending_province}. What type of property would suit you best: condo, townhouse, detached home, or are you open?`,
        slots: {
          preferred_area: slots.pending_area,
          preferred_province: slots.pending_province,
          location_confirmed: 'yes',
        },
        next_state: 'collecting_movein',
      };
    }
    return {
      reply: `I want to make sure I have the right market. Which city and province did you mean?`,
      slots: {},
      next_state: 'collecting_budget',
    };
  }

  if (!slots.preferred_area) {
    const location = parseLocation(message);
    return location
      ? {
          reply: `Just to confirm, do you mean ${location.area}, ${location.province}?`,
          slots: { pending_area: location.area, pending_province: location.province, location_confirmation: 'pending' },
          next_state: 'collecting_budget',
        }
      : { reply: 'Which city and province would you like me to focus on?', slots: {}, next_state: 'collecting_budget' };
  }

  if (!slots.buyer_property_type) {
    const type = parsePropertyType(message);
    return type
      ? {
          reply: `That gives me a clearer picture. How many bedrooms do you need?`,
          slots: { buyer_property_type: type },
          next_state: 'collecting_movein',
        }
      : {
          reply: 'What kind of home are you considering — a condo, townhouse, detached home, or something else?',
          slots: {},
          next_state: 'collecting_movein',
        };
  }
  if (!slots.bedrooms) {
    const bedrooms = parseBedrooms(message);
    return bedrooms
      ? {
          reply: `Understood. What purchase budget or comfortable price range should I work with?`,
          slots: { bedrooms },
          next_state: 'collecting_budget',
        }
      : { reply: 'How many bedrooms would feel right for you?', slots: {}, next_state: 'collecting_movein' };
  }
  if (!slots.purchase_budget) {
    const purchaseBudget = parseMoney(message);
    return purchaseBudget
      ? {
          reply: `Thanks — I'll treat $${Number(purchaseBudget).toLocaleString('en-CA')} as your working budget for now. Are you pre-approved, buying with cash, or still exploring financing?`,
          slots: { purchase_budget: purchaseBudget },
          next_state: 'collecting_budget',
        }
      : {
          reply: 'No problem — what approximate purchase budget or price range would be comfortable?',
          slots: {},
          next_state: 'collecting_budget',
        };
  }
  if (!slots.financing_status) {
    if (isConfusion(message)) {
      return {
        reply: 'Financing status helps the advisor recommend the appropriate next step and avoid wasting your time. Are you pre-approved, paying cash, or still exploring?',
        slots: {},
        next_state: 'collecting_budget',
      };
    }
    const financingStatus = parseFinancing(message);
    return financingStatus
      ? {
          reply: 'Thanks, that helps us plan realistically. When would you ideally like to buy or move?',
          slots: { financing_status: financingStatus },
          next_state: 'collecting_movein',
        }
      : {
          reply: 'Are you already pre-approved, planning a cash purchase, or still exploring financing?',
          slots: {},
          next_state: 'collecting_budget',
        };
  }
  if (!slots.purchase_timeline) {
    const timeline = message.trim();
    return {
      reply: /^(?:asap|right away|immediately|now)$/i.test(normalize(timeline))
        ? `Understood — you're ready to move quickly. Are you prepared to make an offer as soon as the right home appears, or do you have a firm move-in deadline?`
        : `That timing helps. Who would be living in the home with you?`,
      slots: { purchase_timeline: timeline },
      next_state: 'collecting_movein',
    };
  }
  if (/^(?:asap|right away|immediately|now)$/i.test(normalize(slots.purchase_timeline)) && !slots.buyer_urgency) {
    return {
      reply: 'Thanks — that clarifies the urgency. Who would be living in the home with you?',
      slots: { buyer_urgency: message.trim() },
      next_state: 'collecting_movein',
    };
  }
  if (!slots.buyer_household) {
    return {
      reply: 'Good to know. Will any pets be moving with you?',
      slots: { buyer_household: message.trim() },
      next_state: 'collecting_movein',
    };
  }
  if (!slots.buyer_pets) {
    const pets = parseBuyerPets(message);
    return {
      reply: 'Thanks. What matters most in the home or neighborhood — for example transit, parking, schools, outdoor space, accessibility, or newer finishes?',
      slots: pets ? { buyer_pets: pets } : {},
      next_state: 'collecting_movein',
    };
  }
  if (!slots.buyer_priorities) {
    return {
      reply: 'That gives me a much better search profile. What email address or phone number should the purchase advisor use to contact you?',
      slots: { buyer_priorities: message.trim() },
      next_state: 'collecting_movein',
    };
  }
  if (!slots.contact_email && !slots.contact_phone) {
    const contact = parseContact(message);
    if (!contact) {
      return {
        reply: 'What email address or phone number would you like the purchase advisor to use?',
        slots: {},
        next_state: 'collecting_movein',
      };
    }
    const propertyLabel = slots.buyer_property_type === 'any' ? 'flexible property type' : slots.buyer_property_type;
    const petLabel = slots.buyer_pets === 'none' ? 'no pets' : `${slots.buyer_pets} needs`;
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
}

function sellerTurn(message: string, slots: Record<string, string>): OwnershipConversationTurn {
  if (!slots.prospect_name) {
    const name = parseName(message);
    return name
      ? {
          reply: `It's a pleasure to meet you, ${name}. I'll help you prepare the sale conversation. What is the property's address?`,
          slots: { prospect_name: name },
          next_state: 'collecting_budget',
        }
      : {
          reply: "Of course — I'm asking for your first name, or the name you'd like me to call you.",
          slots: {},
          next_state: 'collecting_budget',
        };
  }
  if (!slots.seller_property_address) {
    if (/\bwhat(?:'s| is) (?:my|the) (?:home|house|property) worth\b/i.test(message)) {
      return {
        reply: `A reliable valuation needs the property address and a current market analysis; I don't want to invent a number. What is the address?`,
        slots: {},
        next_state: 'collecting_budget',
      };
    }
    const address = message.trim();
    if (!/\d/.test(address)) {
      return { reply: "What is the property's street address and city?", slots: {}, next_state: 'collecting_budget' };
    }
    return {
      reply: 'Thank you. What type of property is it — condo, townhouse, detached home, or something else?',
      slots: { seller_property_address: address },
      next_state: 'collecting_movein',
    };
  }
  if (!slots.seller_property_type) {
    const type = parsePropertyType(message);
    return type
      ? {
          reply: 'Got it. How many bedrooms does the property have?',
          slots: { seller_property_type: type },
          next_state: 'collecting_movein',
        }
      : { reply: 'What type of property is it?', slots: {}, next_state: 'collecting_movein' };
  }
  if (!slots.seller_bedrooms) {
    const bedrooms = parseBedrooms(message);
    return bedrooms
      ? {
          reply: 'Thanks. Is the property owner-occupied, tenanted, or vacant?',
          slots: { seller_bedrooms: bedrooms },
          next_state: 'collecting_movein',
        }
      : { reply: 'How many bedrooms does it have?', slots: {}, next_state: 'collecting_movein' };
  }
  if (!slots.occupancy_status) {
    if (/\b(?:evict|tenant rights?|notice to tenant)\b/i.test(message)) {
      return {
        reply: `I can't give legal advice about a tenancy; a licensed professional should review the circumstances. For the sale brief, is the property currently occupied by a tenant, owner-occupied, or vacant?`,
        slots: {},
        next_state: 'collecting_movein',
      };
    }
    const occupancyStatus = parseOccupancy(message);
    return occupancyStatus
      ? {
          reply: 'That context is important. When are you hoping to sell?',
          slots: { occupancy_status: occupancyStatus },
          next_state: 'collecting_movein',
        }
      : {
          reply: 'Is the property currently owner-occupied, tenanted, or vacant?',
          slots: {},
          next_state: 'collecting_movein',
        };
  }
  if (!slots.selling_timeline) {
    return {
      reply: 'Thanks. Are you ready to list, looking for a valuation first, or just exploring your options?',
      slots: { selling_timeline: message.trim() },
      next_state: 'collecting_movein',
    };
  }
  if (!slots.seller_goal) {
    const sellerGoal = parseSellerGoal(message) ?? 'exploring';
    return {
      reply: `Thank you — I have enough context to make the conversation useful. I'll connect you with a selling specialist for a proper market analysis and next steps.`,
      slots: { seller_goal: sellerGoal, ownership_qualification_complete: 'yes' },
      next_state: 'handoff',
    };
  }
  return {
    reply: `Your sale brief is already complete. I'll connect you with the selling specialist for the next step.`,
    slots: {},
    next_state: 'handoff',
  };
}

export function buildOwnershipConversationTurn(
  message: string,
  existingSlots: Record<string, string>,
): OwnershipConversationTurn | undefined {
  const currentIntent = existingSlots.transaction_intent;
  const detectedIntent = parseIntent(message, !currentIntent);

  if (detectedIntent && currentIntent && detectedIntent !== currentIntent) {
    const clearSlots = detectedIntent === 'buy' ? SELLER_KEYS : BUYER_KEYS;
    return {
      reply: detectedIntent === 'buy'
        ? "Understood — we'll switch to buying. Before we continue, may I ask your first name?"
        : "Understood — we'll focus on selling instead. What is the property's address?",
      slots: { transaction_intent: detectedIntent },
      clearSlots,
      next_state: 'collecting_budget',
    };
  }

  const intent = detectedIntent ?? (currentIntent === 'buy' || currentIntent === 'sell' ? currentIntent : undefined);
  if (!intent) return undefined;

  if (!currentIntent) {
    return {
      reply: intent === 'buy'
        ? "Absolutely — I'll help you prepare a focused home search. May I ask your first name?"
        : "Absolutely — I'll help you prepare the property sale. May I ask your first name?",
      slots: { transaction_intent: intent },
      next_state: 'collecting_budget',
    };
  }

  return intent === 'buy' ? buyerTurn(message, existingSlots) : sellerTurn(message, existingSlots);
}
