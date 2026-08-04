import { describe, expect, it } from 'vitest';
import {
  alignInterpretedSlotsWithExpectedField,
  buildConversationRepairTurn,
  buildDeterministicQualificationTurn,
  buildQualificationGuardReply,
  extractContextualConversationSlots,
  validateInterpretedLocation,
  type InterpretedTurn,
} from './chatbot.service.js';

/**
 * IMPORTANT — scope of this file after the model-first restoration:
 *
 * `runTranscript` below drives ONLY the deterministic layer
 * (extractContextualConversationSlots, buildDeterministicQualificationTurn,
 * buildConversationRepairTurn, alignInterpretedSlotsWithExpectedField,
 * validateInterpretedLocation) — it never calls interpretRentalTurn,
 * interpretOwnershipTurn, or any GlmAdapter. It also does not apply the
 * three ownership-domain gates that handleInboundMessageUnlocked applies
 * (see `isOwnershipConversation` in chatbot.service.ts):
 *   - extractContextualConversationSlots runs unconditionally here, but in
 *     production it's skipped entirely for buy/sell (it corrupts ownership
 *     data — e.g. a $850,000 purchase budget landing as "50000" under the
 *     wrong key "budget" instead of "purchase_budget").
 *   - buildConversationRepairTurn runs here whenever `deterministic` is
 *     undefined, but in production it's skipped entirely for buy/sell too.
 *   - validateInterpretedLocation runs unconditionally here and in
 *     production alike for rent, but is skipped for buy/sell in production.
 * None of these three gates are applied by this harness for any category,
 * which is exactly why it no longer represents the buy/sell production path.
 *
 * For `rent`-category scenarios this is still an accurate simulation:
 * buildFastQualificationTurn/buildDeterministicQualificationTurn remain the
 * PRIMARY path for short, unambiguous rental answers even after the
 * restoration (Task 5 kept that fast path deliberately) — the model only
 * takes over for messages these builders decline to answer.
 *
 * For `buy`/`sell`-category scenarios, this harness now exercises the
 * DETERMINISTIC FALLBACK ONLY — the path `buildOwnershipConversationTurn`
 * takes when the real GLM provider is unreachable (see
 * chatbot.routing.test.ts for coverage of the model-as-primary path these
 * scenarios no longer represent). That fallback path still needs to work
 * correctly, so these 50 buy/sell transcripts remain valuable — just not as
 * "what a buyer/seller conversation looks like in production" coverage.
 */

type TranscriptCategory = 'rent' | 'buy' | 'sell';
type TranscriptStyle = 'expected' | 'unexpected';

type TranscriptScenario = {
  name: string;
  category: TranscriptCategory;
  style: TranscriptStyle;
  messages: string[];
  expectedSlots: Record<string, string>;
  replyPattern: RegExp;
};

