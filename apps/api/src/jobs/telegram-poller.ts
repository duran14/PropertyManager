/**
 * Telegram poller: fetches new messages and passes them to the chatbot.
 *
 * Local development uses long polling because there is no public webhook URL.
 * Production should replace this with setWebhook once a public domain exists.
 */
import { TelegramRealAdapter } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { handleInboundMessage } from '../services/chatbot.service.js';
import { getAdapters } from '../config/adapters.js';
import { getEnv } from '../config/env.js';

let polling = false;

export function startTelegramPoller(): void {
  const env = getEnv();
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.log('  Telegram poller disabled because TELEGRAM_BOT_TOKEN is not set');
    return;
  }

  const adapters = getAdapters();
  const telegramAdapter = adapters.messaging.telegram;
  if (!(telegramAdapter instanceof TelegramRealAdapter)) {
    console.log('  Telegram adapter is running in mock mode; poller disabled');
    return;
  }

  console.log('  Telegram poller started in long polling mode');
  polling = true;
  pollLoop(telegramAdapter).catch((err) => {
    console.error('[Telegram] Poller error:', err.message);
    setTimeout(() => startTelegramPoller(), 10000);
  });
}

export function stopTelegramPoller(): void {
  polling = false;
}

async function pollLoop(adapter: TelegramRealAdapter): Promise<void> {
  const env = getEnv();

  const verify = await adapter.verifyToken();
  if (!verify.ok) {
    console.error('[Telegram] Invalid token. Check TELEGRAM_BOT_TOKEN.');
    return;
  }
  console.log(`  Telegram bot connected: @${verify.botName}`);

  const adapters = getAdapters();

  while (polling) {
    const messages = await adapter.pollUpdates();
    for (const msg of messages) {
      try {
        // MVP routing: one shared bot sends all messages to the configured demo tenant.
        // Multi-tenant routing will map bot token/webhook path or chat setup to IntegrationConfig.
        const tenant = await prisma.tenant.findFirst({
          where: { id: env.TELEGRAM_DEFAULT_TENANT_ID },
        });
        if (!tenant) {
          console.warn(
            `[Telegram] Tenant ${env.TELEGRAM_DEFAULT_TENANT_ID} not found; message skipped`,
          );
          continue;
        }

        console.log(`[Telegram] Message from ${msg.from}: "${msg.body.slice(0, 50)}"`);

        await handleInboundMessage(
          {
            tenantId: tenant.id,
            from: msg.from,
            body: msg.body,
            channel: 'telegram',
          },
          { glm: adapters.glm, messaging: adapters.messaging.telegram, showmojo: adapters.showmojo },
        );
      } catch (err) {
        console.error('[Telegram] Error processing message:', err);
      }
    }
  }
}
