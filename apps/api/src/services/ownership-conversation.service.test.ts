import { describe, expect, it } from 'vitest';
import { buildOwnershipConversationTurn } from './ownership-conversation.service.js';

type Scenario = {
  name: string;
  messages: string[];
  expected: Record<string, string>;
};

function runConversation(messages: string[]) {
  let slots: Record<string, string> = {};
  const replies: string[] = [];
  for (const message of messages) {
    const turn = buildOwnershipConversationTurn(message, slots);
    expect(turn, `No turn produced for: ${message}`).toBeDefined();
    if (!turn) continue;
    for (const key of turn.clearSlots ?? []) delete slots[key];
    slots = { ...slots, ...turn.slots };
    replies.push(turn.reply);
  }
  return { slots, replies, lastReply: replies.at(-1) ?? '' };
}

function expectedName(value: string) {
  return value.split(/\s+/).map((part) =>
    part.split(/([-'])/).map((piece) =>
      /^[-']$/.test(piece) ? piece : piece.charAt(0).toUpperCase() + piece.slice(1).toLowerCase()
    ).join('')
  ).join(' ');
}

const TEST_NAMES = new Set([
  'ana', 'marc', 'lina', 'omar', 'sara', 'luis', 'mia', 'john', 'nora', 'teo',
  'rits', 'eva', 'noah', 'iris', 'leo', 'amir', 'anne-marie', "d'arcy", 'kim',
  'raj', 'zoe', 'paul', 'ada', 'ruth', 'ian',
]);

function scenarioName(messages: string[]) {
  return expectedName(messages.find((message) => TEST_NAMES.has(message.toLowerCase())) ?? messages[1]);
}

const buyerCases = [
  ['standard condo buyer', ['b', "I don't understand", 'Ana', 'Burnaby', 'yes', 'condo', '2', '750000', 'pre-approved', 'within 3 months']],
  ['numeric intent and townhouse', ['2', 'Marc', 'Surrey BC', 'yes', 'townhouse', '3', '$900,000', 'cash', 'this fall']],
  ['purchase synonym with correction', ['purchase', 'Lina', 'Richmond', 'yep', 'actually Surrey instead', 'yes', 'detached home', '4', '1.5 million', 'not yet', 'next year']],
  ['first-time buyer with nonsense budget', ['buy', 'Omar', 'Coquitlam', 'correct', 'condo', '1', 'my budget is a potato', '600k', 'I need a pre-approval', 'as soon as possible']],
  ['open property type', ['buying', 'Sara', 'Vancouver BC', 'yes', 'open to anything', '2 bedrooms', '950000', 'already preapproved', 'six months']],
  ['duplex buyer questions financing', ['b', 'Luis', 'New West', 'yes', 'duplex', '3', '1100000', 'why do you need to know?', 'cash buyer', 'October']],
  ['studio buyer', ['buy', 'Mia', 'Victoria', 'yes', 'condo', 'studio', '450000', 'not pre-approved', 'December']],
  ['large family buyer', ['buy', 'John', 'Langley', 'yes', 'detached', '5 bedrooms', '1800000', 'pre approved', 'spring']],
  ['investment buyer', ['buy', 'Nora', 'Kelowna', 'yes', 'condo', '2', '700k', 'cash', 'this month']],
  ['abbreviated city buyer', ['b', 'Teo', 'poco', 'yes', 'townhome', '3', '850k', 'preapproved', 'November']],
  ['mixed case answers', ['BUY', 'rITS', 'surrey', 'YEP', 'CONDO', '2', '$700K', 'CASH', 'ASAP']],
  ['polite answers', ['buy', 'Eva', 'Burnaby please', 'yes', 'a townhouse please', 'three bedrooms', '$1,000,000', 'I am pre-approved', 'by January']],
  ['uncertain financing', ['buy', 'Noah', 'Delta', 'yes', 'house', '3', '1.2m', 'not sure yet', 'in 4 months']],
  ['one bedroom buyer', ['buy', 'Iris', 'North Vancouver', 'yes', 'apartment', '1 bedroom', '800000', 'pre-approved', 'September']],
  ['two city words', ['buy', 'Leo', 'Port Moody', 'yes', 'condo', '2', '775000', 'cash', 'right away']],
  ['province supplied', ['buy', 'Amir', 'Calgary Alberta', 'yes', 'detached', '3', '650000', 'preapproved', 'in 2 months']],
  ['hyphenated name', ['buy', 'Anne-Marie', 'Abbotsford', 'yes', 'townhouse', '3', '725000', 'not yet', 'March']],
  ['apostrophe name', ['buy', "D'Arcy", 'Nanaimo', 'yes', 'condo', '2', '550000', 'cash', 'summer']],
  ['maximum wording', ['buy', 'Kim', 'Burnaby', 'yes', 'condo', '2', 'maximum 800000', 'pre-approved', '90 days']],
  ['budget with commas', ['buy', 'Raj', 'Surrey', 'yes', 'townhouse', '4', '$1,250,000', 'preapproved', 'January']],
  ['yes variant', ['buy', 'Zoe', 'Richmond', "that's right", 'condo', '2', '850000', 'cash', 'November']],
  ['family home wording', ['buy', 'Paul', 'Langley', 'yes', 'single family home', '4', '1400000', 'not preapproved', 'next summer']],
  ['loft buyer', ['buy', 'Ada', 'Vancouver', 'yes', 'loft', '1', '900000', 'cash', 'now']],
  ['downsizer', ['buy', 'Ruth', 'White Rock', 'yes', 'condo', '2', '950000', 'pre-approved', 'within six months']],
  ['remote buyer', ['buy', 'Ian', 'Squamish', 'yes', 'townhouse', '3', '1000000', 'not sure', 'next spring']],
] satisfies Array<[string, string[]]>;

const sellerCases = [
  ['standard occupied condo with confusion', ['c', "I don't get it", 'Ana', '120 Main St, Burnaby BC', 'condo', '2', 'I live there', 'within 3 months', 'I want a valuation']],
  ['numeric intent vacant house', ['3', 'Marc', '44 Oak Ave, Surrey', 'detached home', '4', 'vacant', 'as soon as possible', 'ready to list']],
  ['selling synonym asks valuation early', ['selling', 'Lina', 'What is my home worth?', '8 River Rd, Richmond', 'townhouse', '3', 'owner occupied', 'this fall', 'just exploring']],
  ['tenanted seller asks legal question', ['sell', 'Omar', '22 Pine St, Vancouver', 'condo', '1', 'Can I evict my tenant before selling?', 'tenanted', 'six months', 'valuation first']],
  ['inherited property', ['sell', 'Sara', '10 Lake Dr, Kelowna', 'house', '3', 'vacant', 'not sure yet', 'it was inherited']],
  ['duplex seller', ['c', 'Luis', '77 King St, New Westminster', 'duplex', '4', 'one side is rented', 'October', 'ready to sell']],
  ['apartment seller gives unknown type first', ['sell', 'Mia', 'Unit 5, 90 Bay St, Victoria', 'a spaceship', 'apartment', '2', 'I live there', 'December', 'want to know the value']],
  ['large home seller', ['sell', 'John', '300 Farm Rd, Langley', 'detached', '5', 'owner occupied', 'spring', 'considering options']],
  ['investment property seller', ['sell', 'Nora', '601 Water St, Kelowna', 'condo', '2', 'tenant lives there', 'this month', 'ready to list']],
  ['abbreviated city seller', ['c', 'Teo', '12 Shaughnessy St, POCO', 'townhome', '3', 'vacant', 'November', 'valuation']],
  ['mixed case seller', ['SELL', 'rITS', '5 KING RD, SURREY', 'CONDO', '2', 'VACANT', 'ASAP', 'READY TO LIST']],
  ['polite seller', ['sell', 'Eva', '18 Sunset Ave, Burnaby please', 'townhouse', 'three bedrooms', 'we live there', 'by January', 'an appraisal please']],
  ['uncertain timeline', ['sell', 'Noah', '2 Beach Rd, Delta', 'house', '3', 'tenanted', 'not sure yet', 'exploring']],
  ['one bedroom seller', ['sell', 'Iris', '88 Lonsdale Ave, North Vancouver', 'apartment', '1 bedroom', 'vacant', 'September', 'ready']],
  ['port moody seller', ['sell', 'Leo', '91 Clarke St, Port Moody', 'condo', '2', 'owner occupied', 'right away', 'valuation']],
  ['alberta seller', ['sell', 'Amir', '123 4 St, Calgary Alberta', 'detached', '3', 'vacant', 'in 2 months', 'ready to list']],
  ['hyphenated seller name', ['sell', 'Anne-Marie', '6 Valley Rd, Abbotsford', 'townhouse', '3', 'tenanted', 'March', 'exploring']],
  ['apostrophe seller name', ['sell', "D'Arcy", '42 Island Hwy, Nanaimo', 'condo', '2', 'I live there', 'summer', 'valuation']],
  ['estate sale', ['sell', 'Kim', '500 Central Blvd, Burnaby', 'house', '4', 'vacant', 'within 90 days', 'estate sale']],
  ['relocation seller', ['sell', 'Raj', '700 Fraser Hwy, Surrey', 'townhouse', '4', 'owner occupied', 'January', 'relocating and ready']],
  ['yes intent word', ['sell', 'Zoe', '15 No 3 Rd, Richmond', 'condo', '2', 'tenanted', 'November', 'just exploring']],
  ['family house seller', ['sell', 'Paul', '9 Country Ln, Langley', 'single family home', '4', 'we live there', 'next summer', 'want a valuation']],
  ['loft seller', ['sell', 'Ada', '11 Main St, Vancouver', 'loft', '1', 'vacant', 'now', 'ready to list']],
  ['downsizer seller', ['sell', 'Ruth', '2 Marine Dr, White Rock', 'condo', '2', 'owner occupied', 'within six months', 'exploring']],
  ['remote seller', ['sell', 'Ian', '4 Mountain Way, Squamish', 'townhouse', '3', 'tenant occupied', 'next spring', 'valuation first']],
] satisfies Array<[string, string[]]>;

const scenarios: Scenario[] = [
  ...buyerCases.map(([name, messages]) => ({
    name: `buyer: ${name}`,
    messages: [
      ...messages,
      ...(/^(?:asap|right away|now|immediately)$/i.test(messages.at(-1) ?? '') ? ['I can make an offer as soon as I find the right home'] : []),
      'my partner and I',
      'we have a dog',
      'transit, parking and a quiet neighborhood',
      'nitro@example.com',
    ],
    expected: { transaction_intent: 'buy', prospect_name: scenarioName(messages) },
  })),
  ...sellerCases.map(([name, messages]) => ({
    name: `seller: ${name}`,
    messages,
    expected: { transaction_intent: 'sell', prospect_name: scenarioName(messages) },
  })),
];

describe('50 buy and sell conversation simulations', () => {
  it('contains at least 50 multi-turn conversations with balanced coverage', () => {
    expect(scenarios).toHaveLength(50);
    expect(buyerCases).toHaveLength(25);
    expect(sellerCases).toHaveLength(25);
    expect(scenarios.every((scenario) => scenario.messages.length >= 8)).toBe(true);
  });

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const result = runConversation(scenario.messages);
      expect(result.slots).toMatchObject(scenario.expected);
      expect(result.slots.ownership_qualification_complete).toBe('yes');
      expect(result.lastReply).toMatch(/specialist|advisor|agent/i);
      // Tarea 8: la copia ya no promete "I'll connect you" sin respaldo — ahora
      // dice honestamente que quedó "flagged" para que un humano lo retome,
      // que es justo lo que handoffReason: 'follow_up_needed' dispara de verdad.
      expect(result.replies.some((reply) => /flagged/i.test(reply))).toBe(true);
    });
  }
});

