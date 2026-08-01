import { describe, expect, it } from 'vitest';
import {
  buildGlmFallback,
  buildFastQualificationTurn,
  buildClosestAlternativeRecommendation,
  buildQualificationGuardReply,
  buildUnitRecommendationReply,
  buildPostTourAcknowledgement,
  buildStaffOverrideMatchReason,
  buildUnitMatchReason,
  getConversationExternalId,
  getExistingLeadChannelUpdate,
  getReplyAddressFromConversation,
  filterQualifiedUnits,
  excludePreviouslyShownUnits,
  prepareConversationHistory,
  parseGlmJsonResponse,
  rankMatchingUnits,
  shouldUseDeterministicFastPath,
  validateInterpretedLocation,
  alignInterpretedSlotsWithExpectedField,
  sanitizeInterpretedTurn,
  shouldTransitionToMatches,
  shouldPersistPresentedUnit,
  typingDelayFor,
  wantsAllShortlistOptions,
  extractContextualConversationSlots,
  buildConversationRepairTurn,
  resolveReferencedOptions,
  buildPostTourContextTurn,
  buildFocusedPropertyAnswer,
  buildRecommendationDeliveryPlan,
  buildShortlistMarkdownLink,
  sendPhotoIfAvailable,
  shouldDeliverRecommendationPlan,
  serializeConversationTask,
  buildOptionDeclineTurn,
  buildDeterministicQualificationTurn,
  buildInventoryRecoveryTurn,
  buildNoInventoryRecoveryTurn,
  buildNoMatchAdjustmentTurn,
  splitIntoChunks,
  recommendationStateSlotsToClear,
  canResolveActiveShortlist,
  resolveSingleOptionAffirmation,
  sendWithRetry,
  shouldPrioritizeSearchCriteria,
} from './chatbot.service.js';

