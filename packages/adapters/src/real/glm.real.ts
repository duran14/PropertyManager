import type {
  CreditReportExtraction,
  GlmAdapter,
  GlmReasoningRequest,
  GlmReasoningResponse,
  OcrResult,
  ScreeningReportExtraction,
} from '../contracts.js';

export class GlmRealAdapter implements GlmAdapter {
  readonly name = 'glm' as const;

  constructor(
    private config: {
      apiKey: string;
      baseUrl: string;
      reasoningModel: string;
      ocrModel: string;
    },
  ) {}

  async reason(request: GlmReasoningRequest): Promise<GlmReasoningResponse> {
    // Turnos con más historial/contexto (conversación avanzada) tardan más de
    // 6s en generar; 6s cortaba llamadas legítimas en curso, no solo colgadas
    // (visto en prueba manual: "DOMException [TimeoutError]" consistente en
    // conversaciones avanzadas). 15s x 2 intentos da margen real sin volver al
    // peor caso original de ~25s.
    const maxAttempts = 2;
    const timeoutMs = 15_000;
    let response: Response | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.reasoningModel,
          temperature: request.temperature ?? 0.3,
          max_tokens: 350,
          thinking: { type: 'disabled' },
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userPrompt },
          ],
          response_format: request.responseSchema
            ? { type: 'json_object' }
            : undefined,
        }),
      });

      if (response.ok || !isTransientStatus(response.status) || attempt === maxAttempts - 1) break;
      await sleep(250 * (attempt + 1));
    }

    if (!response?.ok) {
      throw new Error(`GLM reasoning request failed: ${response?.status ?? 'no response'}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return { content: body.choices?.[0]?.message?.content ?? '' };
  }

  async extractReceipt(input: { mimeType: string; base64: string; filename?: string }): Promise<OcrResult> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.ocrModel,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extract this receipt as JSON.' },
              {
                type: 'image_url',
                image_url: { url: `data:${input.mimeType};base64,${input.base64}` },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`GLM OCR request failed: ${response.status}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as OcrResult;
  }

  async extractCreditReport(input: { mimeType: string; base64: string; filename?: string }): Promise<CreditReportExtraction> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.ocrModel,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'This is a tenant credit report PDF. Find the credit score gauge (a number roughly 300-900) and the "AI Summary" section text. Respond as JSON: {"score": number|null, "aiSummaryText": string, "confidence": number between 0 and 1}.',
              },
              {
                type: 'image_url',
                image_url: { url: `data:${input.mimeType};base64,${input.base64}` },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`GLM credit report OCR request failed: ${response.status}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as CreditReportExtraction;
  }

  async extractScreeningReport(input: {
    mimeType: string;
    base64: string;
    filename?: string;
    kind: 'credit' | 'criminal';
  }): Promise<ScreeningReportExtraction> {
    const kindLabel = input.kind === 'credit' ? 'credit report' : 'criminal background check';
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.ocrModel,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `This is a tenant ${kindLabel} PDF for a rental applicant. Read it and summarize the key findings in 2-4 sentences. Based on the content, decide a verdict: "passed" if the report shows no significant concerns (good credit standing / no criminal record found), "flagged" if it shows concerns worth human review (poor credit standing, collections, evictions / a criminal record found). If you cannot determine either from the document, use null. Respond as JSON: {"verdict": "passed"|"flagged"|null, "summaryText": string, "confidence": number between 0 and 1}.`,
              },
              {
                type: 'image_url',
                image_url: { url: `data:${input.mimeType};base64,${input.base64}` },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`GLM screening report OCR request failed: ${response.status}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as ScreeningReportExtraction;
  }
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
