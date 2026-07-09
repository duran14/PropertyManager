/**
 * Mock del adapter GLM (Z.ai).
 *
 * Simula respuestas plausibles:
 *  - reason() con responseSchema: devuelve JSON estructurado (para el chatbot FSM).
 *  - reason() sin schema: devuelve texto libre (para el Sentinel).
 *  - extractReceipt(): parsea un recibo determinista.
 *
 * Cuando se tenga ZAI_API_KEY, el adapter real toma su lugar.
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
    // Si hay responseSchema, el llamador espera JSON estructurado.
    if (request.responseSchema) {
      // Detectar si es el chatbot (pide reply + slots + next_state).
      const props = request.responseSchema.properties as Record<string, unknown> | undefined;
      if (props && 'next_state' in props) {
        return {
          content: JSON.stringify(this.generateChatbotResponse(request.userPrompt)),
          selfReportedConfidence: 0.85,
        };
      }
      // Sentinel: pide confidence scoring.
      return {
        content: JSON.stringify({
          amountMatch: 0.97,
          dateProximity: 1.0,
          senderMatches: false,
          priorHistory: true,
          rationale: 'Monto coincide pero remitente no verificado.',
        }),
        selfReportedConfidence: 0.5,
      };
    }
    return {
      content: 'Respuesta simulada del agente GLM.',
      selfReportedConfidence: 0.8,
    };
  }

  /**
   * Genera una respuesta estructurada del chatbot simulada.
   * Infiere el estado y los slots del mensaje del usuario.
   * Ahora parsea los slots existentes del prompt (pasados como contexto).
   */
  private generateChatbotResponse(userPrompt: string): {
    reply: string;
    slots: Record<string, string>;
    next_state: string;
  } {
    const msg = userPrompt.toLowerCase();

    // Extraer slots existentes del contexto (el chatbot los pasa en el historial).
    const existingBudget = this.extractFromContext(userPrompt, 'budget');
    const existingMoveIn = this.extractFromContext(userPrompt, 'move_in_date');

    // Extraer presupuesto del mensaje actual (ej: "$2000", "2000", "2k")
    const budgetMatch = msg.match(/\$?(\d{3,5})k?/);
    const budget = budgetMatch ? budgetMatch[1] : existingBudget;

    // Extraer fecha de mudanza del mensaje actual
    const moveInMatch = msg.match(/(?:mudanza|mudarme|move|moving|mudar)[^]*?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|\d{1,2}\/\d{1,2}|pr[oó]xim)/i);
    const moveInDate = moveInMatch?.[1] ?? existingMoveIn;

    // Detectar intención de agendar visita (afirmaciones incluidas)
    const wantsTour = /visita|ver (?:la )?(?:propiedad|departamento|casa|depto)|tour|agendar|appointment|cita|sí.*visita|si.*visita|claro|dále|dale|perfecto.*visita/i.test(msg);

    const slots: Record<string, string> = {};
    if (budget) slots.budget = budget;
    if (moveInDate) slots.move_in_date = moveInDate;

    // Lógica de transición simulada.
    if (/hola|hi|hello|buenas|good morning/i.test(msg) && msg.length < 30) {
      return {
        reply: '¡Hola! Soy el asistente virtual. ¿Buscas una propiedad para alquilar? ¿Cuál es tu presupuesto mensual?',
        slots,
        next_state: 'collecting_budget',
      };
    }

    // Si ya tenemos budget pero no fecha de mudanza.
    if (budget && !moveInDate) {
      return {
        reply: `Perfecto, tienes un presupuesto de $${budget}/mes. ¿Para cuándo te gustaría mudarte?`,
        slots,
        next_state: 'collecting_movein',
      };
    }

    // Si pide visita y ya tenemos budget + fecha → ir a scheduling directo.
    if (wantsTour && budget && moveInDate) {
      return {
        reply: '¡Genial! Voy a buscar los horarios disponibles para que visites la propiedad.',
        slots,
        next_state: 'scheduling',
      };
    }

    // Si tenemos budget + fecha → proponer unidades.
    if (budget && moveInDate) {
      return {
        reply: '¡Excelente! Tengo estas unidades que podrían interesarte:\n• Apt 101 en Vancouver: $2,400/mes\n• Apt 102 en Vancouver: $2,650/mes\n\n¿Te gustaría agendar una visita para ver alguna?',
        slots,
        next_state: 'proposing_tour',
      };
    }

    // Afirmación genérica cuando se está proponiendo tour.
    if (wantsTour) {
      return {
        reply: '¡Genial! Voy a buscar los horarios disponibles para que visites la propiedad.',
        slots,
        next_state: 'scheduling',
      };
    }

    if (/humano|persona|asesor|hablar con/i.test(msg)) {
      return {
        reply: 'Entiendo. Te conectaré con un asesor inmobiliario que te ayudará personalmente. Un momento por favor.',
        slots,
        next_state: 'handoff',
      };
    }

    return {
      reply: 'Gracias por tu mensaje. Para ayudarte mejor, ¿podrías decirme cuál es tu presupuesto mensual de alquiler?',
      slots,
      next_state: 'collecting_budget',
    };
  }

  /** Extrae un slot del contexto que el chatbot pasa en el historial/prompt. */
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
          description: 'Kitchen faucet repair — Unit 101',
          amountCents: 185_00,
          suggestedCategory: 'repairs',
        },
      ],
      confidence: 0.92,
    };
  }
}
