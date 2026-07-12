import { z } from 'zod';

/**
 * Schema central de variables de entorno.
 *
 * Cualquier variable nueva debe añadirse aquí. Validamos al arranque de la API
 * para fallar rápido si falta algo crítico.
 *
 * Las integraciones externas (Buildium, QBO, Twilio, etc.) son TODAS opcionales
 * en el MVP: si su campo está vacío, el adapter correspondiente cae a modo mock.
 * Así podemos desarrollar sin credenciales hoy y enchufar APIs reales mañana.
 */
const envSchema = z.object({
  // --- Entorno ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // --- Base de datos ---
  DATABASE_URL: z.string().url(),

  // --- Redis ---
  REDIS_URL: z.string().url(),

  // --- API ---
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_URL: z.string().url(),
  WEB_URL: z.string().url(),

  // --- Document/object storage ---
  DOCUMENT_STORAGE_DIR: z.string().default('.storage/documents'),
  DOCUMENT_STORAGE_PUBLIC_BASE_URL: z
    .union([z.string().url(), z.literal('')])
    .default(''),

  // --- Autenticación ---
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),

  // --- Cifrado de credenciales por tenant ---
  INTEGRATION_ENCRYPTION_KEY: z.string().min(16),

  // --- IA (Z.ai — GLM). Sin clave → mock. ---
  ZAI_API_KEY: z.string().optional().default(''),
  ZAI_BASE_URL: z
    .string()
    .url()
    .default('https://api.z.ai/api/paas/v4'),
  GLM_REASONING_MODEL: z.string().default('glm-5.2'),
  GLM_OCR_MODEL: z.string().default('glm-ocr'),

  // --- Integraciones externas (todas opcionales → mock si vacías) ---
  BUILDIUM_CLIENT_ID: z.string().optional().default(''),
  BUILDIUM_CLIENT_SECRET: z.string().optional().default(''),

  QBO_CLIENT_ID: z.string().optional().default(''),
  QBO_CLIENT_SECRET: z.string().optional().default(''),
  QBO_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),

  TWILIO_ACCOUNT_SID: z.string().optional().default(''),
  TWILIO_AUTH_TOKEN: z.string().optional().default(''),
  TWILIO_SMS_FROM: z.string().optional().default(''),
  TWILIO_WHATSAPP_FROM: z.string().optional().default(''),
  TWILIO_DEFAULT_TENANT_ID: z
    .preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).default('tenant_demo_pm'),
    ),

  PLAID_CLIENT_ID: z.string().optional().default(''),
  PLAID_SECRET: z.string().optional().default(''),
  PLAID_ENV: z.enum(['sandbox', 'development', 'production']).default('sandbox'),

  STRIPE_SECRET_KEY: z.string().optional().default(''),

  // --- Autoenhance.ai (fotos IA) ---
  AUTOENHANCE_API_KEY: z.string().optional().default(''),
  AUTOENHANCE_BASE_URL: z
    .string()
    .url()
    .default('https://api.autoenhance.ai/v1'),

  // --- ShowMojo (agendamiento de visitas) ---
  SHOWMOJO_API_TOKEN: z.string().optional().default(''),

  // --- DocuSign (firma electrónica) ---
  DOCUSIGN_INTEGRATION_KEY: z.string().optional().default(''),
  DOCUSIGN_USER_ID: z.string().optional().default(''),
  DOCUSIGN_BASE_PATH: z
    .string()
    .url()
    .default('https://demo.docusign.net/restapi'),

  // --- Telegram (bot) ---
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_DEFAULT_TENANT_ID: z
    .preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).default('tenant_demo_pm'),
    ),

  // --- Umbral HITL por defecto ---
  DEFAULT_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
});

export type Env = z.infer<typeof envSchema>;

export type IntegrationKey =
  | 'buildium'
  | 'qbo'
  | 'twilio'
  | 'plaid'
  | 'stripe'
  | 'glm'
  | 'photo_enhancement'
  | 'showmojo'
  | 'docusign'
  | 'telegram';

/**
 * Carga y valida process.env contra el schema. Lanza (fail-fast) si algo
 * crítico falta o está mal formado.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Variables de entorno inválidas:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Dice si una integración tiene credenciales configuradas (→ usar adapter real)
 * o no (→ caer a mock). Centraliza la lógica para que los adapters no repitan.
 */
export function isIntegrationConfigured(env: Env, key: IntegrationKey): boolean {
  switch (key) {
    case 'buildium':
      return Boolean(env.BUILDIUM_CLIENT_ID && env.BUILDIUM_CLIENT_SECRET);
    case 'qbo':
      return Boolean(env.QBO_CLIENT_ID && env.QBO_CLIENT_SECRET);
    case 'twilio':
      return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
    case 'plaid':
      return Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET);
    case 'stripe':
      return Boolean(env.STRIPE_SECRET_KEY);
    case 'glm':
      return Boolean(env.ZAI_API_KEY);
    case 'photo_enhancement':
      return Boolean(env.AUTOENHANCE_API_KEY);
    case 'showmojo':
      return Boolean(env.SHOWMOJO_API_TOKEN);
    case 'docusign':
      return Boolean(env.DOCUSIGN_INTEGRATION_KEY && env.DOCUSIGN_USER_ID);
    case 'telegram':
      return Boolean(env.TELEGRAM_BOT_TOKEN);
  }
}
