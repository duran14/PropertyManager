import type { AvailableUnit, ConversationState } from './chatbot.service.js';
import type { ConversationTurn, RentalProfile } from './rental-conversation.types.js';

export type PendingTourSlot = {
  index: number;
  startAt: string;
  endAt: string;
  brokerName?: string;
  label: string;
};

export type RentalActionResult =
  | { kind: 'reply'; reply: string; state: ConversationState; selectedUnitId?: string }
  | { kind: 'recommendations'; state: 'proposing_tour'; units: AvailableUnit[]; selectedUnitId?: string }
  | { kind: 'clarification'; reply: string; state: ConversationState; selectedUnitId?: string };

export type RentalConversationActionDependencies = {
  filterUnits: (units: AvailableUnit[], profile: RentalProfile) => AvailableUnit[];
  rankUnits: (units: AvailableUnit[], profile: RentalProfile) => AvailableUnit[];
  createShortlist: (input: {
    tenantId: string;
    conversationId: string;
    unitIds: string[];
  }) => Promise<{ id: string }>;
  selectShortlistUnit: (input: {
    tenantId: string;
    conversationId: string;
    shortlistId: string;
    unitId: string;
  }) => Promise<void>;
  getAvailableSlots: (input: {
    tenantId: string;
    conversationId: string;
    unitId: string;
  }) => Promise<PendingTourSlot[]>;
  saveSchedulingContext: (input: {
    tenantId: string;
    conversationId: string;
    unitId: string;
    slots: PendingTourSlot[];
  }) => Promise<void>;
  getSchedulingContext: (input: {
    tenantId: string;
    conversationId: string;
  }) => Promise<{ unitId: string; slots: PendingTourSlot[] } | null>;
  scheduleTour: (input: {
    tenantId: string;
    conversationId: string;
    unitId: string;
    slotIndex: number;
    slot: PendingTourSlot;
  }) => Promise<{ scheduledAt: string }>;
};

export type RentalConversationActionInput = {
  tenantId: string;
  conversationId: string;
  state: ConversationState;
  turn: ConversationTurn;
  profile: RentalProfile;
  availableUnits: AvailableUnit[];
  activeShortlist?: { id: string; unitIds: string[]; selectedUnitId: string | null } | null;
};

function clarification(
  input: RentalConversationActionInput,
  reply: string,
  selectedUnitId?: string,
): RentalActionResult {
  return {
    kind: 'clarification',
    reply,
    state: input.state,
    ...(selectedUnitId ? { selectedUnitId } : {}),
  };
}

function isKnownUnit(input: RentalConversationActionInput, unitId: string): boolean {
  return input.availableUnits.some((unit) => unit.id === unitId);
}

export async function executeRentalConversationAction(
  input: RentalConversationActionInput,
  dependencies: RentalConversationActionDependencies,
): Promise<RentalActionResult> {
  if (input.turn.confidence === 'low') {
    return clarification(
      input,
      input.turn.clarification?.question ?? input.turn.reply,
      input.activeShortlist?.selectedUnitId ?? undefined,
    );
  }

  if (input.turn.intent === 'discover') {
    const matchingUnits = dependencies.rankUnits(
      dependencies.filterUnits(input.availableUnits, input.profile),
      input.profile,
    ).slice(0, 3);

    if (matchingUnits.length === 0) {
      return { kind: 'reply', reply: input.turn.reply, state: input.state };
    }

    await dependencies.createShortlist({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      unitIds: matchingUnits.map((unit) => unit.id),
    });
    return { kind: 'recommendations', state: 'proposing_tour', units: matchingUnits };
  }

  if (input.turn.intent === 'select_unit') {
    const selectedIds = input.turn.selection?.unitIds ?? [];
    const selectedUnitId = selectedIds.length === 1 ? selectedIds[0] : undefined;
    const shortlist = input.activeShortlist;
    if (
      !selectedUnitId
      || !shortlist
      || !shortlist.unitIds.includes(selectedUnitId)
      || !isKnownUnit(input, selectedUnitId)
    ) {
      return clarification(input, 'Which option would you like?');
    }

    await dependencies.selectShortlistUnit({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      shortlistId: shortlist.id,
      unitId: selectedUnitId,
    });
    return {
      kind: 'reply',
      reply: input.turn.reply,
      state: 'proposing_tour',
      selectedUnitId,
    };
  }

  if (input.turn.intent === 'request_tour') {
    const shortlist = input.activeShortlist;
    const selectedUnitId = shortlist?.selectedUnitId ?? undefined;
    if (
      !selectedUnitId
      || !shortlist?.unitIds.includes(selectedUnitId)
      || !isKnownUnit(input, selectedUnitId)
    ) {
      return clarification(input, 'Which property would you like to visit?');
    }

    const slots = (await dependencies.getAvailableSlots({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      unitId: selectedUnitId,
    })).slice(0, 6);
    if (slots.length === 0) {
      return clarification(input, 'There are no tour times available for that property right now.', selectedUnitId);
    }

    await dependencies.saveSchedulingContext({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      unitId: selectedUnitId,
      slots,
    });
    const options = slots.map((slot, index) => `${index + 1}. ${slot.label}`).join('\n');
    return {
      kind: 'reply',
      reply: `These are the available tour times:\n\n${options}`,
      state: 'scheduling',
      selectedUnitId,
    };
  }

  if (input.turn.intent === 'choose_slot') {
    const slotIndex = input.turn.selection?.slotIndex;
    const schedulingContext = await dependencies.getSchedulingContext({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
    });
    const schedulingUnitId = schedulingContext?.unitId;
    const shortlistAllowsUnit = !input.activeShortlist
      || (schedulingUnitId ? input.activeShortlist.unitIds.includes(schedulingUnitId) : false);
    const chosenSlot = Number.isInteger(slotIndex)
      ? schedulingContext?.slots.find((slot) => slot.index === slotIndex)
      : undefined;

    if (
      slotIndex === undefined
      || !schedulingUnitId
      || !isKnownUnit(input, schedulingUnitId)
      || !shortlistAllowsUnit
      || !chosenSlot
    ) {
      return clarification(input, 'Which available tour time would you like?');
    }

    const scheduled = await dependencies.scheduleTour({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      unitId: schedulingUnitId,
      slotIndex,
      slot: chosenSlot,
    });
    return {
      kind: 'reply',
      reply: `Your tour is scheduled for ${scheduled.scheduledAt}.`,
      state: 'scheduling',
      selectedUnitId: schedulingUnitId,
    };
  }

  if (input.turn.intent === 'handoff') {
    return { kind: 'reply', reply: input.turn.reply, state: 'handoff' };
  }

  return {
    kind: 'reply',
    reply: input.turn.reply,
    state: input.state,
    ...(input.activeShortlist?.selectedUnitId
      ? { selectedUnitId: input.activeShortlist.selectedUnitId }
      : {}),
  };
}
