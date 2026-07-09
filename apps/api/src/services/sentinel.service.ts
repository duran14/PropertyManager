/**
 * Financial Sentinel — el agente IA que procesa avisos bancarios.
 *
 * Cuando llega un e-Transfer (webhook del banco o aviso por email):
 *  1. El Sentinel busca a qué lease/inquilino corresponde (por monto y nombre).
 *  2. Calcula el confidence score.
 *  3. Si es auto_approve: marca el lease como pagado en Buildium y notifica al Broker.
 *  4. Si es review: crea un ApprovalRequest (HITL).
 *  5. Registra el movimiento como Transaction (source: bank).
 *  6. Todo queda en el audit trail.
 *
 * Regla de Oro: marca como pagado en Buildium es una INSTRUCCIÓN de registro,
 * no un movimiento de fondos. El dinero ya está en el banco; el sistema solo
 * actualiza el estado contable.
 */
import type { BuildiumAdapter, GlmAdapter, TwilioAdapter } from '@property-manager/adapters';
import { decide } from '@property-manager/core';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';
import { getAdapters } from '../config/adapters.js';
import { buildAuditCreateInput } from './audit-helpers.js';

export interface BankNotificationInput {
  tenantId: string;
  amountCents: number;
  reference: string;
  senderName?: string;
  receivedAt: string; // ISO date
}

export interface SentinelResult {
  decision: 'auto_approve' | 'review' | 'reject';
  score: number;
  matchedLeaseId: string | null;
  transactionId: string;
  reasons: string[];
  action: 'buildium.mark_paid' | 'none';
  approvalRequestId: string | null;
}

/**
 * Procesa un aviso bancario de principio a fin.
 * Orquesta matching → confidence → acción → auditoría.
 */
export async function processBankNotification(input: BankNotificationInput): Promise<SentinelResult> {
  const adapters = getAdapters();
  const { glm } = adapters;

  // 1. Matching: buscar lease cuyo monto de renta coincida.
  const candidateLease = await findMatchingLease(input);

  // 2. Confidence scoring con asistencia del modelo IA.
  const aiAssessment = await assessWithGlm(glm, input, candidateLease);

  const amountMatch = candidateLease ? scoreAmount(input.amountCents, candidateLease.rentCents) : 0;
  const decision = decide(
    {
      amountMatch,
      dateProximity: scoreDate(input.receivedAt, candidateLease?.dueDay),
      senderVerified: Boolean(candidateLease && aiAssessment.senderMatches),
      documentExtracted: true, // el e-Transfer es evidencia de pago en sí
      priorHistoryMatches: aiAssessment.priorHistory,
      customWeight: aiAssessment.confidence,
    },
    { threshold: 0.85 },
  );

  return prisma.$transaction(async (tx) => {
    // 3. Registrar la transacción bancaria.
    const transaction = await tx.transaction.create({
      data: {
        tenantId: input.tenantId,
        type: 'rent_payment',
        source: 'bank',
        amountCents: input.amountCents,
        reference: input.reference,
        unitId: candidateLease?.unitId,
        occurredAt: new Date(input.receivedAt),
      },
    });

    let approvalRequestId: string | null = null;
    let action: SentinelResult['action'] = 'none';

    if (decision.decision === 'review') {
      // HITL: requiere aprobación humana.
      const approval = await tx.approvalRequest.create({
        data: {
          tenantId: input.tenantId,
          action: 'buildium.mark_paid',
          proposedPayload: {
            transactionId: transaction.id,
            leaseId: candidateLease?.id,
            amountCents: input.amountCents,
            reference: input.reference,
          } as Prisma.InputJsonValue,
          confidenceScore: decision.score,
          confidenceReasons: decision.reasons,
          status: 'pending',
        },
      });
      approvalRequestId = approval.id;
    } else if (decision.decision === 'auto_approve' && candidateLease) {
      // Auto-aprobado: marca el lease como pagado en Buildium (instrucción de registro).
      action = 'buildium.mark_paid';
      // El adapter real lo haría; el mock solo registra.
    }

    // 4. Auditoría.
    await tx.auditEntry.create({
      data: await buildAuditCreateInput({
        tx,
        tenantId: input.tenantId,
        actorId: 'sentinel_agent',
        actorType: 'ai_agent',
        action: 'sentinel.bank_notification',
        entityType: 'transaction',
        entityId: transaction.id,
        payload: {
          amountCents: input.amountCents,
          reference: input.reference,
          matchedLeaseId: candidateLease?.id ?? null,
          decision: decision.decision,
          score: decision.score,
          reasons: decision.reasons,
        },
      }),
    });

    return {
      decision: decision.decision,
      score: decision.score,
      matchedLeaseId: candidateLease?.id ?? null,
      transactionId: transaction.id,
      reasons: decision.reasons,
      action,
      approvalRequestId,
    };
  });
}