describe('unexpected ownership conversation behavior', () => {
  it('continues discovery after financing and timing instead of ending too early', () => {
    const result = runConversation([
      'buy', 'Nitro', 'Burnaby', 'yes', 'open', '3', '2 million', 'pre approved', 'asap',
    ]);
    expect(result.slots).not.toHaveProperty('ownership_qualification_complete');
    expect(result.lastReply).toMatch(/offer|deadline|quickly/i);
  });

  it('collects household, pets, priorities, and contact before a useful handoff', () => {
    const result = runConversation([
      'buy', 'Nitro', 'Burnaby', 'yes', 'open', '3', '2 million', 'pre approved', 'asap',
      'I can make an offer as soon as I find the right home',
      'my wife, our child and I', 'a cat', 'parking, SkyTrain and a yard', 'nitro@example.com',
    ]);
    expect(result.slots).toMatchObject({
      buyer_household: 'my wife, our child and I',
      buyer_pets: 'cat',
      buyer_priorities: 'parking, SkyTrain and a yard',
      contact_email: 'nitro@example.com',
      ownership_qualification_complete: 'yes',
    });
    expect(result.lastReply).toContain('Burnaby');
    expect(result.lastReply).toContain('3-bedroom');
    expect(result.lastReply).toContain('$2,000,000');
    expect(result.lastReply).not.toMatch(/invent|brief a purchase specialist/i);
    expect(result.lastReply).toMatch(/contact|advisor|specialist/i);
  });

  it('marca handoffReason follow_up_needed cuando la calificación de compra queda completa', () => {
    // Tarea 8: este era uno de los cinco lugares que le prometían un humano
    // al lead sin avisar a nadie — buildDeterministicQualificationTurn/
    // handleInboundMessageUnlocked recogen este campo y disparan triggerHandoff.
    const turn = buildOwnershipConversationTurn('nitro@example.com', {
      transaction_intent: 'buy', prospect_name: 'Nitro', preferred_area: 'Burnaby',
      preferred_province: 'British Columbia', location_confirmed: 'yes',
      buyer_property_type: 'any', bedrooms: '3', purchase_budget: '850000',
      financing_status: 'pre_approved', purchase_timeline: 'flexible',
      buyer_household: 'just me', buyer_pets: 'none', buyer_priorities: 'schools',
    });
    expect(turn?.next_state).toBe('handoff');
    expect(turn?.handoffReason).toBe('follow_up_needed');

    // La rama "ya está completo" (re-preguntado tras el handoff) también avisa.
    const alreadyComplete = buildOwnershipConversationTurn('anything else?', {
      transaction_intent: 'buy', prospect_name: 'Nitro', preferred_area: 'Burnaby',
      preferred_province: 'British Columbia', location_confirmed: 'yes',
      buyer_property_type: 'any', bedrooms: '3', purchase_budget: '850000',
      financing_status: 'pre_approved', purchase_timeline: 'flexible',
      buyer_household: 'just me', buyer_pets: 'none', buyer_priorities: 'schools',
      contact_email: 'nitro@example.com', ownership_qualification_complete: 'yes',
    });
    expect(alreadyComplete?.next_state).toBe('handoff');
    expect(alreadyComplete?.handoffReason).toBe('follow_up_needed');
  });

  it('marca handoffReason follow_up_needed cuando la calificación de venta queda completa', () => {
    const turn = buildOwnershipConversationTurn('just exploring for now', {
      transaction_intent: 'sell', prospect_name: 'Ana',
      seller_property_address: '4 Mountain Way, Squamish',
      seller_property_type: 'townhouse', seller_bedrooms: '3',
      occupancy_status: 'vacant', selling_timeline: 'next spring',
    });
    expect(turn?.next_state).toBe('handoff');
    expect(turn?.handoffReason).toBe('follow_up_needed');
  });

  it('treats a stated amount as a working budget rather than silently declaring a ceiling', () => {
    const turn = buildOwnershipConversationTurn('2 million', {
      transaction_intent: 'buy', prospect_name: 'Nitro', preferred_area: 'Burnaby',
      preferred_province: 'British Columbia', location_confirmed: 'yes',
      buyer_property_type: 'any', bedrooms: '3',
    });
    expect(turn?.reply).toMatch(/working budget|target|maximum/i);
    expect(turn?.reply).not.toMatch(/as the ceiling/i);
  });

  it('explains a name question instead of storing confusion as a name', () => {
    const result = runConversation(['buy', "I don't understand"]);
    expect(result.slots).not.toHaveProperty('prospect_name');
    expect(result.lastReply).toMatch(/first name|call you/i);
  });

  it('does not invent a valuation when a seller asks what the home is worth', () => {
    const result = runConversation(['sell', 'Ana', 'What is my home worth?']);
    expect(result.lastReply).toMatch(/address|valuation|market analysis/i);
    expect(result.lastReply).not.toMatch(/\$[\d,]+/);
  });

  it('answers why financing status matters and resumes qualification', () => {
    const existing = {
      transaction_intent: 'buy',
      prospect_name: 'Ana',
      preferred_area: 'Burnaby',
      preferred_province: 'British Columbia',
      location_confirmed: 'yes',
      buyer_property_type: 'condo',
      bedrooms: '2',
      purchase_budget: '750000',
    };
    const turn = buildOwnershipConversationTurn('Why do you need to know?', existing);
    expect(turn?.reply).toMatch(/financing|pre-approv|appropriate next step/i);
    expect(turn?.slots).not.toHaveProperty('financing_status');
  });

  it('accepts a correction without preserving the contradictory location', () => {
    const turn = buildOwnershipConversationTurn('Actually, make that Surrey instead', {
      transaction_intent: 'buy',
      prospect_name: 'Ana',
      preferred_area: 'Burnaby',
      preferred_province: 'British Columbia',
      location_confirmed: 'yes',
    });
    expect(turn?.slots).toMatchObject({ pending_area: 'Surrey', location_confirmation: 'pending' });
    expect(turn?.reply).toMatch(/Surrey, British Columbia/i);
  });

  it('does not treat nonsense as a purchase budget', () => {
    const turn = buildOwnershipConversationTurn('my budget is a potato', {
      transaction_intent: 'buy',
      prospect_name: 'Ana',
      preferred_area: 'Burnaby',
      preferred_province: 'British Columbia',
      location_confirmed: 'yes',
      buyer_property_type: 'condo',
      bedrooms: '2',
    });
    expect(turn?.slots).not.toHaveProperty('purchase_budget');
    expect(turn?.reply).toMatch(/budget|range/i);
  });

  it('handles a buyer switching to selling without carrying buyer qualification forward', () => {
    const turn = buildOwnershipConversationTurn('Actually I need to sell instead', {
      transaction_intent: 'buy',
      prospect_name: 'Ana',
      preferred_area: 'Burnaby',
      purchase_budget: '750000',
    });
    expect(turn?.slots).toMatchObject({ transaction_intent: 'sell' });
    expect(turn?.clearSlots).toContain('purchase_budget');
    expect(turn?.reply).toMatch(/sell/i);
  });

  it('responds safely to a legal question and continues the seller flow', () => {
    const turn = buildOwnershipConversationTurn('Can I evict my tenant before selling?', {
      transaction_intent: 'sell',
      prospect_name: 'Ana',
      seller_property_address: '22 Pine St, Vancouver',
      seller_property_type: 'condo',
      seller_bedrooms: '1',
    });
    expect(turn?.reply).toMatch(/legal advice|licensed|professional/i);
    expect(turn?.reply).toMatch(/occup|tenant|vacant/i);
  });
});
