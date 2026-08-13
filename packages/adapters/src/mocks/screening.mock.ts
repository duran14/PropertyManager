/**
 * Mock determinista de screening. Cualquier solicitante cuyo `fullName`
 * contenga "Flagged" (sin importar mayúsculas) produce un veredicto
 * `flagged` — así las pruebas de servicio pueden ejercitar esa rama sin
 * depender de aleatoriedad. Todo lo demás produce `passed`.
 */
import type {
  ScreeningAdapter,
  ScreeningApplicantInput,
  ScreeningCheckKind,
  ScreeningRunResult,
} from '../contracts.js';

export class ScreeningMockAdapter implements ScreeningAdapter {
  readonly name = 'screening_mock' as const;

  private pending = new Map<string, { kind: ScreeningCheckKind; applicant: ScreeningApplicantInput }>();
  private counter = 0;

  async runCheck(kind: ScreeningCheckKind, input: ScreeningApplicantInput): Promise<ScreeningRunResult> {
    const providerRef = `mock_${kind}_${++this.counter}`;
    this.pending.set(providerRef, { kind, applicant: input });
    return { status: 'pending', providerRef };
  }

  async pollResult(kind: ScreeningCheckKind, providerRef: string): Promise<ScreeningRunResult> {
    const entry = this.pending.get(providerRef);
    if (!entry || entry.kind !== kind) {
      return { status: 'failed', reason: 'Unknown provider reference' };
    }
    const flagged = entry.applicant.fullName.toLowerCase().includes('flagged');
    return {
      status: 'completed',
      verdict: flagged ? 'flagged' : 'passed',
      summary: flagged
        ? `${kind === 'credit' ? 'Score 480' : '1 prior record found'} — review recommended`
        : `${kind === 'credit' ? 'Score 740, no collections' : 'No criminal record found'}`,
      reportBase64: Buffer.from(`Mock ${kind} report for ${entry.applicant.fullName}`).toString('base64'),
      reportMimeType: 'application/pdf',
    };
  }
}
