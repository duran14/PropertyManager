export interface ShowingSuggestedReplyInput {
  action: 'confirmed' | 'cancelled';
  scheduledAt: string;
  unitName: string;
  propertyName: string;
}

export function buildShowingSuggestedReply(input: ShowingSuggestedReplyInput): string {
  const listingName = `${input.propertyName} ${input.unitName}`.trim();

  if (input.action === 'cancelled') {
    return `No problem, we can reschedule your tour for ${listingName}. Would another morning or afternoon work better for you?`;
  }

  return `Your tour is confirmed for ${formatTourDateTime(input.scheduledAt)} at ${listingName}. We look forward to seeing you.`;
}

export function stageSuggestedReply(currentReply: string, suggestion: string): {
  reply: string;
  pendingSuggestion: string | null;
} {
  if (currentReply.trim().length === 0) {
    return { reply: suggestion, pendingSuggestion: null };
  }
  return { reply: currentReply, pendingSuggestion: suggestion };
}

function formatTourDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-CA', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
