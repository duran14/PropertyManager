import { Prisma } from '@prisma/client';
import type { ConversationActivityTone } from '@property-manager/core/conversation-activity';
import { prisma } from '../config/db.js';

export type ConversationEventType =
  | 'lead.status_changed'
  | 'unit.recommended_overridden'
  | 'showing.scheduled'
  | 'showing.confirmed'
  | 'showing.cancelled'
  | 'staff.reply_sent'
  | 'handoff.requested';

export interface CreateConversationEventInput {
  tenantId: string;
  conversationId: string;
  leadId?: string | null;
  actorUserId?: string | null;
  type: ConversationEventType;
  payload?: Record<string, unknown>;
}

interface ConversationEventRepository {
  conversationEvent: {
    create(input: {
      data: {
        tenantId: string;
        conversationId: string;
        leadId?: string | null;
        actorUserId?: string | null;
        type: string;
        label: string;
        detail: string;
        tone: ConversationActivityTone;
        payload: Prisma.InputJsonValue;
      };
    }): Promise<unknown>;
  };
}

export async function createConversationEvent(
  input: CreateConversationEventInput,
  repository: ConversationEventRepository = prisma,
) {
  const presentation = buildConversationEventPresentation(input.type, input.payload ?? {});

  return repository.conversationEvent.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      leadId: input.leadId ?? null,
      actorUserId: input.actorUserId ?? null,
      type: input.type,
      label: presentation.label,
      detail: presentation.detail,
      tone: presentation.tone,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
    },
  });
}

export function buildConversationEventPresentation(
  type: ConversationEventType,
  payload: Record<string, unknown>,
): { label: string; detail: string; tone: ConversationActivityTone } {
  switch (type) {
    case 'lead.status_changed':
      return {
        label: 'Lead status changed',
        detail: `${formatStatus(payload.fromStatus)} to ${formatStatus(payload.toStatus).toLowerCase()}`,
        tone: 'active',
      };
    case 'unit.recommended_overridden':
      return {
        label: 'Unit recommendation changed',
        detail: formatText(payload.unitLabel) ?? 'Staff selected a different unit',
        tone: 'done',
      };
    case 'showing.scheduled':
      return {
        label: 'Tour scheduled',
        detail: formatDateTime(payload.scheduledAt) ?? 'Staff created a showing',
        tone: 'active',
      };
    case 'showing.confirmed':
      return {
        label: 'Tour confirmed',
        detail: formatDateTime(payload.scheduledAt) ?? 'Staff confirmed the showing',
        tone: 'done',
      };
    case 'showing.cancelled':
      return {
        label: 'Tour cancelled',
        detail: formatDateTime(payload.scheduledAt) ?? 'Staff cancelled the showing',
        tone: 'attention',
      };
    case 'staff.reply_sent':
      return {
        label: 'Staff replied',
        detail: truncate(formatText(payload.message) ?? 'Manual reply sent'),
        tone: 'neutral',
      };
    case 'handoff.requested':
      return {
        label: 'Human handoff requested',
        detail: formatText(payload.reason) ?? 'Conversation needs staff attention',
        tone: 'attention',
      };
  }
}

function formatStatus(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return 'unknown';
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function truncate(value: string): string {
  return value.length > 64 ? `${value.slice(0, 61)}...` : value;
}

function formatDateTime(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-CA', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
