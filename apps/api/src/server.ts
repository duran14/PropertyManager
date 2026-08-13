/**
 * Punto de entrada de la API.
 */
import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { startWorkers } from './jobs/worker.js';
import { scheduleWeeklyRemarketing } from './jobs/queues.js';
import { startTelegramPoller } from './jobs/telegram-poller.js';
import { startShortlistReminderWorker } from './jobs/shortlist-reminders.js';
import { startMessageDeliveryRetryWorker } from './services/message-delivery-retry.service.js';
import { startShowingAutoCompleteWorker } from './jobs/showing-auto-complete.js';

const app = createApp();
const env = getEnv();

app.listen(env.API_PORT, () => {
  console.log(`\n  🏠 Property Manager API escuchando en http://localhost:${env.API_PORT}`);
  console.log(`     Entorno: ${env.NODE_ENV}`);
  console.log(`     Web URL: ${env.WEB_URL}`);

  // Arranca los workers del Financial Sentinel (BullMQ).
  startWorkers();

  void scheduleWeeklyRemarketing().catch((err) => {
    console.error('No se pudo programar el job de remarketing:', err);
  });

  // Arranca el poller de Telegram (si hay token configurado).
  startTelegramPoller();
  startShortlistReminderWorker();
  startMessageDeliveryRetryWorker();
  startShowingAutoCompleteWorker();

  console.log('');
});
