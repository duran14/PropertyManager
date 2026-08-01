/**
 * Mock GLM adapter for local development and demos.
 *
 * It simulates:
 * - structured chatbot replies when a response schema is provided;
 * - free-form reasoning for non-chatbot callers;
 * - deterministic receipt extraction for Bills tests.
 *
 * The chatbot replies rotate between variants so a live conversation does not
 * sound repetitive, and they disclose the AI nature early (per the project's
 * handoff decision: warm but never pretending to be human).
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
        const generated = this.generateChatbotResponse(request.userPrompt);
        const currentMessage = this.extractCurrentMessage(request.userPrompt);
        const selectsAll = /\b(?:both|all(?:\s+of\s+them)?)\b/i.test(currentMessage);
        const selectedOptions = [...currentMessage.matchAll(/\b(?:option\s*)?([123])\b/gi)]
          .map((match) => Number(match[1]));
        return {
          content: JSON.stringify({
            intent: selectsAll || selectedOptions.length > 0
              ? 'select_options'
              : /what else|anything else|other options/i.test(currentMessage)
                ? 'request_more_options'
                : generated.next_state === 'proposing_tour'
                  ? 'request_matches'
                  : generated.next_state === 'scheduling'
                    ? 'schedule_tour'
                    : 'provide_information',
            ...(selectsAll ? { selection_scope: 'all' } : {}),
            ...(selectedOptions.length > 0 ? { selected_options: selectedOptions } : {}),
            ...generated,
          }),
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
    const currentState = this.extractCurrentState(userPrompt);
    const agencyName = this.extractAgencyName(userPrompt) ?? 'our property management company';
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
    const bedrooms = this.extractBedrooms(currentMessage) ?? this.extractFromContext(userPrompt, 'bedrooms');
    const wantsTour = /showing|tour|view|visit|appointment|schedule|book|yes|sounds good|that works|available time|sure|okay/i.test(currentMessage);
    const needsHuman = /human|person|agent|broker|manager|legal|law|contract|lease terms|complaint|emergency|speak to|talk to/i.test(currentMessage);
    const isCasualGreeting = /^(hi|hello|hey|good morning|good afternoon|good evening|hola|howdy)\b/i.test(currentMessage.trim());
    // Comandos de inicio de plataforma (Telegram /start, /help) significan
    // "empezar de cero": forzan el saludo con presentación sin importar el estado.
    const isStartCommand = /^\/(start|begin|hola|hello|hi|help)(\b|$)/i.test(currentMessage.trim());

    const slots: Record<string, string> = {};
    if (budget) slots.budget = budget;
    if (moveInDate) slots.move_in_date = moveInDate;
    if (preferredArea) slots.preferred_area = preferredArea;
    if (occupants) slots.occupants = occupants;
    if (pets) slots.pets = pets;
    if (bedrooms) slots.bedrooms = bedrooms;

    // Handoff tiene prioridad absoluta.
    if (needsHuman) {
      return {
        reply: this.pick([
          `Of course. I'm the Virtual Agent for ${agencyName}, but for that I'd like to connect you with a member of our team. Let me flag this so the right person reaches out.`,
          `Absolutely — that's best handled by a person. I'll hand this over to our leasing team at ${agencyName} so they can help you properly.`,
          `Happy to get someone involved. I'll pass this to our team at ${agencyName} and they'll take it from here.`,
        ]),
        slots,
        next_state: 'handoff',
      };
    }

    // SALUDO: siempre presentarse cordialmente al iniciar, sin pedir budget de golpe.
    // Se dispara en estado greeting, con un saludo casual, o con un comando de
    // inicio (/start) que significa "empezar de cero" sin importar el estado actual.
    if (currentState === 'greeting' || isStartCommand || (isCasualGreeting && !budget && !moveInDate)) {
      return {
        reply: this.pick([
          `Hi there! I'm the Virtual Agent for ${agencyName}. Are you looking to rent, buy, or sell a property?`,
          `Hello! Welcome to ${agencyName}. I'm the Virtual Agent here — are you interested in renting, buying, or selling?`,
          `Hey, thanks for reaching out to ${agencyName}! I'm the Virtual Agent. Are you looking to rent, buy, or sell?`,
          `Good to hear from you! I'm the Virtual Agent at ${agencyName}. Would you like help renting, buying, or selling a property?`,
        ]),
        slots,
        next_state: 'greeting',
      };
    }

    // ===== Calificación progresiva =====
    // El bot va preguntando lo que falte, en orden natural, antes de proponer.
    // Si el prospecto lo da todo de golpe en un mensaje, se captura y se salta.

    // 1. Budget (si no lo tenemos)
    if (!budget) {
      return {
        reply: this.pick([
          `That helps, thanks! So I can point you to the right homes, what monthly rent works for your budget?`,
          `Got it. To narrow things down, what monthly rent range are you comfortable with?`,
          `Thanks for sharing that. What monthly budget should I keep in mind while I look?`,
        ]),
        slots,
        next_state: 'collecting_budget',
      };
    }

    // 2. Move-in (si tenemos budget pero no fecha)
    if (budget && !moveInDate) {
      const budgetText = this.formatBudget(budget);
      return {
        reply: this.pick([
          `Great, around $${budgetText}/month works. When are you hoping to move in?`,
          `Perfect — $${budgetText} a month gives us good options. What move-in date are you thinking?`,
          `Got it, $${budgetText}/month. And when would you ideally like to move in?`,
        ]),
        slots,
        next_state: 'collecting_movein',
      };
    }

    // 3. Área/ubicación (si tenemos budget + move-in pero no ubicación)
    if (budget && moveInDate && !preferredArea) {
      return {
        reply: this.pick([
          `Got it, ${moveInDate}. And which area or neighborhood are you hoping to live in? Vancouver, Burnaby, Surrey, Richmond, Kelowna?`,
          `Great, ${moveInDate} works. Where would you ideally like to live? Any specific city or area in mind?`,
          `Thanks! Any particular area you're drawn to? We have homes across Greater Vancouver, the Valley, and the Okanagan.`,
        ]),
        slots,
        next_state: 'collecting_movein',
      };
    }

    // 4. Tamaño / habitaciones (si tenemos ubicación pero no bedrooms)
    if (budget && moveInDate && preferredArea && !bedrooms) {
      return {
        reply: this.pick([
          `Nice, ${preferredArea} is a great area. How many bedrooms are you looking for — a studio, 1, 2, or 3 beds?`,
          `Great choice with ${preferredArea}. What size works for you? Just yourself, or how many people/bedrooms do you need?`,
          `${preferredArea} has some lovely options. How big a place do you need — how many bedrooms?`,
        ]),
        slots,
        next_state: 'collecting_movein',
      };
    }

    // 5. Mascotas (si tenemos bedrooms pero no info de mascotas)
    if (budget && moveInDate && preferredArea && bedrooms && !pets) {
      return {
        reply: this.pick([
          `Got it, ${bedrooms} bedroom(s). Do you have any pets I should know about? Some of our buildings are pet-friendly.`,
          `Perfect. And pets — do you have any? A cat, dog, or none? Some units allow them.`,
          `Thanks! One more thing — do you have any pets? It helps me pick buildings with the right policy.`,
        ]),
        slots,
        next_state: 'collecting_movein',
      };
    }

    // 6. Si el prospecto pide tour explícitamente, ir a scheduling.
    if (wantsTour && budget && moveInDate) {
      return {
        reply: this.pick([
          `Love it. Let me pull up the available tour times for you.`,
          `Great! I'll find some open slots so you can come see the place.`,
          `Perfect — let me grab the available tour times and I'll share them here.`,
        ]),
        slots,
        next_state: 'scheduling',
      };
    }

    // 7. Ya tenemos todo lo esencial: proponer unidades.
    if (budget && moveInDate && preferredArea && bedrooms) {
      const petsText = pets && pets !== 'none' ? ` I'll also keep your ${pets} in mind.` : '';
      return {
        reply: this.pick([
          `Based on what you've told me, I've got a few available homes near ${preferredArea} that could be a great fit.${petsText} Would you like to come see one?`,
          `Good news — there are some available homes near ${preferredArea} that match what you're after.${petsText} Want me to set up a tour?`,
          `With that budget and what you're looking for, a few homes near ${preferredArea} stand out.${petsText} Shall I arrange a viewing?`,
        ]),
        slots,
        next_state: 'proposing_tour',
      };
    }

    if (wantsTour) {
      return {
        reply: this.pick([
          `Sure thing! Let me find some open tour times for you.`,
          `Happy to set that up. I'll pull the available slots.`,
          `Of course — let me grab the open tour times and share them here.`,
        ]),
        slots,
        next_state: 'scheduling',
      };
    }

    // Recolectar presupuesto de forma natural cuando el prospecto ya describió qué busca.
    return {
      reply: this.pick([
        `That helps, thanks! So I can point you to the right homes, what monthly rent works for your budget?`,
        `Got it. To narrow things down, what monthly rent range are you comfortable with?`,
        `Thanks for sharing that. What monthly budget should I keep in mind while I look?`,
      ]),
      slots,
      next_state: 'collecting_budget',
    };
  }

  private extractCurrentState(prompt: string): string | undefined {
    const match = prompt.match(/Current conversation state:\s*(\w+)/i);
    return match?.[1];
  }

  private extractAgencyName(prompt: string): string | undefined {
    const match = prompt.match(/^Agency:\s*(.+)$/m);
    return match?.[1]?.trim();
  }

  private pick(options: string[]): string {
    // Deterministic rotation keeps tests stable while avoiding repetition in
    // live demos: each call advances the index within a single adapter run.
    this.replyIndex = (this.replyIndex + 1) % options.length;
    return options[this.replyIndex];
  }

  private replyIndex = -1;

  private formatBudget(value: string): string {
    return Number(value).toLocaleString('en-CA');
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

  private extractBedrooms(message: string): string | undefined {
    // "2 bedrooms", "2-bed", "1 bed", "3 bedroom", "studio"
    if (/\bstudio\b/i.test(message)) return '0';
    const match = message.match(/\b(\d)\s*(?:beds?|bedrooms?|br)\b/i);
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
