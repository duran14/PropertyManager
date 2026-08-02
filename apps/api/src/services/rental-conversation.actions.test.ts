import { describe, expect, it, vi } from 'vitest';
import type { AvailableUnit } from './chatbot.service.js';
import {
  executeRentalConversationAction,
  type PendingTourSlot,
  type RentalConversationActionDependencies,
} from './rental-conversation.actions.js';
import type { ConversationTurn, RentalProfile } from './rental-conversation.types.js';

const burnabyUnit: AvailableUnit = {
  id: 'unit_burnaby_410',
  name: 'Loft 410',
  rentCents: 275_000,
  city: 'Burnaby',
  province: 'British Columbia',
  propertyName: 'Burnaby Heights Lofts',
  address: '4100 Hastings St',
  bedrooms: 2,
  bathrooms: 2,
  availableFrom: new Date('2026-08-15T00:00:00.000Z'),
  petPolicy: 'Pet friendly',
};

const richmondUnit: AvailableUnit = {
  ...burnabyUnit,
  id: 'unit_richmond_204',
  name: 'Suite 204',
  city: 'Richmond',
  propertyName: 'Richmond Gardens',
};

const profile: RentalProfile = {
  transaction_intent: 'rent',
  preferred_area: 'Burnaby',
  preferred_province: 'British Columbia',
  bedrooms: '2',
  budget: '3500',
  pets: 'dog',
  move_in_date: 'September 2026',
};

function turn(
  intent: ConversationTurn['intent'],
  selection?: ConversationTurn['selection'],
  confidence: ConversationTurn['confidence'] = 'high',
): ConversationTurn {
  return {
    reply: 'Got it.',
    intent,
    confidence,
    profile: { set: {}, clear: [] },
    ...(selection ? { selection } : {}),
  };
}

function pendingSlot(index: number): PendingTourSlot {
  return {
    index,
    startAt: `2026-08-${10 + index}T17:00:00.000Z`,
    endAt: `2026-08-${10 + index}T17:30:00.000Z`,
    label: `August ${10 + index} at 10:00 AM`,
  };
}

function dependencies(overrides: Partial<RentalConversationActionDependencies> = {}) {
  const deps: RentalConversationActionDependencies = {
    filterUnits: vi.fn((units: AvailableUnit[], criteria: RentalProfile) => units.filter((unit) => (
      unit.city.toLowerCase() === criteria.preferred_area?.toLowerCase()
      && unit.bedrooms === Number(criteria.bedrooms)
      && unit.rentCents <= Number(criteria.budget) * 100
    ))),
    rankUnits: vi.fn((units: AvailableUnit[]) => units),
    createShortlist: vi.fn(async () => ({ id: 'shortlist-1' })),
    selectShortlistUnit: vi.fn(async () => undefined),
    getAvailableSlots: vi.fn(async () => []),
    saveSchedulingContext: vi.fn(async () => undefined),
    getSchedulingContext: vi.fn(async () => null),
    scheduleTour: vi.fn(async () => ({ scheduledAt: '2026-08-10T17:00:00.000Z' })),
    ...overrides,
  };
  return deps;
}

const baseInput = {
  tenantId: 'tenant-1',
  conversationId: 'conversation-1',
  state: 'collecting_movein' as const,
  profile,
  availableUnits: [richmondUnit, burnabyUnit],
};

