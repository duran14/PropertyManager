import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireUser } from '../auth/context.js';
import { prisma } from '../config/db.js';
import { parseListInput } from '../services/property-inventory.service.js';

export const onboardingRouter = Router();

const onboardingSchema = z.object({
  logoUrl: z.string().url().optional().or(z.literal('')),
  services: z.union([z.string(), z.array(z.string())]).optional(),
  values: z.union([z.string(), z.array(z.string())]).optional(),
  pricingNotes: z.string().max(4000).optional(),
  showingPreferences: z.string().max(4000).optional(),
  petPolicy: z.string().max(4000).optional(),
  handoffName: z.string().max(200).optional(),
  handoffEmail: z.string().email().optional().or(z.literal('')),
  handoffPhone: z.string().max(40).optional(),
  aiTone: z.string().max(500).optional(),
  aiInstructions: z.string().max(4000).optional(),
});

onboardingRouter.get('/', requireAuth, async (_req, res, next) => {
  try {
    const user = requireUser(_req);
    const profile = await prisma.tenantOnboardingProfile.findUnique({
      where: { tenantId: user.tenantId },
    });
    res.json({ profile });
  } catch (err) {
    next(err);
  }
});

onboardingRouter.put('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = onboardingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid onboarding profile', details: parsed.error.flatten() });
      return;
    }

    const data = {
      logoUrl: parsed.data.logoUrl || null,
      services: parseListInput(parsed.data.services),
      values: parseListInput(parsed.data.values),
      pricingNotes: parsed.data.pricingNotes || null,
      showingPreferences: parsed.data.showingPreferences || null,
      petPolicy: parsed.data.petPolicy || null,
      handoffName: parsed.data.handoffName || null,
      handoffEmail: parsed.data.handoffEmail || null,
      handoffPhone: parsed.data.handoffPhone || null,
      aiTone: parsed.data.aiTone || null,
      aiInstructions: parsed.data.aiInstructions || null,
    };

    const profile = await prisma.tenantOnboardingProfile.upsert({
      where: { tenantId: user.tenantId },
      update: data,
      create: { tenantId: user.tenantId, ...data },
    });

    res.json({ profile });
  } catch (err) {
    next(err);
  }
});
