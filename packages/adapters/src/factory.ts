/**
 * Factory de adapters — el punto único de construcción.
 *
 * Decide mock vs real según `isIntegrationConfigured(env, key)`. Toda la app
 * obtiene sus adapters desde aquí, así la lógica de negocio nunca sabe
 * (ni le importa) si está hablando con un mock o con una API real.
 */
import {
  type Env,
  type IntegrationKey,
  isIntegrationConfigured,
} from '@property-manager/config';
import type {
  BuildiumAdapter,
  ChatChannel,
  GlmAdapter,
  InboundMessage,
  MessagingAdapter,
  OutboundMessage,
  PhotoEnhancementAdapter,
  PlaidAdapter,
  QboAdapter,
  ShowMojoAdapter,
  StripeAdapter,
  TwilioAdapter,
} from './contracts.js';
import { BuildiumMockAdapter } from './mocks/buildium.mock.js';
import { GlmMockAdapter } from './mocks/glm.mock.js';
import { PhotoEnhancementMockAdapter } from './mocks/photo-enhancement.mock.js';
import { PlaidMockAdapter } from './mocks/plaid.mock.js';
import { QboMockAdapter } from './mocks/qbo.mock.js';
import { ShowMojoMockAdapter } from './mocks/showmojo.mock.js';
import { StripeMockAdapter } from './mocks/stripe.mock.js';
import { TwilioMockAdapter } from './mocks/twilio.mock.js';
import { TelegramMockAdapter } from './mocks/telegram.mock.js';
import { WebChatMockAdapter } from './mocks/webchat.mock.js';
import { TelegramRealAdapter } from './real/telegram.real.js';

export interface Adapters {
  buildium: BuildiumAdapter;
  qbo: QboAdapter;
  twilio: TwilioAdapter;
  glm: GlmAdapter;
  plaid: PlaidAdapter;
  stripe: StripeAdapter;
  photoEnhancement: PhotoEnhancementAdapter;
  showmojo: ShowMojoAdapter;
  /** Adapters de mensajería por canal (para el chatbot omnicanal). */
  messaging: Record<ChatChannel, MessagingAdapter>;
  /** Lista de integraciones que están en modo mock (para logs/UI). */
  mockModes: Record<IntegrationKey, boolean>;
}

/**
 * Construye el set completo de adapters.
 * Las integraciones sin credenciales caen a mock automáticamente.
 *
 * NOTE: las implementaciones reales aún no existen (no hay credenciales).
 * Cuando se añadan, se importan aquí y se usan si isIntegrationConfigured.
 */
export function createAdapters(env: Env): Adapters {
  const twilioAdapter = new TwilioMockAdapter();
  const mockModes: Record<IntegrationKey, boolean> = {
    buildium: !isIntegrationConfigured(env, 'buildium'),
    qbo: !isIntegrationConfigured(env, 'qbo'),
    twilio: !isIntegrationConfigured(env, 'twilio'),
    plaid: !isIntegrationConfigured(env, 'plaid'),
    stripe: !isIntegrationConfigured(env, 'stripe'),
    glm: !isIntegrationConfigured(env, 'glm'),
    photo_enhancement: !isIntegrationConfigured(env, 'photo_enhancement'),
    showmojo: !isIntegrationConfigured(env, 'showmojo'),
    docusign: !isIntegrationConfigured(env, 'docusign'),
    telegram: !isIntegrationConfigured(env, 'telegram'),
  };

  return {
    buildium: new BuildiumMockAdapter(),
    qbo: new QboMockAdapter(),
    twilio: twilioAdapter,
    glm: new GlmMockAdapter(),
    plaid: new PlaidMockAdapter(),
    stripe: new StripeMockAdapter(),
    photoEnhancement: new PhotoEnhancementMockAdapter(),
    showmojo: new ShowMojoMockAdapter(),
    messaging: {
      whatsapp: new TwilioMessagingWrapper(twilioAdapter, 'whatsapp', env.TWILIO_WHATSAPP_FROM || '+16045550000'),
      sms: new TwilioMessagingWrapper(twilioAdapter, 'sms', env.TWILIO_SMS_FROM || '+16045550000'),
      telegram: isIntegrationConfigured(env, 'telegram')
        ? new TelegramRealAdapter(env.TELEGRAM_BOT_TOKEN)
        : new TelegramMockAdapter(),
      web: new WebChatMockAdapter(),
      email: new WebChatMockAdapter(),
    },
    mockModes,
  };
}

/**
 * Wrapper que adapta el TwilioAdapter (interfaz específica) al MessagingAdapter
 * unificado. Para WhatsApp y SMS usamos el mismo backend de Twilio.
 */
class TwilioMessagingWrapper implements MessagingAdapter {
  readonly channel: ChatChannel;

  constructor(
    private twilio: TwilioAdapter,
    channel: ChatChannel,
    private from: string,
  ) {
    this.channel = channel;
  }

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    return this.twilio.send({
      to: message.to,
      from: this.from,
      body: message.body,
      channel: this.channel === 'whatsapp' ? 'whatsapp' : 'sms',
    });
  }

  async parseWebhook(headers: Record<string, string>, body: unknown): Promise<InboundMessage> {
    const inbound = await this.twilio.parseWebhook(headers, body);
    return {
      from: inbound.from,
      body: inbound.body,
      channel: this.channel,
      receivedAt: inbound.receivedAt,
      messageId: inbound.messageId,
    };
  }
}
