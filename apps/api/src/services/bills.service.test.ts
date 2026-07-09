import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GlmMockAdapter,
  QboMockAdapter,
  type QboAdapter,
  type GlmAdapter,
} from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { processReceipt, type ProcessReceiptInput } from './bills.service.js';

/**
 * Tests del flujo de Bills: OCR → extracción → confidence → HITL → sync QBO.
 *
 * Usa el adapter GLM mock (devuelve un recibo determinista) y el QBO mock
 * (captura los Bills creados).
 *
 * La BD de test es la misma de dev; limpiamos entre tests por tenant.
 */
const TENANT_ID = 'tenant_test_bills';

async function seedTenant() {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Test Tenant', province: 'BC' },
  });
}

async function cleanup() {
  await prisma.bill.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.approvalRequest.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.auditEntry.deleteMany({ where: { tenantId: TENANT_ID } });
}

describe('bills service (Puente Contable)', () => {
  beforeEach(async () => {
    await cleanup();
    await seedTenant();
  });

  afterEach(async () => {
    await cleanup();
  });

  const glm: GlmAdapter = new GlmMockAdapter();
  const qbo: QboAdapter = new QboMockAdapter();

  const baseInput: ProcessReceiptInput = {
    tenantId: TENANT_ID,
    actorId: 'user_test',
    mimeType: 'application/pdf',
    base64: 'dGVzdCByZWNlaXB0', // "test receipt" en base64
    filename: 'acme-plumbing-july.pdf',
  };

  it('extrae un recibo por OCR y crea un Bill aprobado automáticamente si la confianza es alta', async () => {
    const result = await processReceipt(baseInput, { glm, qbo });

    // Auto-aprobado → se sincroniza a QBO inmediatamente → estado final synced_to_qbo.
    expect(result.bill.status).toBe('synced_to_qbo');
    expect(result.bill.qboBillId).not.toBeNull();
    expect(result.bill.vendorName).toBe('Acme Plumbing Ltd.');
    expect(result.bill.totalCents).toBe(185_00);
    expect(result.bill.ocrConfidence).toBeGreaterThan(0.85);
    expect(result.approvalRequest).toBeNull(); // auto-aprobado, sin HITL
  });

  it('envía a revisión humana (HITL) cuando la confianza cae debajo del umbral', async () => {
    const result = await processReceipt(baseInput, { glm, qbo, confidenceThreshold: 0.99 });

    expect(result.bill.status).toBe('pending_review');
    expect(result.approvalRequest).not.toBeNull();
    expect(result.approvalRequest!.status).toBe('pending');
    expect(result.approvalRequest!.action).toBe('qbo.create_bill');
  });

  it('escribe una entrada de auditoría al procesar el recibo', async () => {
    const result = await processReceipt(baseInput, { glm, qbo });

    const audit = await prisma.auditEntry.findFirst({
      where: { tenantId: TENANT_ID, entityType: 'bill', entityId: result.bill.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.action).toBe('bill.processed');
  });

  it('no crea el Bill en QBO mientras esté pendiente de revisión humana', async () => {
    const result = await processReceipt(baseInput, { glm, qbo, confidenceThreshold: 0.99 });

    expect(result.bill.qboBillId).toBeNull();
    expect(result.bill.status).toBe('pending_review');
  });
});
