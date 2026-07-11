/**
 * Mock GLM adapter for local development and demos.
 *
 * It simulates:
 * - structured chatbot replies when a response schema is provided;
 * - free-form reasoning for non-chatbot callers;
 * - deterministic receipt extraction for Bills tests.
 */
import type {
  GlmAdapter,
  GlmReasoningRequest,
  GlmReasoningResponse,
  OcrResult,
} from '../contracts.js';

export class GlmMockAdapter implements GlmAdapter {
  readonly name = 'glm' as const;

  async reason(request: GlmReasoningRequest): Promise<GlmReasoningResponse> {
    if (request.responseSchema) {
      const props = request.responseSchema.properties as Record<string, unknown> | undefined;
      if (props && 'next_state' in props) {
        return {
          content: JSON.stringify(this.generateChatbotResponse(request.userPrompt)),
          selfReportedConfidence: 0.85,
        };
      }

      return {
        content: JSON.stringify({
          amountMatch: 0.97,
          dateProximity: 1.0,
          senderMatches: false,
          priorHistory: true,
          rationale: 'Amount matches, but sender is not verified.',
        }),
        selfReportedConfidence: 0.5,
      };
    }

    return {
      content: 'Simulated GLM agent response.',
      selfReportedConfidence: 0.8,
    };
  }

  private generateChatbotResponse(userPrompt: string): {
    reply: string;
    slots: Record<string, string>;
    next_state: string;
  } {
    const currentMessage = this.extractCurrentMessage(userPrompt);
    const existingBudget = this.extractFromContext(userPrompt, 'budget');
    const existingMoveIn = this.extractFromContext(userPrompt, 'move_in_date');
    const existingArea = this.extractFromContext(userPrompt, 'preferred_area');
    const existingOccupants = this.extractFromContext(userPrompt, 'occupants');
    const existingPets = this.extractFromContext(userPrompt, 'pets');

    const budget = this.extractBudget(currentMessage) ?? existingBudget;
    const moveInDate = this.extractMoveInDate(currentMessage) ?? existingMoveIn;
    const preferredArea = this.extractPreferredArea(currentMessage) ?? existingArea;
    const occupants = this.extractOccupants(currentMessage) ?? existingOccupants;
    const pets = this.extractPets(currentMessage) ?? existingPets;
    const wantsTour = /showing|tour|view|visit|appointment|schedule|book|yes|sounds good|that works|available time/i.test(currentMessage);
    const needsHuman = /human|person|agent|broker|manager|legal|law|contract|lease terms|complaint|emergency/i.test(currentMessage);

    const slots: Record<string, string> = {};
    if (budget) slots.budget = budget;
    if (moveInDate) slots.move_in_date = moveInDate;
    if (preferredArea) slots.preferred_area = preferredArea;
    if (occupants) slots.occupants = occupants;
    if (pets) slots.pets = pets;

    if (needsHuman) {
      return {
        reply: 'I can connect you with a human leasing specialist for that. I will flag this conversation for follow-up.',
        slots,
        next_state: 'handoff',
      };
    }

    if (/hi|hello|good morning|good afternoon|hey/i.test(currentMessage) && currentMessage.length < 40) {
      return {
        reply: 'Hi, I am the virtual leasing assistant. What type of home are you looking for, and what monthly budget should I keep in mind?',
        slots,
        next_state: 'collecting_budget',
      };
    }

    if (budget && !moveInDate) {
      return {
        reply: `Great, I will look around $${budget}/month. When would you like to move in?`,
        slots,
        next_state: 'collecting_movein',
      };
    }

    if (wantsTour && budget && moveInDate) {
      return {
        reply: 'Great. I will look for available tour times and send you the best options here.',
        slots,
        next_state: 'scheduling',
      };
    }

    if (budget && moveInDate) {
      const areaText = preferredArea ? ` near ${preferredArea}` : '';
      const petsText = pets && pets !== 'none' ? ` I will also keep your ${pets} in mind.` : '';
      return {
        reply: `Thanks. Based on your budget and move-in timing, I found a few available homes${areaText} that may fit.${petsText} Would you like to schedule a tour?`,
        slots,
        next_state: 'proposing_tour',
      };
    }

    if (wantsTour) {
      return {
        reply: 'Great. I will look for available tour times and send you the best options here.',
        slots,
        next_state: 'scheduling',
      };
    }

    return {
      reply: 'Thanks for your message. To help narrow this down, what monthly rent budget should I use?',
      slots,
      next_state: 'collecting_budget',
    };
  }

  private extractCurrentMessage(prompt: string): string {
    const match = prompt.match(/Current user message:\s*([\s\S]*)$/i);
    return (match?.[1] ?? prompt).trim();
  }

  private extractBudget(message: string): string | undefined {
    const decimalK = message.match(/\$?\s*(\d(?:\.\d)?)\s*k\b/i);
    if (decimalK) {
      return String(Math.round(Number(decimalK[1]) * 1000));
    }
    const match = message.match(/\$?\s*(\d{3,5})\b/);
    return match?.[1];
  }

  private extractMoveInDate(message: string): string | undefined {
    const match = message.match(/\b(today|tomorrow|asap|immediately|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2})\b/i);
    return match ? this.titleCase(match[1]) : undefined;
  }

  private extractPreferredArea(message: string): string | undefined {
    const preferred = message.match(/\b(?:near|around|by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
    if (preferred) return preferred[1];

    const inMatch = message.match(/\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
    const value = inMatch?.[1];
    if (!value || this.isMonth(value)) return undefined;
    return value;
  }

  private extractOccupants(message: string): string | undefined {
    const match = message.match(/\b(\d+)\s+(?:occupants?|people|adults?|tenants?)\b/i);
    return match?.[1];
  }

  private extractPets(message: string): string | undefined {
    if (/\bno pets?\b/i.test(message)) return 'none';
    const match = message.match(/\b(cat|dog|pet|pets)\b/i);
    return match ? match[1].toLowerCase() : undefined;
  }

  private titleCase(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  }

  private isMonth(value: string): boolean {
    return /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(value);
  }

  private extractFromContext(prompt: string, key: string): string | undefined {
    const match = prompt.match(new RegExp(`${key}:\\s*([^\\s\\n]+)`, 'i'));
    return match?.[1];
  }

  async extractReceipt(_input: {
    mimeType: string;
    base64: string;
    filename?: string;
  }): Promise<OcrResult> {
    return {
      vendorName: 'Acme Plumbing Ltd.',
      billDate: '2026-07-01',
      totalCents: 185_00,
      currency: 'CAD',
      lineItems: [
        {
          description: 'Kitchen faucet repair - Unit 101',
          amountCents: 185_00,
          suggestedCategory: 'repairs',
        },
      ],
      confidence: 0.92,
    };
  }
}
