function bedroomNoun(value: string | undefined): string {
  if (!value) return 'the right number of bedrooms';
  if (value === '0') return 'a studio';
  if (value.endsWith('+')) return `${value} bedrooms`;
  return `${value} bedroom${value === '1' ? '' : 's'}`;
}

export function buildRentalOpeningReply(tenantName: string): string {
  return `Hi! I'm the Virtual Agent for ${tenantName}. What are you looking to do?\n\na) Rent\nb) Buy\nc) Sell`;
}

export function buildRentalIntentReply(): string {
  return "Absolutely - I'd be happy to help you find a rental. Before we look at options, what first name should I use for you?";
}

export function buildRentalNamePrompt(): string {
  return 'Before we go further, what first name should I use for you?';
}

export function buildRentalNameClarification(): string {
  return "Of course - I'm just asking what first name you'd like me to use.";
}

export function buildRentalWelcomeByName(name: string): string {
  return `Nice to meet you, ${name}. I'm here to help you find the right rental. Which city or area would work best for you?`;
}

export function buildRentalAreaQuestion(moveInDate?: string): string {
  if (moveInDate) {
    return `${moveInDate} gives us a useful starting point. Which city or area would work best for you?`;
  }
  return 'Which city or area would work best for you?';
}

export function buildRentalAreaConfirmation(area: string, province: string): string {
  return `Just to confirm, do you mean ${area}, ${province}?`;
}

export function buildRentalAreaAccepted(area: string, province: string): string {
  return `Perfect - ${area}, ${province}. How many bedrooms do you need?`;
}

export function buildRentalAreaRetry(): string {
  return 'No problem. Which city and province should I use instead?';
}

export function buildRentalBedroomsQuestion(): string {
  return 'How many bedrooms do you need?';
}

export function buildRentalPetsQuestion(bedrooms: string): string {
  const noun = bedroomNoun(bedrooms);
  const lead = noun === 'a studio'
    ? 'A studio helps narrow things down.'
    : `${noun.charAt(0).toUpperCase()}${noun.slice(1)} helps narrow things down.`;
  return `${lead} Will any pets be moving with you?\n\na) No pets\nb) Cat\nc) Dog\nd) Other`;
}

export function buildRentalPetFollowup(): string {
  return 'Got it. What kind of pet should I keep in mind?';
}

export function buildRentalBudgetQuestion(pets: string | undefined): string {
  if (pets === 'none') return 'Good to know - no pets. What monthly rent range would feel comfortable for you?';
  if (pets === 'other') return 'Thanks - I will keep pet-friendly buildings in mind. What monthly rent range would feel comfortable for you?';
  return `Thanks - I'll keep pet-friendly homes in mind for your ${pets}. What monthly rent range would feel comfortable for you?`;
}

export function buildRentalMoveInQuestion(amount: string): string {
  return `$${Number(amount).toLocaleString('en-CA')} per month - that helps narrow things down. When would you ideally like to move?`;
}

export function buildRentalMoveInAcknowledgement(moveInTiming: string): string {
  const lead = moveInTiming === 'As soon as possible'
    ? 'Got it - as soon as possible.'
    : `Thanks, ${moveInTiming}.`;
  return `${lead} I'll show you the best available matches.`;
}

export function buildRentalNoInventoryAreaPriorityReply(
  area: string,
  bedroomsLabel: string,
  budgetLabel: string,
): string {
  return `I couldn't find a ${bedroomsLabel} home in ${area} at ${budgetLabel} right now. Do you want to keep ${area} as your top priority?`;
}

export function buildRentalAreaPriorityBudgetReply(area: string): string {
  return `Understood - we'll keep ${area} fixed. What maximum budget per month would you be comfortable with?`;
}

export function buildRentalSameBudgetLoopReply(
  area: string,
  currentBudget: string,
  bedroomsLabel: string,
): string {
  return `Thanks for confirming. At $${Number(currentBudget).toLocaleString('en-CA')}/month I still don't have a ${bedroomsLabel} home in ${area}. Would you like me to look in a nearby city instead?`;
}
