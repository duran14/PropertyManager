/**
 * Servicio de Bills — el corazón del Puente Contable (Módulo C, Prioridad 0).
 *
 * Flujo:
 *  1. INGESTA: un recibo (PDF/imagen) llega (upload manual o webhook de proveedor).
 *  2. OCR: el adapter GLM (GLM-OCR) extrae vendorName, fecha, monto, line items.
 *  3. CONFIDENCE: el motor decide auto_approve vs. review (HITL) según el
 *     umbral del tenant y la self-reported-confidence del OCR.
 *  4. ACCIÓN:
 *     - auto_approve → crea el Bill en QBO inmediatamente.
 *     - review → crea un ApprovalRequest pendiente. El Bookkeeper decide.
 *  5. AUDIT: toda acción queda en el audit trail inmutable.
 *
 * Regla de Oro: el sistema solo PROPONE y EJECUTA instrucciones contables
 * (crear un Bill en QBO). Nunca mueve dinero.
 */
import type { GlmAdapter, QboAdapter, OcrResult } from '@property-manager/adapters';
import type { AccountCategory } from '@property-manager/core';
import { decide } from '@property-manager/core';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';
import { getEnv } from '../config/env.js';
import { withTenant } from '../config/tenant-context.js';
import { buildAuditCreateInput } from './audit-helpers.js';

export interface ProcessReceiptInput {
  tenantId: string;
  actorId: string;
  mimeType: string;
  base64: string;
  filename?: string;
  /** Unidad opcional a la que se asocia la factura. */
  unitId?: string;
}

export interface ProcessReceiptDeps {
  glm: GlmAdapter;
  qbo: QboAdapter;
  /** Umbral de confianza. Default: del env (0.85). */
  confidenceThreshold?: number;
}

export interface ProcessReceiptResult {
  bill: {
    id: string;
    vendorName: string;
    billDate: Date;
    totalCents: number;
    category: string;
    ocrConfidence: number | null;
    status: string;
    qboBillId: string | null;
  };
  approvalRequest: {
    id: string;
    action: string;
    status: string;
    confidenceScore: number;
    confidenceReasons: string[];
  } | null;
}

/**
 * Procesa un recibo de principio a fin: OCR → confidence → Bill → (QBO | HITL).
 * Orquesta los adapters y persiste todo transaccionalmente con auditoría.
 */
export async function processReceipt(
  input: ProcessReceiptInput,
  deps: ProcessReceiptDeps,
): Promise<ProcessReceiptResult> {
  const env = getEnv();
  const threshold = deps.confidenceThreshold ?? env.DEFAULT_CONFIDENCE_THRESHOLD;

  // 1. OCR — el adapter extrae los datos del recibo.
  const ocr: OcrResult = await deps.glm.extractReceipt({
    mimeType: input.mimeType,
    base64: input.base64,
    filename: input.filename,
  });

  // 2. Confidence scoring — combina la confianza del OCR con factores del dominio.
  const decision = decide(
    {
      amountMatch: 1, // no tenemos monto esperado que comparar en el OCR puro
      dateProximity: 1,
      senderVerified: true, // el recibo viene de un canal verificado (upload/webhook)
      documentExtracted: ocr.confidence > 0.8,
      priorHistoryMatches: true,
      customWeight: ocr.confidence, // peso extra = confianza del propio OCR
    },
    { threshold },
  );

  // 3. Persistencia del Bill con el estado correspondiente.
  const category = pickPrimaryCategory(ocr.lineItems.map((l) => l.suggestedCategory));

  return withTenant(prisma, input.tenantId, async (tx) => {
    // Si requiere HITL, creamos el ApprovalRequest primero (lo referenciamos).
    let approvalRequestId: string | null = null;
    let approvalResult: ProcessReceiptResult['approvalRequest'] = null;

    if (decision.decision === 'review') {
      const approval = await tx.approvalRequest.create({
        data: {
          tenantId: input.tenantId,
          action: 'qbo.create_bill',
          proposedPayload: {
            vendorName: ocr.vendorName,
            billDate: ocr.billDate,
            totalCents: ocr.totalCents,
            category,
            lineItems: ocr.lineItems,
          } as Prisma.InputJsonValue,
          confidenceScore: decision.score,
          confidenceReasons: decision.reasons,
          status: 'pending',
        },
      });
      approvalRequestId = approval.id;
      approvalResult = {
        id: approval.id,
        action: approval.action,
        status: approval.status,
        confidenceScore: approval.confidenceScore,
        confidenceReasons: approval.confidenceReasons,
      };
    }

    const status = decision.decision === 'auto_approve' ? 'approved' : 'pending_review';

    const bill = await tx.bill.create({
      data: {
        tenantId: input.tenantId,
        vendorName: ocr.vendorName,
        billDate: new Date(ocr.billDate),
        totalCents: ocr.totalCents,
        currency: ocr.currency,
        category,
        unitId: input.unitId,
        ocrConfidence: ocr.confidence,
        sourceDocRef: input.filename,
        approvalRequestId,
        status,
      },
    });

    // 4. Auditoría.
    await tx.auditEntry.create({
      data: await buildAuditCreateInput({
        tx,
        tenantId: input.tenantId,
        actorId: input.actorId,
        actorType: 'user',
        action: 'bill.processed',
        entityType: 'bill',
        entityId: bill.id,
        payload: {
          vendorName: ocr.vendorName,
          totalCents: ocr.totalCents,
          ocrConfidence: ocr.confidence,
          decision: decision.decision,
          score: decision.score,
          reasons: decision.reasons,
        },
      }),
    });

    // 5. Si auto-aprobado, sincroniza a QBO inmediatamente.
    let qboBillId: string | null = null;
    if (decision.decision === 'auto_approve') {
      const created = await deps.qbo.createBill({
        vendorName: ocr.vendorName,
        billDate: ocr.billDate,
        currency: ocr.currency,
        lines: ocr.lineItems.map((l) => ({
          accountCategory: l.suggestedCategory,
          description: l.description,
          amountCents: l.amountCents,
        })),
        sourceDocumentRef: input.filename,
      });
      qboBillId = created.id;
      await tx.bill.update({
        where: { id: bill.id },
        data: { qboBillId, qboSyncedAt: new Date(), status: 'synced_to_qbo' },
      });

      // Auditoría del sync a QBO.
      await tx.auditEntry.create({
        data: await buildAuditCreateInput({
          tx,
          tenantId: input.tenantId,
          actorId: input.actorId,
          actorType: 'user',
          action: 'qbo.bill_created',
          entityType: 'bill',
          entityId: bill.id,
          payload: { qboBillId, totalCents: ocr.totalCents },
        }),
      });
    }

    return {
      bill: {
        id: bill.id,
        vendorName: bill.vendorName,
        billDate: bill.billDate,
        totalCents: bill.totalCents,
        category: bill.category,
        ocrConfidence: bill.ocrConfidence,
        status: qboBillId ? 'synced_to_qbo' : bill.status,
        qboBillId,
      },
      approvalRequest: approvalResult,
    };
  });
}

