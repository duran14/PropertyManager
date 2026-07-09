/**
 * Mock de ShowMojo.
 *
 * Simula el agendamiento con datos realistas:
 *  - getAvailableSlots devuelve horarios de los próximos días (10am-6pm PT)
 *  - createShowing reserva el slot y devuelve una visita con confirmUrl
 *  - Webhooks parsean payloads simulados
 *
 * Cuando se conecte la API real (SHOWMOJO_API_TOKEN), se reemplaza sin tocar
 * la lógica de negocio.
 */
import type {
  ShowMojoAdapter,
  ShowMojoListing,
  ShowMojoShowing,
  ShowMojoSlot,
  ShowMojoWebhookEvent,
} from '../contracts.js';

export class ShowMojoMockAdapter implements ShowMojoAdapter {
  readonly name = 'showmojo' as const;

  private listings = new Map<string, { showmojoUrl: string }>();
  private showings = new Map<string, ShowMojoShowing>();
  private counter = 0;

  async pushListing(listing: ShowMojoListing): Promise<{ listingCode: string; showmojoUrl: string }> {
    const url = `https://showmojo.com/listing/${listing.code}`;
    this.listings.set(listing.code, { showmojoUrl: url });
    return { listingCode: listing.code, showmojoUrl: url };
  }

  async getAvailableSlots(
    _listingCode: string,
    _from: string,
    _to: string,
  ): Promise<ShowMojoSlot[]> {
    // Genera slots para los próximos 3 días hábiles (lun-vie), 10am-5pm PT.
    const slots: ShowMojoSlot[] = [];
    const now = new Date();
    let daysAdded = 0;
    let dayOffset = 1;

    while (daysAdded < 3 && dayOffset < 14) {
      const date = new Date(now);
      date.setDate(now.getDate() + dayOffset);
      const weekday = date.getDay();

      if (weekday >= 1 && weekday <= 5) {
        // Días hábiles: slots cada 2 horas (10am, 12pm, 2pm, 4pm).
        for (const hour of [10, 12, 14, 16]) {
          const start = new Date(date);
          start.setHours(hour, 0, 0, 0);
          const end = new Date(start);
          end.setMinutes(30);
          slots.push({
            startAt: start.toISOString(),
            endAt: end.toISOString(),
            brokerName: dayOffset % 2 === 0 ? 'Marcus Beaulieu' : 'Diana Reyes',
          });
        }
        daysAdded++;
      }
      dayOffset++;
    }

    return slots;
  }

  async createShowing(input: {
    listingCode: string;
    slot: ShowMojoSlot;
    prospectName: string;
    prospectPhone?: string;
    prospectEmail?: string;
  }): Promise<{ showing: ShowMojoShowing }> {
    const id = `sm_showing_${++this.counter}`;
    const showing: ShowMojoShowing = {
      id,
      listingCode: input.listingCode,
      slot: input.slot,
      prospectName: input.prospectName,
      prospectPhone: input.prospectPhone,
      prospectEmail: input.prospectEmail,
      status: 'scheduled',
      confirmUrl: `https://showmojo.com/confirm/${id}`,
      showmojoUrl: `https://showmojo.com/showing/${id}`,
    };
    this.showings.set(id, showing);
    return { showing };
  }

  async getShowing(showingId: string): Promise<ShowMojoShowing> {
    const showing = this.showings.get(showingId);
    if (!showing) throw new Error(`Visita no encontrada: ${showingId}`);
    return showing;
  }

  async confirmShowing(showingId: string): Promise<{ status: 'confirmed' }> {
    const showing = this.showings.get(showingId);
    if (showing) showing.status = 'confirmed';
    return { status: 'confirmed' };
  }

  async cancelShowing(showingId: string, _reason?: string): Promise<{ status: 'cancelled' }> {
    const showing = this.showings.get(showingId);
    if (showing) showing.status = 'cancelled';
    return { status: 'cancelled' };
  }

  async parseWebhook(
    _headers: Record<string, string>,
    body: unknown,
  ): Promise<ShowMojoWebhookEvent> {
    const payload = body as { event_type?: string; [key: string]: unknown };
    const type = payload.event_type;

    if (type === 'lead_captured') {
      return {
        type: 'lead_captured',
        leadName: (payload.lead_name as string) ?? 'Prospecto',
        leadPhone: payload.lead_phone as string | undefined,
        leadEmail: payload.lead_email as string | undefined,
        listingCode: (payload.listing_code as string) ?? 'unknown',
      };
    }
    if (type === 'showing_scheduled') {
      return {
        type: 'showing_scheduled',
        showing: {
          id: (payload.showing_id as string) ?? `sm_${Date.now()}`,
          listingCode: (payload.listing_code as string) ?? 'unknown',
          slot: {
            startAt: (payload.start_at as string) ?? new Date().toISOString(),
            endAt: (payload.end_at as string) ?? new Date().toISOString(),
          },
          prospectName: (payload.prospect_name as string) ?? 'Prospecto',
          prospectPhone: payload.prospect_phone as string | undefined,
          prospectEmail: payload.prospect_email as string | undefined,
          status: 'scheduled',
        },
      };
    }
    if (type === 'showing_confirmed') {
      return { type: 'showing_confirmed', showingId: (payload.showing_id as string) ?? '' };
    }
    if (type === 'showing_cancelled') {
      return {
        type: 'showing_cancelled',
        showingId: (payload.showing_id as string) ?? '',
        reason: payload.reason as string | undefined,
      };
    }
    throw new Error(`Evento de ShowMojo no reconocido: ${type}`);
  }
}