function titleCaseName(value: string) {
  return value.split(/\s+/).map((part) =>
    part.split(/([-'])/).map((piece) =>
      /^[-']$/.test(piece) ? piece : piece.charAt(0).toUpperCase() + piece.slice(1).toLowerCase()
    ).join('')
  ).join(' ');
}

function runTranscript(messages: string[]) {
  let slots: Record<string, string> = {};
  const replies: string[] = [];

  for (const message of messages) {
    const contextual = extractContextualConversationSlots(message, slots);
    const deterministic = buildDeterministicQualificationTurn(message, slots);
    const repair = deterministic ? undefined : buildConversationRepairTurn(message, slots);
    const synthetic: InterpretedTurn | undefined = !deterministic && !repair && Object.keys(contextual).length > 0
      ? { reply: '', slots: {}, next_state: 'collecting_movein' as const }
      : undefined;
    const turn: InterpretedTurn | undefined = deterministic ?? repair ?? synthetic;

    expect(turn, `No turn produced for: ${message}`).toBeDefined();
    if (!turn) continue;

    for (const key of turn.clearSlots ?? []) delete slots[key];

    let interpreted: InterpretedTurn = {
      ...turn,
      slots: {
        ...contextual,
        ...(turn.slots ?? {}),
      },
    };

    interpreted = alignInterpretedSlotsWithExpectedField(interpreted, message, slots);
    interpreted = validateInterpretedLocation(interpreted, slots);

    const effectiveSlots = { ...slots, ...(interpreted.slots ?? {}) };
    const isRentalQualification =
      effectiveSlots.transaction_intent === 'rent'
      && !/^\/(start|begin|reset)(\b|$)/i.test(message.trim())
      && interpreted.next_state !== 'handoff'
      && interpreted.next_state !== 'scheduling';

    const qualificationQuestion = isRentalQualification
      ? buildQualificationGuardReply(effectiveSlots, interpreted.slots ?? {})
      : undefined;

    const finalReply = qualificationQuestion && interpreted.intent !== 'ask_clarification'
      ? qualificationQuestion
      : interpreted.reply || qualificationQuestion || '';

    replies.push(finalReply);
    slots = effectiveSlots;
  }

  return { slots, replies, lastReply: replies.at(-1) ?? '' };
}

type RentalSeed = {
  label: string;
  style: TranscriptStyle;
  intentInput: string;
  preName?: string[];
  nameInput: string;
  expectedName: string;
  cityInput: string;
  expectedArea: string;
  confirmInput: string;
  bedroomsInput: string;
  expectedBedrooms: string;
  petsInput: string;
  expectedPets: string;
  budgetInput: string;
  expectedBudget: string;
  timingInput: string;
  expectedTiming: string;
};

function rentalScenario(seed: RentalSeed): TranscriptScenario {
  return {
    name: `rent ${seed.style}: ${seed.label}`,
    category: 'rent',
    style: seed.style,
    messages: [
      '/start',
      seed.intentInput,
      ...(seed.preName ?? []),
      seed.nameInput,
      seed.cityInput,
      seed.confirmInput,
      seed.bedroomsInput,
      seed.petsInput,
      seed.budgetInput,
      seed.timingInput,
    ],
    expectedSlots: {
      transaction_intent: 'rent',
      prospect_name: seed.expectedName,
      preferred_area: seed.expectedArea,
      bedrooms: seed.expectedBedrooms,
      pets: seed.expectedPets,
      budget: seed.expectedBudget,
      move_in_date: seed.expectedTiming,
    },
    replyPattern: /best available matches/i,
  };
}

const rentalExpectedSeedData: Array<[string, string, string, string, string, string, string, string, string, string, string, string]> = [
  ['burnaby cat asap', 'Jane', 'Burnaby', 'yes', '2', '2', 'cat', 'cat', '2600', '2600', 'asap', 'As soon as possible'],
  ['surrey no pets september', 'Lila', 'Surrey', 'yep', '3', '3', 'no', 'none', '$3200', '3200', 'sep', 'September'],
  ['new west dog october', 'Silvia', 'New west', 'yes', 'two bedrooms', '2', 'dog', 'dog', '2800', '2800', 'oct', 'October'],
  ['poco cat right away', 'Nancy', 'POCO', 'correct', 'c', '2', 'b', 'cat', '$2500', '2500', 'right away', 'As soon as possible'],
  ['langley studio november', 'Rits', 'Langley', 'yes', 'studio', '0', 'none', 'none', '1900', '1900', 'nov', 'November'],
  ['richmond dog october 2026', 'Laura', 'Richmond', 'yes', '3 bedrooms', '3', 'dogs', 'dog', '$3400', '3400', 'october 2026', 'October 2026'],
  ['delta cat april', 'Mike', 'Delta', 'yeah', '1 bedroom', '1', 'cats', 'cat', '2200', '2200', 'april', 'April'],
  ['coquitlam no pets june', 'Sofia', 'Coquitlam', "that's right", '1', '1', 'a', 'none', '$2100', '2100', 'june', 'June'],
  ['north van dog july', 'Carlos', 'North Vancouver', 'yes', 'd', '3', 'c', 'dog', '3600', '3600', 'july', 'July'],
  ['west van cat august', 'Mia', 'West Vancouver', 'y', '2', '2', 'cat', 'cat', '$3100', '3100', 'aug', 'August'],
  ['vancouver no pets december', 'Eva', 'Vancouver', 'yes', '1', '1', 'no pets', 'none', '$2300', '2300', 'dec', 'December'],
  ['port moody dog march', 'Noah', 'Port Moody', 'yes', '3', '3', 'dog', 'dog', '2950', '2950', 'march', 'March'],
  ['white rock cat january', 'Amir', 'White Rock', 'yes', '2', '2', 'cat', 'cat', '$2700', '2700', 'january', 'January'],
  ['kelowna none may', 'Anne-Marie', 'Kelowna', 'correct', '1', '1', 'none', 'none', '2000', '2000', 'may', 'May'],
  ['abbotsford dog february', "D'Arcy", 'Abbotsford', 'yes', '3', '3', 'dog', 'dog', '$2400', '2400', 'february', 'February'],
  ['victoria cat september 2026', 'Ruth', 'Victoria', 'yes', '2 bedrooms', '2', 'cat', 'cat', '2600', '2600', 'september 2026', 'September 2026'],
  ['nanaimo no pets october', 'Ian', 'Nanaimo', 'yep', '1 bedroom', '1', 'no', 'none', '$1800', '1800', 'october', 'October'],
  ['calgary dog asap', 'Kim', 'Calgary Alberta', 'yes', '3', '3', 'dog', 'dog', '2300', '2300', 'immediately', 'As soon as possible'],
  ['surrey cat november', 'Raj', 'Surrey', 'yes', '2', '2', 'cat', 'cat', '$2550', '2550', 'november', 'November'],
  ['burnaby no pets march', 'Zoe', 'Burnaby', 'right', '1', '1', 'none', 'none', '2150', '2150', 'march', 'March'],
  ['langley dog september', 'Paul', 'Langley', 'yes', '3', '3', 'dog', 'dog', '$3000', '3000', 'september', 'September'],
  ['richmond cat december', 'Ada', 'Richmond', 'yes', '2', '2', 'cat', 'cat', '$2950', '2950', 'december', 'December'],
  ['surrey none april', 'Leo', 'Surrey', 'correct', '1', '1', 'none', 'none', '2050', '2050', 'april', 'April'],
  ['vancouver dog january', 'Omar', 'Vancouver', 'yes', '3', '3', 'dog', 'dog', '$3800', '3800', 'january', 'January'],
  ['new west cat may', 'Sara', 'New Westminster', 'yes', '2', '2', 'cat', 'cat', '2750', '2750', 'may', 'May'],
];

const rentalExpectedSeeds: RentalSeed[] = rentalExpectedSeedData.map(([label, name, city, confirm, bedroomsInput, expectedBedrooms, petsInput, expectedPets, budgetInput, expectedBudget, timingInput, expectedTiming]) =>
  ({
    label,
    style: 'expected',
    intentInput: 'a',
    nameInput: name,
    expectedName: titleCaseName(name),
    cityInput: city,
    expectedArea: city === 'New west' ? 'New Westminster' : city === 'POCO' ? 'Port Coquitlam' : city === 'Calgary Alberta' ? 'Calgary' : city,
    confirmInput: confirm,
    bedroomsInput,
    expectedBedrooms,
    petsInput,
    expectedPets,
    budgetInput,
    expectedBudget,
    timingInput,
    expectedTiming,
  }));

const rentalUnexpectedSeedData: Array<[string, string[], string, string, string, string, string, string, string]> = [
  ['confusion then recovers', ['a', "I don't get that"], 'Silvia', 'new west', 'yes', '3', 'dog', '3000', 'oct'],
  ['call me with poco alias', ['rent'], 'call me Nancy', 'POCO', 'yes', 'two bedrooms', 'we have a cat', '$2500', 'right away'],
  ['lease with uppercase city', ['lease'], 'MARIO', 'SURREY', 'yep', 'c', 'a dog', 'my budget is 2600', 'sep'],
  ['name phrase and no pets sentence', ['a'], "I'm Laura", 'Burnaby', 'correct', '1 bedroom', 'pet-free', '$2200', 'october 2026'],
  ['confusion plus yes-no city', ['rent', 'what do you mean'], 'Mia', 'Langley', 'yes', '3 bedrooms', 'dogs', '$3100', 'asap'],
  ['metro style area alias', ['a'], 'Noah', 'new west', 'yes', '2 bedrooms', 'we have a cat', 'around 2800', 'nov'],
  ['apostrophe name with cat sentence', ['rent'], "D'Arcy", 'Richmond', 'yes', '2', 'a cat', '$2950', 'dec'],
  ['hyphen name with dog sentence', ['a'], 'Anne-Marie', 'Port Moody', 'yes', '3', 'we have a dog', '3000', 'january'],
  ['call me plus none', ['lease'], 'call me Zoe', 'Vancouver', 'yes', '1', 'no pets at all', '2300', 'march'],
  ['all lowercase and immediate move', ['a'], 'mike', 'delta', 'yes', 'studio', 'none', '1800', 'immediately'],
  ['yes variant right answer', ['rent'], 'Kim', 'North Vancouver', "that's right", 'd', 'dog', '$3600', 'aug'],
  ['budget sentence', ['a'], 'Raj', 'Coquitlam', 'yes', '2', 'cat', 'I can spend 2700', 'september 2026'],
  ['pet sentence plural', ['rent'], 'Paul', 'Victoria', 'yes', '1', 'cats', '2000', 'feb'],
  ['dog sentence with right away', ['a'], 'Ruth', 'Abbotsford', 'yes', '3', 'we have a dog', '$2400', 'right away'],
  ['poco and phrase name', ['lease'], 'my name is Lidia', 'poco', 'yes', '2 bedrooms', 'cat', '$2600', 'oct'],
  ['new west and no sentence', ['a'], 'Joe', 'new west', 'yes', '2', 'no pets', '$2650', 'may'],
  ['surrey and dog words', ['rent'], 'Layla', 'Surrey', 'yes', 'three bedrooms', 'dogs', '$3200', 'november'],
  ['burnaby and cat words', ['a'], 'Rits', 'Burnaby', 'yes', '2 bedrooms', 'we have a cat', '2600', 'april'],
  ['langley with pet-free', ['lease'], 'Jane', 'Langley', 'yes', '1', 'pet free', '2100', 'june'],
  ['richmond and uppercase month', ['rent'], 'Lila', 'Richmond', 'yes', '2', 'dog', '$3000', 'OCT'],
  ['delta and a dog', ['a'], 'Carlos', 'Delta', 'yes', '3', 'a dog', '$2800', 'july'],
  ['coquitlam and around budget', ['rent'], 'Sofia', 'Coquitlam', 'yes', '2', 'cat', 'around 2500', 'december'],
  ['nanaimo and no pets at all', ['a'], 'Eva', 'Nanaimo', 'yes', '1', 'no pets at all', '$1750', 'march'],
  ['calgary immediate phrase', ['rent'], 'Amir', 'Calgary Alberta', 'yes', '3', 'dog', '2300', 'as soon as possible'],
  ['white rock cat sentence', ['a'], 'Leo', 'White Rock', 'yes', '2', 'we have a cat', '$2650', 'sep'],
];

const rentalUnexpectedSeeds: RentalSeed[] = rentalUnexpectedSeedData.map(([label, preName, nameInput, cityInput, confirmInput, bedroomsInput, petsInput, budgetInput, timingInput]) => {
  const expectedArea =
    cityInput.toLowerCase() === 'new west' ? 'New Westminster'
      : cityInput.toLowerCase() === 'poco' ? 'Port Coquitlam'
        : cityInput.toLowerCase() === 'calgary alberta' ? 'Calgary'
          : titleCaseName(cityInput);
  const expectedBedrooms =
    /\bstudio\b/i.test(bedroomsInput) ? '0'
      : /^(?:(?:d|3|three)(?:\s+bedrooms?)?)$/i.test(bedroomsInput.trim()) ? '3'
        : /^(?:(?:c|2|two)(?:\s+bedrooms?)?)$/i.test(bedroomsInput.trim()) ? '2'
          : '1';
  const expectedPets =
    /dog/i.test(petsInput) ? 'dog'
      : /cat/i.test(petsInput) ? 'cat'
        : 'none';
  const expectedBudget = (budgetInput.match(/\d{3,5}/)?.[0] ?? '').replace(/^0+/, '') || '0';
  const timingMap: Record<string, string> = {
    oct: 'October',
    aug: 'August',
    nov: 'November',
    feb: 'February',
    sep: 'September',
    dec: 'December',
    'october 2026': 'October 2026',
    'september 2026': 'September 2026',
    asap: 'As soon as possible',
    immediately: 'As soon as possible',
    'as soon as possible': 'As soon as possible',
    'right away': 'As soon as possible',
    october: 'October',
    january: 'January',
    april: 'April',
    june: 'June',
    july: 'July',
    december: 'December',
    march: 'March',
  };

  return {
    label,
    style: 'unexpected',
    intentInput: preName[0],
    preName: preName.slice(1),
    nameInput,
    expectedName: titleCaseName(nameInput.replace(/^(?:call me|my name is|i'm)\s+/i, '')),
    cityInput,
    expectedArea,
    confirmInput,
    bedroomsInput,
    expectedBedrooms,
    petsInput,
    expectedPets,
    budgetInput,
    expectedBudget,
    timingInput,
    expectedTiming: timingMap[timingInput.toLowerCase()] ?? titleCaseName(timingInput),
  };
});

const buyerCases = [
  ['standard condo buyer', ['b', 'Ana', 'Burnaby', 'yes', 'condo', '2', '750000', 'pre-approved', 'within 3 months']],
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
] as const;

const sellerCases = [
  ['standard occupied condo with confusion', ['c', 'Ana', '120 Main St, Burnaby BC', 'condo', '2', 'I live there', 'within 3 months', 'I want a valuation']],
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
] as const;

function buyerScenario(index: number, [label, baseMessages]: readonly [string, readonly string[]]): TranscriptScenario {
  const timeline = baseMessages.at(-1)?.toLowerCase() ?? '';
  const asapLike = /^(?:asap|right away|now|immediately|as soon as possible)$/.test(timeline);
  const messages = [
    ...baseMessages,
    ...(asapLike ? ['I can make an offer as soon as I find the right home'] : []),
    index % 3 === 0 ? 'my partner and I' : index % 3 === 1 ? 'my wife, our child and I' : 'just me for now',
    index % 2 === 0 ? 'we have a dog' : 'no pets',
    index % 4 === 0 ? 'parking and transit' : index % 4 === 1 ? 'schools and a yard' : index % 4 === 2 ? 'quiet street and storage' : 'SkyTrain and parking',
    index % 2 === 0 ? `buyer${index}@example.com` : '604-555-0101',
  ];
  const rawName = baseMessages[1] ?? 'Prospect';
  const prospectName = titleCaseName(rawName);
  return {
    name: `buy (deterministic fallback) ${index < 13 ? 'expected' : 'unexpected'}: ${label}`,
    category: 'buy',
    style: index < 13 ? 'expected' : 'unexpected',
    messages,
    expectedSlots: {
      transaction_intent: 'buy',
      prospect_name: prospectName,
      ownership_qualification_complete: 'yes',
    },
    replyPattern: /advisor|specialist|contact/i,
  };
}

function sellerScenario(index: number, [label, messages]: readonly [string, readonly string[]]): TranscriptScenario {
  const rawName = messages[1] ?? 'Prospect';
  const prospectName = titleCaseName(rawName);
  return {
    name: `sell (deterministic fallback) ${index < 12 ? 'expected' : 'unexpected'}: ${label}`,
    category: 'sell',
    style: index < 12 ? 'expected' : 'unexpected',
    messages: [...messages],
    expectedSlots: {
      transaction_intent: 'sell',
      prospect_name: prospectName,
      ownership_qualification_complete: 'yes',
    },
    replyPattern: /specialist|analysis|next step/i,
  };
}

const scenarios: TranscriptScenario[] = [
  ...rentalExpectedSeeds.map(rentalScenario),
  ...rentalUnexpectedSeeds.map(rentalScenario),
  ...buyerCases.map((scenario, index) => buyerScenario(index, scenario)),
  ...sellerCases.map((scenario, index) => sellerScenario(index, scenario)),
];

describe('conversation transcript runner (deterministic layer only — see file header comment)', () => {
  it('tracks 100 complete conversation scenarios across rent, buy, and sell', () => {
    expect(scenarios).toHaveLength(100);
    expect(scenarios.filter((scenario) => scenario.category === 'rent')).toHaveLength(50);
    expect(scenarios.filter((scenario) => scenario.category === 'buy')).toHaveLength(25);
    expect(scenarios.filter((scenario) => scenario.category === 'sell')).toHaveLength(25);
    expect(scenarios.filter((scenario) => scenario.style === 'expected')).toHaveLength(50);
    expect(scenarios.filter((scenario) => scenario.style === 'unexpected')).toHaveLength(50);
  });

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const result = runTranscript(scenario.messages);
      expect(result.slots).toMatchObject(scenario.expectedSlots);
      expect(result.lastReply).toMatch(scenario.replyPattern);
      expect(result.replies).not.toContain("I'm still with you. Let me continue from the information you've already shared.");
      expect(result.replies).not.toContain('Sorry, I had a brief connection issue. Could you send that again?');

      for (let index = 1; index < result.replies.length; index += 1) {
        expect(result.replies[index], `Repeated reply in ${scenario.name}`).not.toBe(result.replies[index - 1]);
      }
    });
  }
});