/**
 * Busca un lease activo cuyo monto de renta coincida con el e-Transfer.
 * Asume que la renta se paga el primer día del mes (común en BC).
 */
async function findMatchingLease(
  input: BankNotificationInput,
): Promise<{ id: string; rentCents: number; unitId: string; dueDay: number } | null> {
  const lease = await prisma.lease.findFirst({
    where: {
      tenantId: input.tenantId,
      status: 'active',
      rentCents: input.amountCents, // matching exacto de monto
    },
    select: { id: true, rentCents: true, unitId: true, startDate: true },
  });
  if (!lease) return null;
  return { id: lease.id, rentCents: lease.rentCents, unitId: lease.unitId, dueDay: 1 };
}

/**
 * Pide al modelo GLM que evalúe el aviso bancario.
 * El modelo recibe el contexto (monto, remitente, lease candidato) y responde
 * con una valoración estructurada (JSON).
 */
async function assessWithGlm(
  glm: GlmAdapter,
  input: BankNotificationInput,
  candidateLease: { id: string; rentCents: number } | null,
): Promise<{ confidence: number; senderMatches: boolean; priorHistory: boolean }> {
  try {
    const res = await glm.reason({
      systemPrompt:
        'Eres el Financial Sentinel. Evalúas avisos de e-Transfer bancario para determinar si corresponden a un pago de renta legítimo. Responde SOLO en JSON.',
      userPrompt: JSON.stringify({
        montoCents: input.amountCents,
        remitente: input.senderName ?? 'desconocido',
        referencia: input.reference,
        leaseCandidato: candidateLease
          ? { id: candidateLease.id, rentaCents: candidateLease.rentCents }
          : null,
      }),
      responseSchema: {
        type: 'object',
        properties: {
          confidence: { type: 'number' },
          senderMatches: { type: 'boolean' },
          priorHistory: { type: 'boolean' },
        },
      },
      temperature: 0.2,
    });
    const parsed = JSON.parse(res.content) as {
      confidence: number;
      senderMatches: boolean;
      priorHistory: boolean;
    };
    return {
      confidence: parsed.confidence ?? 0.8,
      senderMatches: parsed.senderMatches ?? false,
      priorHistory: parsed.priorHistory ?? true,
    };
  } catch {
    // Si el modelo falla, valores conservadores (favorecen HITL).
    return { confidence: 0.5, senderMatches: false, priorHistory: false };
  }
}

function scoreAmount(receivedCents: number, expectedCents: number): number {
  if (expectedCents === 0) return 0;
  const ratio = receivedCents / expectedCents;
  if (ratio === 1) return 1;
  // Tolerancia: dentro del 2% cuenta como match casi perfecto.
  if (Math.abs(ratio - 1) <= 0.02) return 0.95;
  return Math.max(0, 1 - Math.abs(ratio - 1));
}

function scoreDate(receivedAt: string, dueDay?: number): number {
  if (!dueDay) return 0.5;
  const received = new Date(receivedAt);
  const expectedDay = dueDay;
  const diffDays = Math.abs(received.getDate() - expectedDay);
  if (diffDays <= 1) return 1;
  if (diffDays <= 3) return 0.8;
  if (diffDays <= 7) return 0.5;
  return 0.2;
}

/** Marca un lease como pagado en Buildium (ejecuta la instrucción del Sentinel). */
export async function executeMarkPaid(
  leaseId: string,
  tenantId: string,
  approverId: string,
  payment: { amountCents: number; receivedAt: string; reference: string },
  deps: { buildium: BuildiumAdapter; twilio: TwilioAdapter },
): Promise<void> {
  await deps.buildium.markLeasePaid(leaseId, payment);

  // Notifica al Broker (en MVP, log; con Twilio real mandaría WhatsApp/SMS).
  await prisma.$transaction(async (tx) => {
    await tx.auditEntry.create({
      data: await buildAuditCreateInput({
        tx,
        tenantId,
        actorId: approverId,
        actorType: 'user',
        action: 'buildium.lease_marked_paid',
        entityType: 'lease',
        entityId: leaseId,
        payload: { amountCents: payment.amountCents, reference: payment.reference },
      }),
    });
  });
}
