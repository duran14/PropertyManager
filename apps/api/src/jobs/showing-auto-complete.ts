/**
 * Fase 2.1: el roadmap pide que la invitación de solicitud de renta se
 * mande sola 2 horas después de que termina el showing, sin depender de
 * que el staff apriete el botón manual (`POST /showings/:id/complete`,
 * que sigue existiendo y sigue funcionando igual). Este sondeo reutiliza
 * la MISMA función (`completeShowingAndInvite`) que ese botón — nunca hay
 * dos formas distintas de "completar un showing e invitar".
 */
import type { ChatChannel, MessagingAdapter } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { getAdapters } from '../config/adapters.js';
import { completeShowingAndInvite } from '../services/rental-application.service.js';

const CHECK_INTERVAL_MS = 15 * 60_000;
const TWO_HOURS_MS = 2 * 60 * 60_000;
// Protección contra un envío retroactivo masivo la primera vez que esto
// se despliega: un showing cuyo vencimiento (fin + 2h) cayó hace más de
// 48h no se auto-completa — el prospecto ya se enfrió, y el staff puede
// completarlo a mano con el botón si de verdad hace falta.
const STALE_CUTOFF_MS = 48 * 60 * 60_000;

export interface DueShowing {
  id: string;
  tenantId: string;
  brokerUserId: string | null;
}

export function startShowingAutoCompleteWorker(): void {
  setInterval(() => {
    void runShowingAutoCompleteSweep().catch((error) => {
      console.error('[ShowingAutoComplete] Sondeo falló:', error);
    });
  }, CHECK_INTERVAL_MS).unref();
}

/**
 * `durationMinutes` es un campo por fila -- Prisma no puede expresar
 * `scheduledAt + durationMinutes <= X` en un `where` type-safe sin SQL
 * crudo. Se sobre-consulta con un filtro simple y seguro (2h es mucho más
 * grande que cualquier `durationMinutes` real, que son minutos) y se
 * filtra con precisión en código.
 */
export async function findShowingsDueForAutoComplete(now: Date): Promise<DueShowing[]> {
  const conservativeCutoff = new Date(now.getTime() - TWO_HOURS_MS);
  const candidates = await prisma.showing.findMany({
    where: { status: { in: ['scheduled', 'confirmed'] }, scheduledAt: { lte: conservativeCutoff } },
    select: { id: true, tenantId: true, scheduledAt: true, durationMinutes: true, brokerUserId: true },
  });
  return candidates
    .filter((showing) => {
      const dueAt = showing.scheduledAt.getTime() + showing.durationMinutes * 60_000 + TWO_HOURS_MS;
      return dueAt <= now.getTime() && now.getTime() - dueAt <= STALE_CUTOFF_MS;
    })
    .map((showing) => ({ id: showing.id, tenantId: showing.tenantId, brokerUserId: showing.brokerUserId }));
}

export async function runShowingAutoCompleteSweep(deps?: {
  messaging?: Record<ChatChannel, MessagingAdapter>;
  now?: Date;
}): Promise<{ completed: number; skipped: number }> {
  const now = deps?.now ?? new Date();
  const messaging = deps?.messaging ?? getAdapters().messaging;
  const due = await findShowingsDueForAutoComplete(now);

  let completed = 0;
  let skipped = 0;
  // Uno por vez, no Promise.all: el volumen esperado entre sondeos de 15
  // min es bajo (decenas, no miles), y secuencial evita saturar el
  // adapter de mensajería o el pool de Prisma sin necesidad real.
  for (const showing of due) {
    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: showing.tenantId, actorUserId: showing.brokerUserId },
      { messaging },
    );
    // Un 409 acá es el camino NORMAL, no un error: alguien ya lo completó
    // (el botón manual sigue vivo) o un ciclo anterior del sondeo lo
    // ganó primero -- el guard de `updateMany` de completeShowingAndInvite
    // ya resuelve la carrera, este código solo cuenta el resultado.
    if (result.ok) {
      completed += 1;
    } else {
      skipped += 1;
    }
  }
  return { completed, skipped };
}
