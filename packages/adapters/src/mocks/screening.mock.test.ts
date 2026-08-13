import { describe, expect, it } from 'vitest';
import { ScreeningMockAdapter } from './screening.mock.js';

const APPLICANT = {
  fullName: 'Ana Prospect',
  dateOfBirth: '1990-05-15',
  currentAddress: '123 Test St',
  currentCity: 'Vancouver',
  currentProvince: 'British Columbia',
  currentPostalCode: 'V6B 1A1',
};

describe('ScreeningMockAdapter', () => {
  it('devuelve pending al enviar, luego completed al sondear', async () => {
    const adapter = new ScreeningMockAdapter();
    const sent = await adapter.runCheck('credit', APPLICANT);
    expect(sent.status).toBe('pending');
    if (sent.status !== 'pending') return;

    const polled = await adapter.pollResult('credit', sent.providerRef);
    expect(polled.status).toBe('completed');
    if (polled.status !== 'completed') return;
    expect(['passed', 'flagged']).toContain(polled.verdict);
    expect(polled.reportMimeType).toBe('application/pdf');
  });

  it('sondear una referencia desconocida devuelve failed', async () => {
    const adapter = new ScreeningMockAdapter();
    const result = await adapter.pollResult('criminal', 'no_existe');
    expect(result.status).toBe('failed');
  });

  it('el nombre "flagged" en el nombre completo produce un veredicto flagged determinista', async () => {
    // Para que las pruebas de servicio puedan ejercitar la rama "flagged"
    // sin depender de aleatoriedad.
    const adapter = new ScreeningMockAdapter();
    const sent = await adapter.runCheck('criminal', { ...APPLICANT, fullName: 'Flagged Applicant' });
    if (sent.status !== 'pending') throw new Error('se esperaba pending');
    const polled = await adapter.pollResult('criminal', sent.providerRef);
    if (polled.status !== 'completed') throw new Error('se esperaba completed');
    expect(polled.verdict).toBe('flagged');
  });
});
