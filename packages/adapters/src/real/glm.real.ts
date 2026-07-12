import type {
  GlmAdapter,
  GlmReasoningRequest,
  GlmReasoningResponse,
  OcrResult,
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
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.reasoningModel,
        temperature: request.temperature ?? 0.3,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
        response_format: request.responseSchema
          ? { type: 'json_schema', json_schema: { name: 'response', schema: request.responseSchema } }
          : undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`GLM reasoning request failed: ${response.status}`);
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
}