describe('executeRentalConversationAction', () => {
  it('filters and ranks real inventory before persisting at most three recommendations', async () => {
    const deps = dependencies();
    const additionalMatches = [1, 2, 3].map((number) => ({
      ...burnabyUnit,
      id: `unit_burnaby_${number}`,
      name: `Suite ${number}`,
    }));

    const result = await executeRentalConversationAction({
      ...baseInput,
      availableUnits: [richmondUnit, burnabyUnit, ...additionalMatches],
      turn: turn('discover'),
    }, deps);

    expect(result.kind).toBe('recommendations');
    if (result.kind !== 'recommendations') throw new Error('Expected recommendations');
    expect(result.units.map((unit) => unit.id)).toEqual([
      'unit_burnaby_410',
      'unit_burnaby_1',
      'unit_burnaby_2',
    ]);
    expect(deps.createShortlist).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      unitIds: ['unit_burnaby_410', 'unit_burnaby_1', 'unit_burnaby_2'],
    });
  });

  it('rejects a selected unit that is absent from the active shortlist', async () => {
    const deps = dependencies();

    const result = await executeRentalConversationAction({
      ...baseInput,
      turn: turn('select_unit', { unitIds: ['invented-unit'] }),
      activeShortlist: {
        id: 'shortlist-1',
        unitIds: ['unit_burnaby_410'],
        selectedUnitId: null,
      },
    }, deps);

    expect(result.kind).toBe('clarification');
    if (result.kind === 'recommendations') throw new Error('Expected clarification');
    expect(result.reply).toMatch(/which option/i);
    expect(deps.selectShortlistUnit).not.toHaveBeenCalled();
  });

  it('does not look up slots when a tour is requested without a selected unit', async () => {
    const deps = dependencies();

    const result = await executeRentalConversationAction({
      ...baseInput,
      turn: turn('request_tour'),
      activeShortlist: {
        id: 'shortlist-1',
        unitIds: ['unit_burnaby_410'],
        selectedUnitId: null,
      },
    }, deps);

    if (result.kind === 'recommendations') throw new Error('Expected clarification');
    expect(result.reply).toBe('Which property would you like to visit?');
    expect(deps.getAvailableSlots).not.toHaveBeenCalled();
    expect(deps.saveSchedulingContext).not.toHaveBeenCalled();
  });

  it('shows and stores no more than six slots returned by the operational adapter', async () => {
    const realSlots = Array.from({ length: 7 }, (_, index) => pendingSlot(index));
    const deps = dependencies({
      getAvailableSlots: vi.fn(async () => realSlots),
    });

    const result = await executeRentalConversationAction({
      ...baseInput,
      turn: turn('request_tour'),
      activeShortlist: {
        id: 'shortlist-1',
        unitIds: ['unit_burnaby_410'],
        selectedUnitId: 'unit_burnaby_410',
      },
    }, deps);

    expect(result.kind).toBe('reply');
    if (result.kind === 'recommendations') throw new Error('Expected reply');
    expect(result.reply).toContain(realSlots[0]!.label);
    expect(result.reply).not.toContain(realSlots[6]!.label);
    expect(deps.saveSchedulingContext).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      unitId: 'unit_burnaby_410',
      slots: realSlots.slice(0, 6),
    });
  });

  it('never schedules an out-of-range pending slot index', async () => {
    const deps = dependencies({
      getSchedulingContext: vi.fn(async () => ({
        unitId: 'unit_burnaby_410',
        slots: [pendingSlot(0)],
      })),
    });

    const result = await executeRentalConversationAction({
      ...baseInput,
      state: 'scheduling',
      turn: turn('choose_slot', { slotIndex: 4 }),
      activeShortlist: {
        id: 'shortlist-1',
        unitIds: ['unit_burnaby_410'],
        selectedUnitId: 'unit_burnaby_410',
      },
    }, deps);

    expect(result.kind).toBe('clarification');
    expect(deps.scheduleTour).not.toHaveBeenCalled();
  });

  it('schedules exactly once for an integer index in the pending operational slots', async () => {
    const slots = [pendingSlot(0), pendingSlot(1)];
    const deps = dependencies({
      getSchedulingContext: vi.fn(async () => ({ unitId: 'unit_burnaby_410', slots })),
    });

    const result = await executeRentalConversationAction({
      ...baseInput,
      state: 'scheduling',
      turn: turn('choose_slot', { slotIndex: 1 }),
      activeShortlist: {
        id: 'shortlist-1',
        unitIds: ['unit_burnaby_410'],
        selectedUnitId: 'unit_burnaby_410',
      },
    }, deps);

    expect(result.kind).toBe('reply');
    expect(deps.scheduleTour).toHaveBeenCalledTimes(1);
    expect(deps.scheduleTour).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      unitId: 'unit_burnaby_410',
      slotIndex: 1,
      slot: slots[1],
    });
  });

  it('performs no operational action for a low-confidence turn', async () => {
    const deps = dependencies();

    const result = await executeRentalConversationAction({
      ...baseInput,
      turn: {
        ...turn('choose_slot', { slotIndex: 0 }, 'low'),
        clarification: { question: 'Which time did you mean?' },
      },
    }, deps);

    expect(result).toMatchObject({
      kind: 'clarification',
      reply: 'Which time did you mean?',
    });
    expect(deps.createShortlist).not.toHaveBeenCalled();
    expect(deps.getAvailableSlots).not.toHaveBeenCalled();
    expect(deps.getSchedulingContext).not.toHaveBeenCalled();
    expect(deps.scheduleTour).not.toHaveBeenCalled();
  });
});
