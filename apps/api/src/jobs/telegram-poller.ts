/**
 * Poller de Telegram — consulta por mensajes nuevos y los pasa al chatbot.
 *
 * Como estamos en local (sin URL pública), usamos long polling en vez de
 * webhook. Este proceso corre en background dentro del server.
 *
 * En producción con dominio público, se reemplazaría por setWebhook.
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
    console.log('  ℹ️  Telegram poller desactivado (sin TELEGRAM_BOT_TOKEN)');
    return;
  }

  // Verificar que el adapter es el real (no mock).
  const adapters = getAdapters();
  const telegramAdapter = adapters.messaging.telegram;
  if (!(telegramAdapter instanceof TelegramRealAdapter)) {
    console.log('  ℹ️  Telegram adapter no es real (mock) — poller desactivado');
    return;
  }

  console.log('  🤖 Telegram poller iniciado (long polling)');
  polling = true;
  pollLoop(telegramAdapter).catch((err) => {
    console.error('[Telegram] Error en poller:', err.message);
    // Reintento tras 10s si falla.
    setTimeout(() => startTelegramPoller(), 10000);
  });
}

export function stopTelegramPoller(): void {
  polling = false;
}

async function pollLoop(adapter: TelegramRealAdapter): Promise<void> {
  // Verificación inicial del token.
  const verify = await adapter.verifyToken();
  if (!verify.ok) {
    console.error('[Telegram] Token inválido. Verifica TELEGRAM_BOT_TOKEN.');
    return;
  }
  console.log(`  ✓ Bot conectado: @${verify.botName}`);

  const adapters = getAdapters();

  while (polling) {
    const messages = await adapter.pollUpdates();
    for (const msg of messages) {
      try {
        // Determinar a qué tenant pertenece el chat.
        // En MVP: todos los mensajes van al tenant demo (solo hay uno).
        // En multi-tenant real: mapear chat_id → tenant via IntegrationConfig.
        const tenant = await prisma.tenant.findFirst({
          where: { id: 'tenant_demo_pm' },
        });
        if (!tenant) continue;

        console.log(`[Telegram] Mensaje de ${msg.from}: "${msg.body.slice(0, 50)}"`);

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
        console.error('[Telegram] Error procesando mensaje:', err);
      }
    }
  }
}
