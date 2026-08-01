import { z } from 'zod';

const shortlistBookingSchema = z.object({
  slotIndex: z.number().int().nonnegative(),
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
