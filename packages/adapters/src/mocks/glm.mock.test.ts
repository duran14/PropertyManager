import { describe, expect, it } from 'vitest';
import { GlmMockAdapter } from './glm.mock.js';

const chatbotSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    slots: { type: 'object' },
    next_state: { type: 'string' },
  },
  required: ['reply', 'next_state'],
} as const;

async function getChatbotReply(userPrompt: string) {
  const adapter = new GlmMockAdapter();
  const result = await adapter.reason({
    systemPrompt: 'Current conversation state: greeting',
    userPrompt,
    responseSchema: chatbotSchema,
    temperature: 0.7,
  });
  return JSON.parse(result.content) as {
    reply: string;
    slots: Record<string, string>;
    next_state: string;
  };
}

describe('GlmMockAdapter chatbot flow', () => {
  it('greets with an introduction as the Virtual Agent of the agency on first contact', async () => {
    const result = await getChatbotReply(
      'Agency: Pacific Ridge Property Management\nHistory:\n\nCurrent user message: hi',
    );

    expect(result.next_state).toBe('greeting');
    expect(result.reply.toLowerCase()).toContain('virtual agent');
    expect(result.reply).toContain('Pacific Ridge Property Management');
    expect(result.reply.toLowerCase()).toMatch(/rent/);
    expect(result.reply.toLowerCase()).toMatch(/buy/);
    expect(result.reply.toLowerCase()).toMatch(/sell/);
    // The greeting must NOT jump straight to asking for budget.
    expect(result.reply.toLowerCase()).not.toContain('what monthly rent budget');
    expect(result.reply.toLowerCase()).not.toContain('what monthly budget');
  });

  it('does not repeat the budget question when the prospect already gave a budget', async () => {
    const result = await getChatbotReply(
      'Agency: Pacific Ridge Property Management\nHistory:\nuser: hi\nassistant: Hi there! I\'m the Virtual Agent.\n\nKnown user information:\n  budget: 2600\n\nCurrent conversation state: collecting_budget\nCurrent user message: 2500',
    );

    // Budget is captured, so the bot should move on to move-in, not re-ask budget.
    expect(result.slots.budget).toBe('2500');
    expect(result.next_state).toBe('collecting_movein');
    expect(result.reply.toLowerCase()).toContain('move in');
  });

  it('extracts move-in timing, area, bedrooms, and pets before proposing a tour', async () => {
    const result = await getChatbotReply(
      'Agency: Pacific Ridge Property Management\nKnown user information:\n  budget: 2600\n  move_in_date: August\n  preferred_area: Burnaby\n\nCurrent conversation state: collecting_movein\nCurrent user message: 2 bedrooms, one cat.',
    );

    expect(result.slots).toMatchObject({
      budget: '2600',
      move_in_date: 'August',
      preferred_area: 'Burnaby',
      pets: 'cat',
      bedrooms: '2',
    });
    expect(result.next_state).toBe('proposing_tour');
  });

  it('asks for area after budget and move-in are known', async () => {
    const result = await getChatbotReply(
      'Agency: Pacific Ridge Property Management\nKnown user information:\n  budget: 2600\n  move_in_date: August\n\nCurrent conversation state: collecting_movein\nCurrent user message: sounds good',
    );

    expect(result.next_state).toBe('collecting_movein');
    expect(result.reply.toLowerCase()).toContain('area');
  });

  it('asks for bedrooms after area is known', async () => {
    const result = await getChatbotReply(
      'Agency: Pacific Ridge Property Management\nKnown user information:\n  budget: 2600\n  move_in_date: August\n  preferred_area: Burnaby\n\nCurrent conversation state: collecting_movein\nCurrent user message: okay',
    );

    expect(result.next_state).toBe('collecting_movein');
    expect(result.reply.toLowerCase()).toMatch(/bedroom|bed|size/);
  });

  it('asks about pets after bedrooms are known', async () => {
    const result = await getChatbotReply(
      'Agency: Pacific Ridge Property Management\nKnown user information:\n  budget: 2600\n  move_in_date: August\n  preferred_area: Burnaby\n  bedrooms: 2\n\nCurrent conversation state: collecting_movein\nCurrent user message: great',
    );

    expect(result.next_state).toBe('collecting_movein');
    expect(result.reply.toLowerCase()).toMatch(/pet/);
  });

  it('hands off legal or human-agent requests', async () => {
    const result = await getChatbotReply(
      'Agency: Pacific Ridge Property Management\nCurrent user message: I need to speak with a human about legal terms',
    );

    expect(result.next_state).toBe('handoff');
    expect(result.reply).toContain('Pacific Ridge Property Management');
  });

  it('formats the budget with locale thousands separators', async () => {
    const result = await getChatbotReply(
      'Agency: Pacific Ridge Property Management\nCurrent conversation state: collecting_budget\nCurrent user message: My budget is $2600',
    );

    expect(result.slots.budget).toBe('2600');
    expect(result.reply).toContain('$2,600');
  });

  it('rotates reply variants so a live conversation does not repeat verbatim', async () => {
    const adapter = new GlmMockAdapter();
    const call = () =>
      adapter
        .reason({
          systemPrompt: 'Current conversation state: collecting_budget',
          userPrompt: 'Current user message: My budget is $2400',
          responseSchema: chatbotSchema,
          temperature: 0.7,
        })
        .then((res) => (JSON.parse(res.content) as { reply: string }).reply);

    const first = await call();
    const second = await call();
    const third = await call();

    // Three distinct variants exist for the collecting_movein branch.
    expect(new Set([first, second, third]).size).toBe(3);
    expect(first).toContain('move in');
  });
});