describe('chatbot conversation identity', () => {
  it('invalidates stale selection and scheduling when search criteria change', () => {
    expect(recommendationStateSlotsToClear(
      { bedrooms: '3', selected_unit_id: 'old', scheduling_unit_id: 'old', pending_slots: '[]' },
      { bedrooms: '2' },
    )).toEqual(expect.arrayContaining([
      'selected_unit_id', 'recommended_unit_id', 'scheduling_unit_id', 'pending_slots', 'match_reason',
    ]));
  });

  it('keeps an awaiting shortlist active after sending its comparison link', () => {
    expect(canResolveActiveShortlist('proposing_tour')).toBe(true);
    expect(canResolveActiveShortlist('proposing_units')).toBe(true);
    expect(canResolveActiveShortlist('scheduling')).toBe(false);
  });

  it('selects the only presented property from an affirmative reply', () => {
    expect(resolveSingleOptionAffirmation('yes', ['unit-1'])).toBe('unit-1');
    expect(resolveSingleOptionAffirmation('that one', ['unit-1'])).toBe('unit-1');
    expect(resolveSingleOptionAffirmation('show me more', ['unit-1'])).toBeUndefined();
  });

  it('understands separate acceptance of timing and rejection of the suggested city', () => {
    const turn = buildNoMatchAdjustmentTurn('timing yes, city no', {
      preferred_area: 'Burnaby',
      move_in_date: 'As soon as possible',
      pending_search_adjustment: 'offer_move_in_date',
      suggested_move_in_date: '2026-09-01',
      suggested_area: 'North Vancouver',
      suggested_province: 'British Columbia',
    });
    expect(turn).toMatchObject({
      intent: 'request_matches',
      slots: { move_in_date: 'September 2026', pending_search_adjustment: 'resolved' },
    });
  });

  it('marks show-me-more as an immediate inventory request', () => {
    expect(buildFastQualificationTurn('show me more', {
      transaction_intent: 'rent', prospect_name: 'Miguel', preferred_area: 'North Vancouver',
      bedrooms: '3', pets: 'dog', budget: '3500', move_in_date: 'September 2026',
    })).toMatchObject({ intent: 'request_more_options', next_state: 'proposing_tour' });
  });

  it('prioritizes an explicit bedroom change over an active shortlist selection', () => {
    expect(shouldPrioritizeSearchCriteria(
      { bedrooms: '3', selected_unit_id: 'richmond-3' },
      extractContextualConversationSlots('show me all your 2 bedroom options', { bedrooms: '3' }),
    )).toBe(true);
    expect(shouldPrioritizeSearchCriteria(
      { bedrooms: '3' },
      extractContextualConversationSlots('I want to see all of them', { bedrooms: '3' }),
    )).toBe(false);
  });

  it('prioritizes an explicitly repeated bedroom request over an active shortlist selection', () => {
    expect(shouldPrioritizeSearchCriteria(
      { bedrooms: '2', shortlist_scope: 'all' },
      extractContextualConversationSlots('show me all your 2 bedroom options', { bedrooms: '2' }),
    )).toBe(true);
  });

  it('retries transient outbound delivery failures', async () => {
    let attempts = 0;
    const result = await sendWithRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('temporary Telegram failure');
      return { messageId: 'tg_42' };
    }, 3);
    expect(result.messageId).toBe('tg_42');
    expect(attempts).toBe(3);
  });
  it('goes from confirmed location directly to bedroom count without asking household composition', () => {
    const turn = buildFastQualificationTurn('yes', {
      transaction_intent: 'rent', prospect_name: 'Joe',
      pending_area: 'Langley', pending_province: 'British Columbia',
      location_confirmation: 'pending',
    });
    expect(turn?.slots).toMatchObject({ preferred_area: 'Langley' });
    expect(turn?.reply).toMatch(/bedroom|space/i);
    expect(turn?.reply).not.toMatch(/who|people|living with/i);
  });

  it('does not require occupants before continuing rental qualification', () => {
    const reply = buildQualificationGuardReply({
      transaction_intent: 'rent', prospect_name: 'Joe', preferred_area: 'Langley',
      preferred_province: 'British Columbia', location_confirmation: 'confirmed',
    });
    expect(reply).toMatch(/bedroom|space/i);
    expect(reply).not.toMatch(/who|people|household/i);
  });

  it('asks one simple question when inventory has no close alternative', () => {
    const turn = buildNoInventoryRecoveryTurn({ preferred_area: 'Langley', budget: '2500', bedrooms: '3' });
    expect(turn.reply).toContain('3-bedroom');
    expect(turn.reply).toContain('$2,500');
    expect(turn.reply).toMatch(/keep Langley/i);
    expect(turn.reply).not.toMatch(/ or /i);
    expect(turn.slots).toEqual({ pending_search_adjustment: 'confirm_area_priority' });
  });

  it('clarifies an ambiguous yes after no results instead of opening tour scheduling', () => {
    const turn = buildNoMatchAdjustmentTurn('yes', {
      transaction_intent: 'rent', preferred_area: 'Langley', budget: '2500', bedrooms: '3',
      pending_search_adjustment: 'confirm_area_priority',
    });
    expect(turn).toMatchObject({ next_state: 'collecting_budget' });
    expect(turn?.reply).toMatch(/maximum budget/i);
    expect(turn?.reply).not.toMatch(/tour|nearby cities|available times/i);
  });

  it('explains when no exact inventory exists in the requested city at any budget and proposes one specific nearby city', () => {
    const turn = buildInventoryRecoveryTurn([
      {
        id: 'surrey-3br',
        name: 'Suite 801',
        propertyName: 'Surrey Heights',
        city: 'Surrey',
        province: 'British Columbia',
        address: '100 Main St',
        rentCents: 320000,
        bedrooms: 3,
        bathrooms: 2,
        availableFrom: null,
        petPolicy: 'Pet friendly',
      },
      {
        id: 'langley-2br',
        name: 'Suite 210',
        propertyName: 'Langley Gardens',
        city: 'Langley',
        province: 'British Columbia',
        address: '200 Main St',
        rentCents: 240000,
        bedrooms: 2,
        bathrooms: 1,
        availableFrom: null,
        petPolicy: 'Dog friendly',
      },
    ], {
      preferred_area: 'Langley',
      preferred_province: 'British Columbia',
      budget: '2600',
      bedrooms: '3',
      pets: 'dog',
    });

    expect(turn.reply).toContain("don't currently have any 3-bedroom rentals in Langley");
    expect(turn.reply).toContain('closest place I do have one is Surrey');
    expect(turn.reply).toContain('Would you like me to check Surrey instead?');
    expect(turn.reply).not.toMatch(/\bor\b/i);
    expect(turn.slots).toMatchObject({
      pending_search_adjustment: 'offer_area',
      suggested_area: 'Surrey',
    });
  });

  it('offers a concrete minimum budget when price is the only blocker', () => {
    const turn = buildInventoryRecoveryTurn([
      {
        id: 'langley-3br',
        name: 'Suite 501',
        propertyName: 'Langley Gardens',
        city: 'Langley',
        province: 'British Columbia',
        address: '200 Main St',
        rentCents: 320000,
        bedrooms: 3,
        bathrooms: 2,
        availableFrom: null,
        petPolicy: 'Dog friendly',
      },
    ], {
      preferred_area: 'Langley',
      preferred_province: 'British Columbia',
      budget: '2600',
      bedrooms: '3',
      pets: 'dog',
    });

    expect(turn.reply).toContain('lowest current price I found for 3 bedrooms in Langley is $3,200/month');
    expect(turn.reply).toContain('Would that budget work for you?');
    expect(turn.slots).toMatchObject({
      pending_search_adjustment: 'offer_budget',
      suggested_budget: '3200',
    });
  });

  it('explains when immediate move-in is the blocker and offers the closest real availability', () => {
    const turn = buildInventoryRecoveryTurn([
      {
        id: 'richmond-611',
        name: 'Tower 611',
        propertyName: 'Richmond Garden Towers',
        city: 'Richmond',
        province: 'British Columbia',
        address: '10 River Rd',
        rentCents: 320000,
        bedrooms: 3,
        bathrooms: 2,
        availableFrom: new Date('2026-09-15T00:00:00Z'),
        petPolicy: 'Pet friendly',
      },
      {
        id: 'northvan-202',
        name: 'Estates 202',
        propertyName: 'North Van Bluffs',
        city: 'North Vancouver',
        province: 'British Columbia',
        address: '15 Mountain Rd',
        rentCents: 345000,
        bedrooms: 3,
        bathrooms: 2,
        availableFrom: new Date('2026-09-01T00:00:00Z'),
        petPolicy: 'Pet friendly',
      },
    ], {
      preferred_area: 'Langley',
      preferred_province: 'British Columbia',
      budget: '2600',
      bedrooms: '3+',
      pets: 'dog',
      move_in_date: 'As soon as possible',
    });

    expect(turn.reply).toContain("don't currently have a 3+ bedroom home available right away");
    expect(turn.reply).toContain('first one I can offer is in North Vancouver');
    expect(turn.reply).toContain('available on 2026-09-01');
    expect(turn.reply).toContain('Would that timing work for you?');
    expect(turn.slots).toMatchObject({
      pending_search_adjustment: 'offer_move_in_date',
      suggested_move_in_date: '2026-09-01',
    });
  });

  it('accepts a concrete city suggestion without reopening the same loop', () => {
    const turn = buildNoMatchAdjustmentTurn('yes', {
      transaction_intent: 'rent',
      preferred_area: 'Langley',
      preferred_province: 'British Columbia',
      budget: '2600',
      bedrooms: '3',
      pending_search_adjustment: 'offer_area',
      suggested_area: 'Surrey',
      suggested_province: 'British Columbia',
    });

    expect(turn).toMatchObject({
      intent: 'request_matches',
      next_state: 'proposing_tour',
    });
    expect(turn?.slots).toMatchObject({
      preferred_area: 'Surrey',
      preferred_province: 'British Columbia',
      pending_search_adjustment: 'resolved',
    });
    expect(turn?.reply).toContain("I'll switch the search to Surrey");
  });

  it('accepts a concrete budget suggestion without asking for the budget again', () => {
    const turn = buildNoMatchAdjustmentTurn('yes', {
      transaction_intent: 'rent',
      preferred_area: 'Langley',
      preferred_province: 'British Columbia',
      budget: '2600',
      bedrooms: '3',
      pending_search_adjustment: 'offer_budget',
      suggested_budget: '3200',
    });

    expect(turn).toMatchObject({
      intent: 'request_matches',
      next_state: 'proposing_tour',
    });
    expect(turn?.slots).toMatchObject({
      budget: '3200',
      pending_search_adjustment: 'resolved',
    });
    expect(turn?.reply).toContain('$3,200/month');
    expect(turn?.reply).not.toMatch(/maximum budget/i);
  });

  it('treats a natural rejection with area priority as a move away from the repeated timing prompt', () => {
    const turn = buildNoMatchAdjustmentTurn('no i want langley', {
      transaction_intent: 'rent',
      preferred_area: 'Langley',
      preferred_province: 'British Columbia',
      budget: '2600',
      bedrooms: '3+',
      pets: 'dog',
      move_in_date: 'As soon as possible',
      pending_search_adjustment: 'offer_move_in_date',
      suggested_move_in_date: '2026-09-01',
      suggested_area: 'North Vancouver',
      suggested_province: 'British Columbia',
    });

    expect(turn).toMatchObject({
      next_state: 'collecting_movein',
    });
    expect(turn?.reply).toContain('if Langley is the priority');
    expect(turn?.reply).toContain("changing the move-in date alone won't solve it");
    expect(turn?.reply).toContain('closest real alternative');
    expect(turn?.slots).toMatchObject({
      pending_search_adjustment: 'offer_area',
      suggested_area: 'North Vancouver',
    });
  });

  it('never schedules from a generic yes without a selected property', () => {
    expect(buildFastQualificationTurn('yes', {
      transaction_intent: 'rent', prospect_name: 'Joe', preferred_area: 'Langley',
      location_confirmation: 'confirmed', bedrooms: '3', pets: 'none', budget: '2500',
      move_in_date: 'As soon as possible',
    })).toBeUndefined();
  });

  it('preserves a bedroom answer after every rental alignment layer', () => {
    const turn = alignInterpretedSlotsWithExpectedField({
      reply: 'Three bedrooms sounds good.',
      slots: { bedrooms: '3+' },
      next_state: 'collecting_movein',
    }, '3', {
      transaction_intent: 'rent', prospect_name: 'Jane', preferred_area: 'Langley',
      location_confirmation: 'confirmed',
    });
    expect(turn.slots).toMatchObject({ bedrooms: '3+' });
    expect(turn.slots).not.toHaveProperty('occupants');
  });

  it('does not auto-transition to matches while a search adjustment question is pending', () => {
    expect(shouldTransitionToMatches('collecting_movein', {
      transaction_intent: 'rent', prospect_name: 'Jane', preferred_area: 'Langley',
      location_confirmation: 'confirmed', bedrooms: '3', pets: 'dog', budget: '2600',
      move_in_date: 'As soon as possible', pending_search_adjustment: 'collect_budget',
    })).toBe(false);
  });

  it('routes the real rental sequence through deterministic qualification on every turn', () => {
    let slots: Record<string, string> = {};
    const start = buildDeterministicQualificationTurn('/start', slots);
    expect(start?.reply).toContain('a) Rent');

    const intent = buildDeterministicQualificationTurn('a', slots);
    expect(intent).toMatchObject({ slots: { transaction_intent: 'rent' } });
    slots = { ...slots, ...intent?.slots };

    const name = buildDeterministicQualificationTurn('layla', slots);
    expect(name).toMatchObject({
      slots: { prospect_name: 'Layla' },
      next_state: 'collecting_budget',
    });
    expect(name?.reply).toContain('Layla');
    expect(name?.reply).toMatch(/city|area/i);
  });

  it('extracts several household facts from one natural answer', () => {
    expect(extractContextualConversationSlots(
      'My husband, our two children and I will live there, and we have a cat.',
      { transaction_intent: 'rent', prospect_name: 'Lidia', preferred_area: 'Burnaby', location_confirmation: 'confirmed' },
    )).toMatchObject({ occupants: '4', pets: 'cat' });
  });

  it('applies explicit corrections over previously confirmed criteria', () => {
    expect(extractContextualConversationSlots(
      'Actually, make that 3 bedrooms and a maximum of $3,100.',
      { bedrooms: '2', budget: '2800' },
    )).toMatchObject({ bedrooms: '3', budget: '3100' });
  });

  it('keeps ranges as flexible preferences instead of inventing one exact value', () => {
    expect(extractContextualConversationSlots(
      'Two or three bedrooms, and around $2,800 but I could stretch to $3,000.',
      {},
    )).toMatchObject({
      bedrooms_min: '2',
      bedrooms_max: '3',
      budget_preferred: '2800',
      budget: '3000',
    });
  });

  it('does not store conversational uncertainty as a factual answer', () => {
    expect(extractContextualConversationSlots('I am not sure yet.', {
      budget: '2800',
    })).not.toHaveProperty('move_in_date');
  });

  it('does not overwrite the rent budget with the year from a move-in date', () => {
    expect(extractContextualConversationSlots('October 2026', {
      budget: '3400',
    })).toMatchObject({
      move_in_date: 'October 2026',
    });
    expect(extractContextualConversationSlots('October 2026', {
      budget: '3400',
    })).not.toHaveProperty('budget');
  });

  it('repairs confusion by explaining the pending question without losing context', () => {
    expect(buildConversationRepairTurn('Why do you need that?', {
      transaction_intent: 'rent',
      prospect_name: 'Lidia',
      preferred_area: 'Burnaby',
      location_confirmation: 'confirmed',
      occupants: '4',
      bedrooms: '3',
    })?.reply).toContain('pet policies');
  });

  it('rejects a model-invented name when the user expressed confusion', () => {
    expect(alignInterpretedSlotsWithExpectedField({
      reply: 'Nice to meet you.',
      slots: { prospect_name: "I Don't Get That" },
    }, "I don't get that", { transaction_intent: 'rent' }).slots).not.toHaveProperty('prospect_name');
  });

  it('resolves natural references to visible property options', () => {
    expect(resolveReferencedOptions('the first and last one', 3)).toEqual([1, 3]);
    expect(resolveReferencedOptions('the cheaper two', 3, [320000, 345000, 420000])).toEqual([1, 2]);
    expect(resolveReferencedOptions('not option 2', 3)).toEqual([1, 3]);
    expect(resolveReferencedOptions('I like Richmond and North Van', 3, [], [
      'Richmond Garden Towers Richmond',
      'North Van Bluffs North Vancouver',
      'Cedar Court Vancouver',
    ])).toEqual([1, 2]);
  });

  it('answers post-tour logistics from the active appointment context', () => {
    expect(buildPostTourContextTurn('Can you send the address again?', {
      prospect_name: 'Lidia',
      scheduled_unit_address: '1200 Granville St, Vancouver, BC',
      scheduled_unit_label: 'Cedar Court â€” Apt 305',
      tour_scheduled_at: '2026-08-03T21:00:00.000Z',
    })?.reply).toContain('1200 Granville St\nVancouver, BC');
    expect(buildPostTourContextTurn('I need to reschedule', {
      tour_scheduled_at: '2026-08-03T21:00:00.000Z',
    })?.reply).toContain('help you reschedule');
  });

  it('answers an incidental property question and signals that qualification should resume', () => {
    expect(buildFocusedPropertyAnswer('Does it include parking?', {
      id: 'unit-1', name: 'Apt 305', propertyName: 'Cedar Court', city: 'Vancouver',
      rentCents: 280000, bedrooms: 3, bathrooms: 2, availableFrom: null,
      petPolicy: 'Cats allowed', parking: '1 stall included',
    })).toEqual({
      answer: 'Yes — Cedar Court — Apt 305 includes 1 stall included.',
      resume: true,
    });
  });

  it('keeps a request for pictures attached to the focused property', () => {
    expect(buildFocusedPropertyAnswer('pictures', {
      id: 'surrey-204', name: 'Suite 204', propertyName: 'Surrey Crossing',
      city: 'Surrey', rentCents: 205000, bedrooms: 1, bathrooms: 1,
      availableFrom: null, petPolicy: 'Cats allowed',
      photoUrls: ['one.jpg', 'two.jpg'],
    })).toEqual({
      answer: 'Of course — here are the photos for Surrey Crossing — Suite 204.',
      resume: true,
      action: 'photos',
    });
  });

  it('treats ASAP as an immediate availability requirement', () => {
    expect(extractContextualConversationSlots('asap', { budget: '2600' }))
      .toMatchObject({ move_in_date: 'As soon as possible' });
    const units = [
      { id:'now', name:'Now', propertyName:'A', city:'Surrey', rentCents:200000, bedrooms:1, bathrooms:1, availableFrom:new Date('2026-07-31T00:00:00Z'), petPolicy:'Cats allowed' },
      { id:'later', name:'Later', propertyName:'B', city:'Surrey', rentCents:200000, bedrooms:1, bathrooms:1, availableFrom:new Date('2026-08-15T00:00:00Z'), petPolicy:'Cats allowed' },
    ];
    expect(filterQualifiedUnits(units, { move_in_date:'As soon as possible', pets:'cat' }).map((unit)=>unit.id)).toEqual(['now']);
  });

  it('responds concretely when the prospect rejects a relaxed bedroom alternative', () => {
    expect(buildOptionDeclineTurn('no', {
      preferred_area:'Surrey', bedrooms:'2', budget:'2600', recommendation_kind:'alternative',
    })?.reply).toContain('two-bedroom requirement');
  });

  it('does not try to deliver recommendation cards after the flow falls back to inventory recovery', () => {
    expect(shouldDeliverRecommendationPlan({
      shouldGenerateRecommendations: true,
      newState: 'collecting_movein',
      presentedUnits: [],
    })).toBe(false);
  });

  it('preserves the adapter context when sending a recommendation photo', async () => {
    class FakeMessagingAdapter {
      channel = 'web' as const;
      events: string[] = [];
      async send() { return { messageId: 'm1' }; }
      async parseWebhook(): Promise<any> { throw new Error('unused'); }
      async sendPhoto(_to: string, photoUrl: string) {
        this.events.push(photoUrl);
      }
    }

    const messaging = new FakeMessagingAdapter();
    await sendPhotoIfAvailable(messaging, 'lead-1', 'https://example.com/photo.jpg');

    expect(messaging.events).toEqual(['https://example.com/photo.jpg']);
  });

  it('warns when an accepted smaller home may feel tight for the household', () => {
    const reply = buildUnitRecommendationReply([{
      id:'surrey-204', name:'Suite 204', propertyName:'Surrey Crossing',
      city:'Surrey', rentCents:205000, bedrooms:1, bathrooms:1,
      availableFrom:null, petPolicy:'Cats allowed',
    }], { preferred_area:'Surrey', bedrooms:'1', occupants:'3', budget:'2600', pets:'cat' });
    expect(reply).toContain('may feel tight for three people');
  });

  it('keeps appointment confirmation in Telegram when the prospect says here', () => {
    expect(buildPostTourContextTurn('here', {
      tour_scheduled_at:'2026-08-04T17:00:00Z',
    })?.reply).toContain('right here in Telegram');
  });

  it('serializes rapid messages for the same conversation', async () => {
    const events: string[] = [];
    const first = serializeConversationTask('chat-1', async () => {
      events.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('first-end');
    });
    const second = serializeConversationTask('chat-1', async () => {
      events.push('second-start');
      events.push('second-end');
    });
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });
  it('starts with lettered rent, buy, and sell options without repetitive instructions', () => {
    expect(buildFastQualificationTurn('/start', {})).toEqual({
      reply: "Hi! I'm the Virtual Agent for Pacific Ridge Property Management. What are you looking to do?\n\na) Rent\nb) Buy\nc) Sell",
      slots: {},
      next_state: 'greeting',
    });
  });

  it('understands a lettered rental choice without calling the model', () => {
    expect(buildFastQualificationTurn('a', {})).toEqual({
      reply: "Absolutely - I'd be happy to help you find a rental. Before we look at options, what first name should I use for you?",
      slots: { transaction_intent: 'rent' },
      next_state: 'collecting_budget',
    });
  });

  it('welcomes the prospect by name once before asking about location', () => {
    expect(buildFastQualificationTurn("I'm Carlos", { transaction_intent: 'rent' })).toEqual({
      reply: "Nice to meet you, Carlos. I'm here to help you find the right rental. Which city or area would work best for you?",
      slots: { prospect_name: 'Carlos' },
      next_state: 'collecting_budget',
    });
  });

  it('greets the prospect warmly after receiving their name instead of sounding abrupt', () => {
    const turn = buildFastQualificationTurn('Lila', { transaction_intent: 'rent' });
    expect(turn?.reply).toContain("I'm here to help you find the right rental");
    expect(turn?.reply).toContain('Which city or area would work best for you?');
  });

  it('preserves the casing of a hyphenated first name naturally', () => {
    expect(buildFastQualificationTurn('Anne-Marie', { transaction_intent: 'rent' })).toMatchObject({
      slots: { prospect_name: 'Anne-Marie' },
    });
  });

  it('preserves the casing of an apostrophe name naturally', () => {
    expect(buildFastQualificationTurn("D'Arcy", { transaction_intent: 'rent' })).toMatchObject({
      slots: { prospect_name: "D'Arcy" },
    });
  });

  it('clarifies the name question instead of treating confusion as a name', () => {
    expect(buildFastQualificationTurn("I don't get that", { transaction_intent: 'rent' })).toMatchObject({
      intent: 'ask_clarification',
      reply: "Of course - I'm just asking what first name you'd like me to use.",
      slots: {},
      next_state: 'collecting_budget',
    });
  });

  it('confirms the city and province before saving the preferred location', () => {
    expect(buildFastQualificationTurn('Surrey', {
      transaction_intent: 'rent',
      prospect_name: 'Carlos',
    })).toEqual({
      reply: 'Just to confirm, do you mean Surrey, British Columbia?',
      slots: {
        pending_area: 'Surrey',
        pending_province: 'British Columbia',
        location_confirmation: 'pending',
      },
      next_state: 'collecting_budget',
    });
  });

  it('does not loop on the same budget after the prospect already confirmed the area priority', () => {
    const turn = buildNoMatchAdjustmentTurn('2600', {
      transaction_intent: 'rent',
      preferred_area: 'Langley',
      preferred_province: 'British Columbia',
      budget: '2600',
      bedrooms: '3+',
      pets: 'dog',
      pending_search_adjustment: 'collect_budget',
    });

    expect(turn).toMatchObject({
      next_state: 'collecting_movein',
    });
    expect(turn?.reply).toMatch(/nearby city|another area|look nearby/i);
    expect(turn?.reply).not.toMatch(/search Langley again/i);
    expect(turn?.intent).toBeUndefined();
  });

  it('keeps a short menu-style prompt in one outgoing message chunk', () => {
    expect(splitIntoChunks("Hi! I'm the Virtual Agent for Pacific Ridge Property Management. What are you looking to do?\n\na) Rent\nb) Buy\nc) Sell"))
      .toEqual(["Hi! I'm the Virtual Agent for Pacific Ridge Property Management. What are you looking to do?\n\na) Rent\nb) Buy\nc) Sell"]);
  });

  it.each([
    ['a'],
    ['A'],
    ['rent'],
    ['lease'],
  ])('recognizes a natural rental intent variant: %s', (message) => {
    expect(buildFastQualificationTurn(message, {})).toMatchObject({
      slots: { transaction_intent: 'rent' },
      next_state: 'collecting_budget',
    });
  });

  it.each([
    ["I'm mike", 'Mike'],
    ['mike', 'Mike'],
    ['My name is sofia', 'Sofia'],
    ['call me Ana', 'Ana'],
  ])('extracts a plausible first name from: %s', (message, expectedName) => {
    expect(buildFastQualificationTurn(message, { transaction_intent: 'rent' })).toMatchObject({
      slots: { prospect_name: expectedName },
      next_state: 'collecting_budget',
    });
  });

  it.each([
    ['yes'],
    ['yep'],
    ['correct'],
    ["that's right"],
  ])('accepts a natural location confirmation variant: %s', (message) => {
    expect(buildFastQualificationTurn(message, {
      transaction_intent: 'rent',
      prospect_name: 'Jane',
      pending_area: 'Burnaby',
      pending_province: 'British Columbia',
      location_confirmation: 'pending',
    })).toMatchObject({
      slots: {
        preferred_area: 'Burnaby',
        preferred_province: 'British Columbia',
        location_confirmation: 'confirmed',
      },
      next_state: 'collecting_movein',
    });
  });

  it.each([
    ['2', '2'],
    ['two bedrooms', '2'],
    ['studio', '0'],
    ['c', '2'],
  ])('understands a bedroom answer variant: %s', (message, expectedBedrooms) => {
    expect(buildFastQualificationTurn(message, {
      transaction_intent: 'rent',
      prospect_name: 'Jane',
      preferred_area: 'Burnaby',
      preferred_province: 'British Columbia',
      location_confirmation: 'confirmed',
    })).toMatchObject({
      slots: { bedrooms: expectedBedrooms },
      next_state: 'collecting_movein',
    });
  });

  it.each([
    ['no', 'none'],
    ['none', 'none'],
    ['cat', 'cat'],
    ['dogs', 'dog'],
  ])('understands a pet answer variant: %s', (message, expectedPets) => {
    expect(buildFastQualificationTurn(message, {
      transaction_intent: 'rent',
      prospect_name: 'Jane',
      preferred_area: 'Burnaby',
      preferred_province: 'British Columbia',
      location_confirmation: 'confirmed',
      bedrooms: '2',
    })).toMatchObject({
      slots: { pets: expectedPets },
      next_state: 'collecting_budget',
    });
  });

  it.each([
    ['2600', '2600'],
    ['$2,600', '2600'],
    ['around 3100', '3100'],
  ])('understands a budget answer variant: %s', (message, expectedBudget) => {
    expect(buildFastQualificationTurn(message, {
      transaction_intent: 'rent',
      prospect_name: 'Jane',
      preferred_area: 'Burnaby',
      preferred_province: 'British Columbia',
      location_confirmation: 'confirmed',
      bedrooms: '2',
      pets: 'dog',
    })).toMatchObject({
      slots: { budget: expectedBudget },
      next_state: 'collecting_movein',
    });
  });

  it.each([
    ['asap', 'As soon as possible'],
    ['right away', 'As soon as possible'],
    ['sep', 'September'],
    ['october 2026', 'October 2026'],
  ])('understands a move-in timing variant: %s', (message, expectedMoveIn) => {
    expect(buildFastQualificationTurn(message, {
      transaction_intent: 'rent',
      prospect_name: 'Jane',
      preferred_area: 'Burnaby',
      preferred_province: 'British Columbia',
      location_confirmation: 'confirmed',
      bedrooms: '2',
      pets: 'dog',
      budget: '2600',
    })).toMatchObject({
      slots: { move_in_date: expectedMoveIn },
      next_state: 'proposing_tour',
    });
  });

  it.each([
    ['thanks'],
    ['thank you'],
    ['ok thanks'],
    ['sounds good'],
    ['see you then'],
    ["that's all"],
  ])('closes politely after a tour is booked with: %s', (message) => {
    expect(buildPostTourAcknowledgement(message, 'Jane')).toMatchObject({
      next_state: 'handoff',
    });
  });

  it('normalizes a common city abbreviation before asking for confirmation', () => {
    expect(buildFastQualificationTurn('New west', {
      transaction_intent: 'rent',
      prospect_name: 'Manuel',
    })).toEqual({
      reply: 'Just to confirm, do you mean New Westminster, British Columbia?',
      slots: {
        pending_area: 'New Westminster',
        pending_province: 'British Columbia',
        location_confirmation: 'pending',
      },
      next_state: 'collecting_budget',
    });
  });

  it('normalizes POCO to Port Coquitlam before asking for confirmation', () => {
    expect(buildFastQualificationTurn('POCO', {
      transaction_intent: 'rent',
      prospect_name: 'Laura',
    })?.slots).toEqual({
      pending_area: 'Port Coquitlam',
      pending_province: 'British Columbia',
      location_confirmation: 'pending',
    });
  });

  it('saves the confirmed city and province before asking bedroom count', () => {
    expect(buildFastQualificationTurn('yes', {
      transaction_intent: 'rent',
      prospect_name: 'Carlos',
      pending_area: 'Surrey',
      pending_province: 'British Columbia',
      location_confirmation: 'pending',
    })).toEqual({
      reply: 'Perfect - Surrey, British Columbia. How many bedrooms do you need?',
      slots: {
        preferred_area: 'Surrey',
        preferred_province: 'British Columbia',
        location_confirmation: 'confirmed',
        location_confirmed: 'yes',
      },
      next_state: 'collecting_movein',
    });
  });

  it('asks for a corrected city and province when the location is not the intended one', () => {
    expect(buildFastQualificationTurn('b', {
      transaction_intent: 'rent',
      prospect_name: 'Carlos',
      pending_area: 'Surrey',
      pending_province: 'British Columbia',
      location_confirmation: 'pending',
    })).toEqual({
      reply: 'No problem. Which city and province should I use instead?',
      slots: { location_confirmation: 'retry' },
      next_state: 'collecting_budget',
    });
  });

  it('treats a short number as bedrooms after location confirmation', () => {
    expect(buildFastQualificationTurn('3', {
      transaction_intent: 'rent',
      preferred_area: 'Metro Vancouver',
    })).toEqual({
      reply: "3 bedrooms helps narrow things down. Will any pets be moving with you?\n\na) No pets\nb) Cat\nc) Dog\nd) Other",
      slots: { bedrooms: '3' },
      next_state: 'collecting_movein',
    });
  });

  it('uses recent messages chronologically and clears history for a new start', () => {
    const newestFirst = [
      { role: 'assistant', content: 'latest' },
      { role: 'user', content: 'earlier' },
    ];

    expect(prepareConversationHistory(newestFirst, false)).toEqual([
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'latest' },
    ]);
    expect(prepareConversationHistory(newestFirst, true)).toEqual([]);
  });

  it('discards messages from before the most recent start command', () => {
    const newestFirst = [
      { role: 'assistant', content: 'What are you looking to do?' },
      { role: 'user', content: '/start' },
      { role: 'assistant', content: 'Do you mean Port Coquitlam?' },
      { role: 'user', content: 'poco' },
    ];

    expect(prepareConversationHistory(newestFirst, false)).toEqual([
      { role: 'assistant', content: 'What are you looking to do?' },
    ]);
  });

  it('reserves the deterministic conversational path for reset commands', () => {
    expect(shouldUseDeterministicFastPath('/start')).toBe(true);
    expect(shouldUseDeterministicFastPath('MAnuel')).toBe(false);
    expect(shouldUseDeterministicFastPath('yes both')).toBe(false);
    expect(shouldUseDeterministicFastPath("I don't get that")).toBe(false);
  });

  it('parses semantic intent and option references from the model', () => {
    expect(parseGlmJsonResponse(JSON.stringify({
      intent: 'select_options',
      reply: 'Absolutely â€” I will keep both.',
      selected_options: [1, 2],
      selection_scope: 'all',
      slots: {},
      next_state: 'proposing_units',
    }))).toMatchObject({
      intent: 'select_options',
      selected_options: [1, 2],
      selection_scope: 'all',
    });
  });

  it('turns a model-extracted location into a city and province confirmation', () => {
    expect(validateInterpretedLocation({
      intent: 'provide_information',
      reply: 'Port Coquitlam sounds good.',
      slots: { preferred_area: 'POCO' },
      next_state: 'collecting_movein',
    }, {})).toEqual({
      intent: 'provide_information',
      reply: 'Just to confirm, do you mean Port Coquitlam, British Columbia?',
      slots: {
        pending_area: 'Port Coquitlam',
        pending_province: 'British Columbia',
        location_confirmation: 'pending',
      },
      next_state: 'collecting_budget',
    });
  });

  it('commits a pending location when the interpreted intent is confirmation', () => {
    expect(validateInterpretedLocation({
      intent: 'confirm',
      reply: 'Yes.',
      slots: {},
      next_state: 'collecting_movein',
    }, {
      pending_area: 'Port Coquitlam',
      pending_province: 'British Columbia',
      location_confirmation: 'pending',
    }).slots).toEqual({
      preferred_area: 'Port Coquitlam',
      preferred_province: 'British Columbia',
      location_confirmation: 'confirmed',
      location_confirmed: 'yes',
    });
  });

  it('recovers a known city abbreviation when the model omits the location slot', () => {
    expect(alignInterpretedSlotsWithExpectedField({
      intent: 'provide_information',
      reply: 'Which city or area would work best for you?',
      slots: {},
      next_state: 'collecting_movein',
    }, 'poco', {
      transaction_intent: 'rent',
      prospect_name: 'Silvia',
    }).slots).toEqual({ preferred_area: 'Port Coquitlam' });
  });

  it('aligns a numeric answer with bedrooms after location confirmation', () => {
    expect(alignInterpretedSlotsWithExpectedField({
      intent: 'provide_information',
      reply: 'How many bedrooms?',
      slots: { bedrooms: '1' },
      next_state: 'collecting_movein',
    }, '3', {
      transaction_intent: 'rent',
      prospect_name: 'Silvia',
      preferred_area: 'Port Coquitlam',
      preferred_province: 'British Columbia',
      location_confirmation: 'confirmed',
    }).slots).toEqual({ bedrooms: '3' });
  });

  it('treats a plain yes as confirmation while a location is pending', () => {
    expect(alignInterpretedSlotsWithExpectedField({
      intent: 'provide_information',
      reply: 'Great.',
      slots: {},
      next_state: 'collecting_movein',
    }, 'yes', {
      transaction_intent: 'rent',
      prospect_name: 'Nancy',
      pending_area: 'Port Coquitlam',
      pending_province: 'British Columbia',
      location_confirmation: 'pending',
    }).intent).toBe('confirm');
  });

  it('sanitizes non-string model slots before database persistence', () => {
    expect(sanitizeInterpretedTurn({
      intent: 'provide_information',
      reply: 'Thanks.',
      slots: {
        pets: ['dog'] as unknown as string,
        budget: 2500 as unknown as string,
        occupants: '3',
      },
      next_state: 'collecting_movein',
    }).slots).toEqual({
      budget: '2500',
      occupants: '3',
    });
  });

  it('aligns natural pet and budget answers with the fields being requested', () => {
    const householdSlots = {
      transaction_intent: 'rent',
      prospect_name: 'Rits',
      preferred_area: 'Port Coquitlam',
      preferred_province: 'British Columbia',
      location_confirmation: 'confirmed',
      occupants: '3',
      bedrooms: '3',
    };
    expect(alignInterpretedSlotsWithExpectedField({
      intent: 'provide_information',
      reply: 'Thanks.',
      slots: {},
    }, 'a dog', householdSlots).slots).toEqual({ pets: 'dog' });

    expect(alignInterpretedSlotsWithExpectedField({
      intent: 'provide_information',
      reply: 'Thanks.',
      slots: {},
    }, '2600', { ...householdSlots, pets: 'dog' }).slots).toEqual({ budget: '2600' });
  });

  it('treats yes to the pet question as presence, not as no pets', () => {
    expect(alignInterpretedSlotsWithExpectedField({
      intent: 'provide_information',
      reply: 'Thanks.',
      slots: { pets: 'no' },
    }, 'yes', {
      transaction_intent: 'rent',
      prospect_name: 'Rits',
      preferred_area: 'Port Coquitlam',
      preferred_province: 'British Columbia',
      location_confirmation: 'confirmed',
      occupants: '3',
      bedrooms: '3',
    }).slots).toEqual({ pet_presence: 'yes' });

    expect(buildQualificationGuardReply({
      prospect_name: 'Rits',
      preferred_area: 'Port Coquitlam',
      occupants: '3',
      bedrooms: '3',
      pet_presence: 'yes',
    })).toBe('Got it. What kind of pet should I keep in mind?');
  });

  it('normalizes an abbreviated move-in month while that field is expected', () => {
    expect(alignInterpretedSlotsWithExpectedField({
      intent: 'provide_information',
      reply: 'Thanks.',
      slots: {},
    }, 'oct', {
      transaction_intent: 'rent',
      prospect_name: 'Rits',
      preferred_area: 'Port Coquitlam',
      preferred_province: 'British Columbia',
      location_confirmation: 'confirmed',
      occupants: '3',
      bedrooms: '3',
      pets: 'dog',
      budget: '2600',
    }).slots).toEqual({ move_in_date: 'October' });
  });

  it('counts the prospect when household members are described relative to them', () => {
    expect(alignInterpretedSlotsWithExpectedField({
      intent: 'provide_information',
      reply: 'Thanks.',
      slots: { occupants: '2' },
    }, 'my husband and daughter', {
      transaction_intent: 'rent',
      prospect_name: 'Rits',
      preferred_area: 'Port Coquitlam',
      preferred_province: 'British Columbia',
      location_confirmation: 'confirmed',
    }).slots).toEqual({ occupants: '3' });
  });

  it('moves to property matches as soon as rental qualification is complete', () => {
    expect(shouldTransitionToMatches('collecting_movein', {
      transaction_intent: 'rent',
      prospect_name: 'Rits',
      preferred_area: 'Port Coquitlam',
      preferred_province: 'British Columbia',
      location_confirmation: 'confirmed',
      occupants: '3',
      bedrooms: '3',
      pets: 'dog',
      budget: '2600',
      move_in_date: 'October',
    })).toBe(true);
  });

  it('persists a recommended unit only after options are actually presented', () => {
    expect(shouldPersistPresentedUnit('collecting_movein', 3)).toBe(false);
    expect(shouldPersistPresentedUnit('proposing_tour', 1)).toBe(true);
  });

  it('moves directly to matching units after collecting the move-in date', () => {
    expect(buildFastQualificationTurn('September', {
      transaction_intent: 'rent',
      preferred_area: 'Metro Vancouver',
      occupants: '3',
      bedrooms: '2',
      pets: 'dog',
      budget: '2500',
    })).toEqual({
      reply: "Thanks, September. I'll show you the best available matches.",
      slots: { move_in_date: 'September' },
      next_state: 'proposing_tour',
    });
  });

  it('confirms asap as As soon as possible before searching availability', () => {
    expect(buildFastQualificationTurn('asap', {
      transaction_intent: 'rent',
      preferred_area: 'Metro Vancouver',
      occupants: '3',
      bedrooms: '2',
      pets: 'dog',
      budget: '2500',
    })).toEqual({
      reply: "Got it - as soon as possible. I'll show you the best available matches.",
      slots: { move_in_date: 'As soon as possible' },
      next_state: 'proposing_tour',
    });
  });

  it('resumes from complete saved criteria instead of using a connection-error reply', () => {
    expect(buildGlmFallback(
      'proposing_units',
      'Pacific Ridge Property Management',
      'what matches do you have?',
      {
        transaction_intent: 'rent',
        preferred_area: 'Metro Vancouver',
        occupants: '3',
        bedrooms: '2',
        pets: 'dog',
        budget: '2500',
        move_in_date: 'September',
      },
    )).toEqual({
      reply: "I have your preferences. I'll show you the best available matches.",
      slots: {},
      intent: 'request_matches',
      next_state: 'proposing_tour',
    });
  });

  it('understands a request for additional inventory without handing it to the model', () => {
    expect(buildFastQualificationTurn('what else do you have?', {
      transaction_intent: 'rent',
      preferred_area: 'Port Coquitlam',
      occupants: '4',
      bedrooms: '3',
      pets: 'cat',
      budget: '3000',
      move_in_date: 'September',
    })?.next_state).toBe('proposing_tour');
  });

  it('excludes previously displayed units when the interpreted intent requests more options', () => {
    const units = [
      { id:'shown', name:'Tower 611', propertyName:'Richmond Garden Towers', city:'Richmond', rentCents:320000, bedrooms:3, bathrooms:2, availableFrom:null, petPolicy:'Pet friendly' },
      { id:'new', name:'Estates 202', propertyName:'North Van Bluffs', city:'North Vancouver', rentCents:345000, bedrooms:3, bathrooms:2, availableFrom:null, petPolicy:'Pet friendly' },
    ];
    expect(excludePreviouslyShownUnits(units, ['shown']).map((unit) => unit.id)).toEqual(['new']);
  });

  it('recognizes when the prospect wants to keep multiple shortlist options', () => {
    expect(wantsAllShortlistOptions('yes both')).toBe(true);
    expect(wantsAllShortlistOptions('I want to see all of them')).toBe(true);
    expect(wantsAllShortlistOptions('option 2')).toBe(false);
  });

  it('turns a yes after recommendations into tour scheduling instead of repeating listings', () => {
    expect(buildFastQualificationTurn('yes', {
      transaction_intent: 'rent',
      preferred_area: 'Surrey',
      occupants: '3',
      bedrooms: '2',
      pets: 'none',
      budget: '2500',
      move_in_date: 'September',
      selected_unit_id: 'unit-1',
    })?.next_state).toBe('scheduling');
  });

  it('formats property options as numbered Markdown cards before asking for a preference', () => {
    const reply = buildUnitRecommendationReply([{
      id: 'unit_surrey_305',
      name: 'Suite 305',
      propertyName: 'Surrey Crossing Residences',
      address: '10253 King George Blvd',
      city: 'Surrey',
      province: 'BC',
      rentCents: 245000,
      bedrooms: 2,
      bathrooms: 1,
      availableFrom: new Date('2026-08-14T00:00:00.000Z'),
      petPolicy: 'No pets',
      slug: 'surrey-crossing-suite-305',
      landingUrl: 'http://localhost:5173/listings/surrey-crossing-suite-305?tenant=tenant_demo',
      photoUrl: 'https://images.example.com/surrey.jpg',
    }], {
      budget: '2500',
      preferred_area: 'Surrey',
      bedrooms: '2',
    });

    expect(reply).toContain('*Option 1: Surrey Crossing Residences — Suite 305*');
    expect(reply).toContain('• *Rent:* $2,450/month');
    expect(reply).toContain('• *Bedrooms:* 2');
    expect(reply).not.toContain('http://localhost');
    expect(reply).toContain('• *Address:*');
    expect(reply).toContain('10253 King George Blvd\nSurrey, BC');
    expect(reply).not.toContain('My top pick');
    expect(reply).toContain('This home is a strong match because it');
    expect(reply).toContain('Would you like to explore it?');
  });

  it('builds recommendation delivery blocks so each option can be sent before its photo', () => {
    const plan = buildRecommendationDeliveryPlan([{
      id: 'unit_richmond_611',
      name: 'Tower 611',
      propertyName: 'Richmond Garden Towers',
      address: '6500 No 3 Rd',
      city: 'Richmond',
      province: 'BC',
      rentCents: 320000,
      bedrooms: 3,
      bathrooms: 2,
      availableFrom: new Date('2026-09-14T00:00:00.000Z'),
      petPolicy: 'Pet friendly',
      photoUrl: 'https://images.example.com/richmond.jpg',
    }, {
      id: 'unit_northvan_202',
      name: 'Estates 202',
      propertyName: 'North Van Bluffs Estates',
      address: '1455 Marine Dr W',
      city: 'North Vancouver',
      province: 'BC',
      rentCents: 345000,
      bedrooms: 3,
      bathrooms: 2,
      availableFrom: new Date('2026-08-31T00:00:00.000Z'),
      petPolicy: 'Pet friendly',
      photoUrl: 'https://images.example.com/northvan.jpg',
    }], {
      preferred_area: 'New Westminster',
      bedrooms: '3',
      budget: '2800',
      pets: 'cat',
    });

    expect(plan.intro).toContain("I didn't find an exact match in New Westminster");
    expect(plan.options).toHaveLength(2);
    expect(plan.options[0]).toMatchObject({
      index: 1,
      photoUrl: 'https://images.example.com/richmond.jpg',
    });
    expect(plan.options[0].text).toContain('Richmond Garden Towers');
    expect(plan.options[0].text).toContain('6500 No 3 Rd\nRichmond, BC');
    expect(plan.options[1].text).toContain('North Van Bluffs Estates');
    expect(plan.outro).toContain('Which would you like to keep: Option 1 or Option 2, or all of them?');
  });

  it('preserves the seeded local photo path in the Burnaby Loft 410 delivery plan', () => {
    const photoUrl = '/demo-listings/burnaby-heights-loft-410-exterior.png';
    const plan = buildRecommendationDeliveryPlan([{
      id: 'unit_burnaby_410',
      name: 'Loft 410',
      propertyName: 'Burnaby Heights Lofts',
      city: 'Burnaby',
      province: 'BC',
      rentCents: 275000,
      bedrooms: 2,
      bathrooms: 2,
      availableFrom: new Date('2026-08-15T00:00:00.000Z'),
      petPolicy: 'Pet friendly',
      photoUrl,
    }], { preferred_area: 'Burnaby', bedrooms: '2', budget: '3500' });

    expect(plan.options[0].photoUrl).toBe(photoUrl);
  });

  it('closes warmly after a scheduled tour instead of reopening recommendations', () => {
    expect(buildPostTourAcknowledgement('ok thanks', 'Lidia')).toEqual({
      reply: "You're very welcome, Lidia. Your tour is all set. If anything changes or you have a question before the visit, just send me a message here.",
      slots: {},
      next_state: 'handoff',
    });
    expect(buildPostTourAcknowledgement('show me other options', 'Lidia')).toBeUndefined();
  });

  it('renders shortlist replies with both a markdown link and the raw URL for Telegram fallback', () => {
    expect(buildShortlistMarkdownLink('abc123')).toBe(
      '[Open your shortlist](http://localhost:5173/shortlist/abc123)\nhttp://localhost:5173/shortlist/abc123',
    );
  });

  it('falls back to a warm introduction when the model fails during greeting', () => {
    expect(buildGlmFallback('greeting', 'Pacific Ridge Property Management', '/start')).toEqual({
      reply: "Hi! I'm the Virtual Agent for Pacific Ridge Property Management. What are you looking to do?\n\na) Rent\nb) Buy\nc) Sell",
      slots: {},
      next_state: 'greeting',
    });
  });

  it('starts buy and sell qualification instead of immediately handing the prospect off', () => {
    expect(buildFastQualificationTurn('b', {}, 'Pacific Ridge Property Management')).toMatchObject({
      slots: { transaction_intent: 'buy' },
      next_state: 'collecting_budget',
    });
    expect(buildFastQualificationTurn('c', {}, 'Pacific Ridge Property Management')).toMatchObject({
      slots: { transaction_intent: 'sell' },
      next_state: 'collecting_budget',
    });
  });

  it('clarifies transaction intent when the prospect has not said rent, buy, or sell', () => {
    expect(buildGlmFallback(
      'greeting',
      'Pacific Ridge Property Management',
      'I am looking for an apartment',
    )).toEqual({
      reply: "Hi! I'm the Virtual Agent for Pacific Ridge Property Management. What are you looking to do?\n\na) Rent\nb) Buy\nc) Sell",
      slots: {},
      next_state: 'greeting',
    });
  });

  it('parses structured GLM output wrapped in a JSON markdown fence', () => {
    expect(parseGlmJsonResponse(
      '```json\n{"reply":"Hi there!","next_state":"greeting"}\n```',
    )).toEqual({
      reply: 'Hi there!',
      next_state: 'greeting',
    });
  });

  it('keeps qualifying instead of recommending after only budget and move-in date', () => {
    expect(buildQualificationGuardReply({
      budget: '2500',
      move_in_date: 'September',
    })).toBe(
      'Before we go further, what first name should I use for you?',
    );
  });

  it('asks for location only after the prospect name is known', () => {
    expect(buildQualificationGuardReply({
      prospect_name: 'Laura',
      budget: '2500',
      move_in_date: 'September',
    })).toBe(
      'September gives us a useful starting point. Which city or area would work best for you?',
    );
  });

  it('greets a newly introduced prospect by name before offering help', () => {
    expect(buildQualificationGuardReply({
      prospect_name: 'Silvia',
    }, {
      prospect_name: 'Silvia',
    })).toBe(
      "Nice to meet you, Silvia. I'm here to help you find the right rental. Which city or area would work best for you?",
    );
  });

  it('marks a name clarification as clarification intent so the service can preserve it', () => {
    expect(buildFastQualificationTurn("I don't get that", {
      transaction_intent: 'rent',
    })).toMatchObject({
      intent: 'ask_clarification',
      reply: "Of course - I'm just asking what first name you'd like me to use.",
    });
  });

  it('does not replace a pending city and province confirmation', () => {
    expect(buildQualificationGuardReply({
      prospect_name: 'Laura',
      pending_area: 'Port Coquitlam',
      pending_province: 'British Columbia',
      location_confirmation: 'pending',
    })).toBeUndefined();
  });

  it('allows recommendations after the essential household needs are known', () => {
    expect(buildQualificationGuardReply({
      prospect_name: 'Laura',
      budget: '2500',
      move_in_date: 'September',
      preferred_area: 'Burnaby',
      occupants: '2',
      bedrooms: '2',
      pets: 'cat',
    })).toBeUndefined();
  });

  it('uses a brief human-paced typing delay without becoming slow', () => {
    const shortReplyDelay = typingDelayFor('Thanks!');
    const longReplyDelay = typingDelayFor('A'.repeat(500));

    expect(shortReplyDelay).toBeGreaterThanOrEqual(700);
    expect(longReplyDelay).toBeGreaterThan(shortReplyDelay);
    expect(longReplyDelay).toBeLessThanOrEqual(1800);
  });

  it('keeps SMS and WhatsApp conversations separate for the same phone number', () => {
    const phone = '+16045551792';

    expect(getConversationExternalId({ channel: 'sms', from: phone })).toBe('sms:+16045551792');
    expect(getConversationExternalId({ channel: 'whatsapp', from: phone })).toBe('whatsapp:+16045551792');
  });

  it('strips channel prefixes before sending replies', () => {
    expect(getReplyAddressFromConversation('sms:+16045551792')).toBe('+16045551792');
    expect(getReplyAddressFromConversation('whatsapp:+16045551792')).toBe('+16045551792');
    expect(getReplyAddressFromConversation('telegram:12345')).toBe('12345');
    expect(getReplyAddressFromConversation('web_session_1')).toBe('web_session_1');
  });

  it('keeps first-touch source while updating the preferred channel', () => {
    expect(getExistingLeadChannelUpdate('whatsapp')).toEqual({ preferredChannel: 'whatsapp' });
    expect(getExistingLeadChannelUpdate('sms')).toEqual({ preferredChannel: 'sms' });
  });

  it('ranks active units by budget, area, pets, beds, and availability', () => {
    const ranked = rankMatchingUnits(
      [
        {
          id: 'unit_a',
          name: 'Apt 101',
          propertyName: 'Cedar Court',
          city: 'Vancouver',
          rentCents: 240000,
          bedrooms: 1,
          bathrooms: 1,
          availableFrom: new Date('2026-08-01T00:00:00.000Z'),
          petPolicy: 'Cats allowed',
        },
        {
          id: 'unit_b',
          name: 'Suite 12',
          propertyName: 'Burnaby Heights',
          city: 'Burnaby',
          rentCents: 260000,
          bedrooms: 2,
          bathrooms: 1.5,
          availableFrom: new Date('2026-08-15T00:00:00.000Z'),
          petPolicy: 'Pet friendly',
        },
      ],
      {
        budget: '2600',
        preferred_area: 'Burnaby',
        pets: 'cat',
        occupants: '2',
        move_in_date: 'August',
      },
    );

    expect(ranked[0].id).toBe('unit_b');
    expect(buildUnitMatchReason(ranked[0], {
      budget: '2600',
      preferred_area: 'Burnaby',
      pets: 'cat',
      occupants: '2',
      move_in_date: 'August',
    })).toContain('matches the Burnaby area');
  });

  it('excludes units outside the requested area or below the requested bedroom count', () => {
    const units = [
      { id:'exact', name:'Suite 305', propertyName:'Surrey Crossing', city:'Surrey', rentCents:245000, bedrooms:2, bathrooms:1, availableFrom:null, petPolicy:'No pets' },
      { id:'small', name:'Suite 204', propertyName:'Surrey Crossing', city:'Surrey', rentCents:205000, bedrooms:1, bathrooms:1, availableFrom:null, petPolicy:'Cats allowed' },
      { id:'larger', name:'Suite 405', propertyName:'Surrey Crossing', city:'Surrey', rentCents:250000, bedrooms:3, bathrooms:2, availableFrom:null, petPolicy:'No pets' },
      { id:'far', name:'Lakeside 303', propertyName:'Lakeside Vista', city:'Kelowna', rentCents:215000, bedrooms:2, bathrooms:1, availableFrom:null, petPolicy:'No pets' },
    ];
    expect(filterQualifiedUnits(units, { preferred_area:'Surrey', bedrooms:'2', pets:'none', budget:'2500' }).map(unit => unit.id)).toEqual(['exact']);
  });

  it('matches equivalent province names and excludes a different province', () => {
    const units = [
      { id:'bc', name:'Suite 305', propertyName:'Surrey Crossing', city:'Surrey', province:'BC', rentCents:245000, bedrooms:2, bathrooms:1, availableFrom:null, petPolicy:'No pets' },
      { id:'ab', name:'Suite 12', propertyName:'Surrey Place', city:'Surrey', province:'Alberta', rentCents:230000, bedrooms:2, bathrooms:1, availableFrom:null, petPolicy:'No pets' },
    ];
    expect(filterQualifiedUnits(units, {
      preferred_area:'Surrey',
      preferred_province:'British Columbia',
      bedrooms:'2',
      pets:'none',
      budget:'2500',
    }).map(unit => unit.id)).toEqual(['bc']);
  });

  it('matches an already-saved city abbreviation to its canonical city', () => {
    const units = [
      { id:'new-west', name:'Suite 8', propertyName:'Westminster Place', city:'New Westminster', province:'BC', rentCents:250000, bedrooms:2, bathrooms:1, availableFrom:null, petPolicy:'Pet friendly' },
    ];
    expect(filterQualifiedUnits(units, {
      preferred_area:'New west',
      preferred_province:'British Columbia',
      bedrooms:'2',
      pets:'cat',
      budget:'2600',
    }).map((unit) => unit.id)).toEqual(['new-west']);
  });

  it('offers a concrete nearby-city alternative when the requested city has no match', () => {
    const result = buildClosestAlternativeRecommendation([
      { id:'burnaby', name:'Suite 12', propertyName:'Burnaby Heights', city:'Burnaby', province:'BC', rentCents:245000, bedrooms:2, bathrooms:1, availableFrom:null, petPolicy:'No pets' },
    ], {
      preferred_area:'New west',
      preferred_province:'British Columbia',
      bedrooms:'2',
      pets:'none',
      budget:'2500',
    });

    expect(result?.units.map((unit) => unit.id)).toEqual(['burnaby']);
    expect(result?.reply).toContain("I didn't find a 2-bedroom home in New Westminster");
    expect(result?.reply).toContain('I did find one in Burnaby for $2,450/month');
    expect(result?.reply).toContain('Would Burnaby work for you?');
  });

  it('states the exact budget increase needed for the closest matching home', () => {
    const result = buildClosestAlternativeRecommendation([
      { id:'surrey', name:'Suite 305', propertyName:'Surrey Crossing', city:'Surrey', province:'BC', rentCents:265000, bedrooms:2, bathrooms:1, availableFrom:null, petPolicy:'No pets' },
    ], {
      preferred_area:'Surrey',
      preferred_province:'British Columbia',
      bedrooms:'2',
      pets:'none',
      budget:'2500',
    });

    expect(result?.units.map((unit) => unit.id)).toEqual(['surrey']);
    expect(result?.reply).toContain('The closest fit is $2,650/month');
    expect(result?.reply).toContain('$150 above your budget');
    expect(result?.reply).toContain('Would you be comfortable stretching the budget to $2,650?');
  });

  it('offers the closest concrete option when both city and budget must change', () => {
    const result = buildClosestAlternativeRecommendation([
      { id:'vancouver', name:'Apt 102', propertyName:'Cedar Court', address:'1200 Granville St', city:'Vancouver', province:'BC', rentCents:265000, bedrooms:2, bathrooms:1, availableFrom:null, petPolicy:'Pet friendly' },
      { id:'burnaby', name:'Loft 410', propertyName:'Burnaby Heights', city:'Burnaby', province:'BC', rentCents:275000, bedrooms:2, bathrooms:2, availableFrom:null, petPolicy:'Pet friendly' },
      { id:'surrey', name:'Suite 305', propertyName:'Surrey Crossing', city:'Surrey', province:'BC', rentCents:245000, bedrooms:2, bathrooms:1, availableFrom:null, petPolicy:'No pets' },
    ], {
      preferred_area:'New west',
      preferred_province:'British Columbia',
      bedrooms:'2',
      pets:'cat',
      budget:'2600',
    });

    expect(result?.units.map((unit) => unit.id)).toEqual(['burnaby', 'vancouver']);
    expect(result?.reply).toContain("I didn't find an exact match in New Westminster");
    expect(result?.reply).toContain('Vancouver');
    expect(result?.reply).toContain('$150 above your budget');
    expect(result?.reply).toContain('accepts cats');
    expect(result?.reply).toContain('1200 Granville St\nVancouver, BC');
    expect(result?.reply).toContain('*Option 1: Burnaby Heights — Loft 410*');
    expect(result?.reply).toContain('• *Pets:* Pet friendly');
  });

  it('prefers a genuinely nearby city when alternatives change both area and budget', () => {
    const result = buildClosestAlternativeRecommendation([
      { id:'richmond', name:'Tower 1', propertyName:'Richmond Towers', city:'Richmond', province:'BC', rentCents:285000, bedrooms:3, bathrooms:2, availableFrom:null, petPolicy:'Pet friendly' },
      { id:'burnaby', name:'Suite 2', propertyName:'Burnaby Homes', city:'Burnaby', province:'BC', rentCents:295000, bedrooms:3, bathrooms:2, availableFrom:null, petPolicy:'Pet friendly' },
    ], {
      preferred_area:'New Westminster',
      preferred_province:'British Columbia',
      bedrooms:'3',
      pets:'cat',
      budget:'2800',
    });
    expect(result?.units[0].id).toBe('burnaby');
  });

  it('describes a staff-selected unit recommendation override', () => {
    expect(buildStaffOverrideMatchReason('Burnaby Heights', 'Suite 12')).toBe(
      'Selected by staff override: Burnaby Heights Suite 12.',
    );
  });

  it('prefers the cheaper unit when both meet the same criteria', () => {
    // Dos unidades idÃ©nticas en ciudad, mascotas y habitaciones, solo difiere el precio.
    // La mÃ¡s barata debe quedar primera (bonus por valor).
    const ranked = rankMatchingUnits(
      [
        {
          id: 'unit_expensive',
          name: 'Suite 5',
          propertyName: 'Burnaby Heights',
          city: 'Burnaby',
          rentCents: 260000,
          bedrooms: 2,
          bathrooms: 1,
          availableFrom: null,
          petPolicy: 'Pet friendly',
        },
        {
          id: 'unit_cheap',
          name: 'Suite 3',
          propertyName: 'Burnaby Heights',
          city: 'Burnaby',
          rentCents: 230000,
          bedrooms: 2,
          bathrooms: 1,
          availableFrom: null,
          petPolicy: 'Pet friendly',
        },
      ],
      {
        budget: '2700',
        preferred_area: 'Burnaby',
        pets: 'cat',
        bedrooms: '2',
      },
    );

    expect(ranked[0].id).toBe('unit_cheap');
    // El match reason debe mencionar que estÃ¡ por debajo del presupuesto.
    expect(buildUnitMatchReason(ranked[0], {
      budget: '2700',
      preferred_area: 'Burnaby',
      pets: 'cat',
      bedrooms: '2',
    })).toContain('under');
  });

  it('uses bedrooms for matching when provided', () => {
    const reason = buildUnitMatchReason(
      {
        id: 'unit_x',
        name: 'Apt 2',
        propertyName: 'Cedar Court',
        city: 'Vancouver',
        rentCents: 240000,
        bedrooms: 2,
        bathrooms: 1,
        availableFrom: null,
        petPolicy: null,
      },
      { budget: '2600', bedrooms: '2' },
    );

    expect(reason).toContain('2 bedrooms');
  });

  it('honours flexible bedroom ranges and move-in availability', () => {
    const units = [
      { id:'one', name:'One', propertyName:'A', city:'Burnaby', rentCents:200000, bedrooms:1, bathrooms:1, availableFrom:new Date('2026-09-01'), petPolicy:'No pets' },
      { id:'two', name:'Two', propertyName:'B', city:'Burnaby', rentCents:220000, bedrooms:2, bathrooms:1, availableFrom:new Date('2026-10-15'), petPolicy:'No pets' },
      { id:'three-late', name:'Three', propertyName:'C', city:'Burnaby', rentCents:240000, bedrooms:3, bathrooms:2, availableFrom:new Date('2026-11-01'), petPolicy:'No pets' },
      { id:'four', name:'Four', propertyName:'D', city:'Burnaby', rentCents:260000, bedrooms:4, bathrooms:2, availableFrom:new Date('2026-09-01'), petPolicy:'No pets' },
    ];
    expect(filterQualifiedUnits(units, {
      bedrooms_min: '2',
      bedrooms_max: '3',
      move_in_date: 'October 2026',
      pets: 'none',
    }).map((unit) => unit.id)).toEqual(['two']);
  });

  it('treats three-plus bedrooms as a minimum rather than exactly three', () => {
    const units = [
      { id:'three', name:'Three', propertyName:'A', city:'Burnaby', rentCents:250000, bedrooms:3, bathrooms:2, availableFrom:null, petPolicy:'No pets' },
      { id:'four', name:'Four', propertyName:'B', city:'Burnaby', rentCents:280000, bedrooms:4, bathrooms:2, availableFrom:null, petPolicy:'No pets' },
    ];
    expect(filterQualifiedUnits(units, { bedrooms: '3+', pets: 'none' }).map((unit) => unit.id)).toEqual(['three', 'four']);
  });
});
