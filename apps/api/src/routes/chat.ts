/**
 * Rutas de Chat (Módulo A — Fase 9).
 *
 * Webhooks (sin auth de JWT, identificados por tenant):
 *  POST /webhooks/twilio    — WhatsApp/SMS entrante
 *  POST /webhooks/telegram  — mensaje de Telegram
 *
 * API directa (para web chat embebido):
 *  POST /chat/messages      — mensaje del web chat (sesión anónima por tenant)
 *  GET  /chat/conversations/:id — historial de una conversación (para panel admin)
 */
import { Router } from 'express';
import { z } from 'zod';
import { getAdapters } from '../config/adapters.js';
import { prisma } from '../config/db.js';
import { requireAuth, requireUser } from '../auth/context.js';
import { getReplyAddressFromConversation, handleInboundMessage } from '../services/chatbot.service.js';

export const chatRouter = Router();

// =============== Webhook de Telegram ===============

chatRouter.post('/webhooks/telegram', async (req, res, next) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    if (typeof tenantId !== 'string') {
      res.status(400).json({ error: 'x-tenant-id header is required' });
      return;
    }
    const adapters = getAdapters();
    const inbound = await adapters.messaging.telegram.parseWebhook(
      req.headers as Record<string, string>,
      req.body,
    );
    if (!inbound.body) {
      // Telegram envía updates vacíos a veces.
      res.status(200).json({ status: 'ignored' });
      return;
    }
    await handleInboundMessage(
      {
        tenantId,
        from: inbound.from,
        body: inbound.body,
        channel: 'telegram',
        mediaUrls: inbound.mediaUrls,
      },
      { glm: adapters.glm, messaging: adapters.messaging.telegram, showmojo: adapters.showmojo },
    );
    res.status(200).json({ status: 'processed' });
  } catch (err) {
    next(err);
  }
});

// =============== Web chat (API directa, sin JWT) ===============

const webChatSchema = z.object({
  sessionId: z.string().min(1), // identificador de sesión del navegador
  message: z.string().min(1).max(2000),
});

chatRouter.post('/messages', async (req, res, next) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    if (typeof tenantId !== 'string') {
      res.status(400).json({ error: 'x-tenant-id header is required' });
      return;
    }
    const parsed = webChatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
      return;
    }
    const adapters = getAdapters();
    const result = await handleInboundMessage(
      {
        tenantId,
        from: `web_${parsed.data.sessionId}`,
        body: parsed.data.message,
        channel: 'web',
      },
      { glm: adapters.glm, messaging: adapters.messaging.web, showmojo: adapters.showmojo },
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// =============== Panel admin: ver conversaciones ===============

chatRouter.get('/conversations', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const conversations = await prisma.chatConversation.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: {
        lead: { select: { name: true, phone: true, status: true } },
        unit: { select: { id: true, name: true, rentCents: true, property: { select: { name: true, city: true } } } },
        messages: { orderBy: { createdAt: 'asc' }, take: 50 },
        slots: true,
      },
    });
    res.json({ conversations });
  } catch (err) {
    next(err);
  }
});

chatRouter.get('/conversations/:id', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const conversation = await prisma.chatConversation.findFirst({
      where: { id: req.params.id, tenantId: user.tenantId },
      include: {
        lead: true,
        unit: { select: { id: true, name: true, rentCents: true, property: { select: { name: true, city: true } } } },
        messages: { orderBy: { createdAt: 'asc' } },
        slots: true,
      },
    });
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ conversation });
  } catch (err) {
    next(err);
  }
});

// =============== Override manual (staff interviene) ===============

const manualReplySchema = z.object({
  message: z.string().min(1).max(2000),
});

chatRouter.post('/conversations/:id/reply', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = manualReplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }
    const conversation = await prisma.chatConversation.findFirst({
      where: { id: req.params.id, tenantId: user.tenantId },
    });
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    // Guardar el mensaje del staff (role: 'staff' para distinguirlo del bot).
    const savedMessage = await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'staff',
        content: parsed.data.message,
      },
    });

    // Actualiza updatedAt de la conversación.
    await prisma.chatConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    // Send through the matching channel.
    const adapters = getAdapters();
    const messagingAdapter = adapters.messaging[conversation.channel as 'whatsapp' | 'sms' | 'telegram' | 'web' | 'email'];
    if (messagingAdapter) {
      await messagingAdapter.send({
        to: getReplyAddressFromConversation(conversation.externalId),
        body: parsed.data.message,
        channel: conversation.channel as 'whatsapp' | 'sms' | 'telegram' | 'web' | 'email',
      });
    }

    res.status(200).json({
      status: 'sent',
      message: {
        id: savedMessage.id,
        role: savedMessage.role,
        content: savedMessage.content,
        createdAt: savedMessage.createdAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});