/**
 * Aprueba un Bill pendiente de HITL y lo sincroniza a QBO.
 * Solo bookkeeper/broker pueden aprobar (se valida en la ruta).
 */
export async function approveBill(
  billId: string,
  tenantId: string,
  approverId: string,
  deps: { qbo: QboAdapter },
  note?: string,
): Promise<{ qboBillId: string }> {
  const bill = await withTenant(prisma, tenantId, (tx) =>
    tx.bill.findFirst({
      where: { id: billId, tenantId },
      include: { approvalRequest: true },
    }),
  );
  if (!bill) throw new Error('Bill not found');
  if (bill.status !== 'pending_review') {
    throw new Error(`Bill no está pendiente de revisión (estado: ${bill.status})`);
  }

  // Sincroniza a QBO.
  const created = await deps.qbo.createBill({
    vendorName: bill.vendorName,
    billDate: bill.billDate.toISOString().slice(0, 10),
    currency: bill.currency as 'CAD' | 'USD',
    lines: [
      {
        accountCategory: bill.category as AccountCategory,
        description: `${bill.vendorName} — ${bill.category}`,
        amountCents: bill.totalCents,
      },
    ],
    sourceDocumentRef: bill.sourceDocRef ?? undefined,
  });

  return withTenant(prisma, tenantId, async (tx) => {
    await tx.bill.update({
      where: { id: billId },
      data: {
        qboBillId: created.id,
        qboSyncedAt: new Date(),
        status: 'synced_to_qbo',
      },
    });

    if (bill.approvalRequestId) {
      await tx.approvalRequest.update({
        where: { id: bill.approvalRequestId },
        data: {
          status: 'approved',
          decidedByUserId: approverId,
          decidedAt: new Date(),
          decisionNote: note,
        },
      });
    }

    await tx.auditEntry.create({
      data: await buildAuditCreateInput({
        tx,
        tenantId,
        actorId: approverId,
        actorType: 'user',
        action: 'bill.approved',
        entityType: 'bill',
        entityId: billId,
        payload: { qboBillId: created.id, note },
      }),
    });

    return { qboBillId: created.id };
  });
}

/** Rechaza un Bill pendiente de HITL. */
export async function rejectBill(
  billId: string,
  tenantId: string,
  rejecterId: string,
  note?: string,
): Promise<void> {
  const bill = await withTenant(prisma, tenantId, (tx) =>
    tx.bill.findFirst({
      where: { id: billId, tenantId },
      include: { approvalRequest: true },
    }),
  );
  if (!bill) throw new Error('Bill not found');
  if (bill.status !== 'pending_review') {
    throw new Error(`Bill no está pendiente de revisión`);
  }

  return withTenant(prisma, tenantId, async (tx) => {
    await tx.bill.update({ where: { id: billId }, data: { status: 'rejected' } });

    if (bill.approvalRequestId) {
      await tx.approvalRequest.update({
        where: { id: bill.approvalRequestId },
        data: {
          status: 'rejected',
          decidedByUserId: rejecterId,
          decidedAt: new Date(),
          decisionNote: note,
        },
      });
    }

    await tx.auditEntry.create({
      data: await buildAuditCreateInput({
        tx,
        tenantId,
        actorId: rejecterId,
        actorType: 'user',
        action: 'bill.rejected',
        entityType: 'bill',
        entityId: billId,
        payload: { note },
      }),
    });
  });
}

// --- Helpers ---

function pickPrimaryCategory(categories: AccountCategory[]): string {
  if (categories.length === 0) return 'other';
  // Tomamos la categoría de la línea de mayor monto sería ideal; aquí usamos la primera.
  return categories[0]!;
}
