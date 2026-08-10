import { z } from 'zod';

const shortlistBookingSchema = z.object({
  // ISO exacto del hueco que el prospecto vio y eligió — nunca un índice: un
  // índice se resuelve contra la disponibilidad fresca en el servidor, que
  // pudo haberse corrido si el "ahora" avanzó entre el GET y este POST (ver
  // Finding 1 de la revisión final).
  startAt: z.string().datetime(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(40),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  notes: z.string().trim().max(1000).optional().default(''),
});

export type ShortlistBooking = z.infer<typeof shortlistBookingSchema>;

export function parseShortlistBooking(input: unknown): ShortlistBooking {
  const parsed = shortlistBookingSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('Invalid booking details');
  }
  return parsed.data;
}
