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
  it('collects budget in English and asks for move-in timing', async () => {
    const result = await getChatbotReply('Current user message: My budget is $2400');

    expect(result.slots.budget).toBe('2400');
    expect(result.next_state).toBe('collecting_movein');
    expect(result.reply).toContain('move in');
    expect(result.reply).not.toContain('mudarte');
  });

  it('extracts move-in timing, area, occupants, and pets before proposing a tour', async () => {
    const result = await getChatbotReply(
      'Known user information:\n  budget: 2600\n\nCurrent user message: I want to move in August near Burnaby. 2 occupants and one cat.',
    );

    expect(result.slots).toMatchObject({
      budget: '2600',
      move_in_date: 'August',
      preferred_area: 'Burnaby',
      occupants: '2',
      pets: 'cat',
    });
    expect(result.next_state).toBe('proposing_tour');
    expect(result.reply).toContain('available homes');
  });

  it('hands off legal or human-agent requests', async () => {
    const result = await getChatbotReply('Current user message: I need to speak with a human about legal terms');

    expect(result.next_state).toBe('handoff');
    expect(result.reply).toContain('human leasing specialist');
  });
});
