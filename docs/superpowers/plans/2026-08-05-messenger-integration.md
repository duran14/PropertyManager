# Fase 1.1: Integración de Facebook Messenger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conectar Facebook Messenger como un canal más del chatbot omnicanal (webhook, adapter, captura de leads, Q&A, hand-off), reutilizando el pipeline compartido de `handleInboundMessage` sin tocar la lógica del bot.

**Architecture:** Un `MessagingAdapter` nuevo (`MessengerRealAdapter`/`MessengerMockAdapter`) siguiendo el contrato existente, conectado vía un webhook nuevo (`/webhooks/messenger`) que sigue el patrón "ack rápido / procesamiento en segundo plano" ya usado para Twilio, con firma validada sobre el body crudo (HMAC-SHA256) y deduplicación por `message.mid` reusando (generalizado) el mecanismo de claim/complete/fail que hoy es Twilio-específico.

**Tech Stack:** Node.js/Express/TypeScript, Prisma, Vitest, `fetch` nativo (sin SDK de Meta).

Spec de referencia: [`docs/superpowers/specs/2026-08-05-messenger-integration-design.md`](../specs/2026-08-05-messenger-integration-design.md).

## Global Constraints

- Todas las credenciales nuevas son variables de entorno opcionales; sin ellas, el canal cae a mock (`isIntegrationConfigured`) — nunca deben ser requeridas para que la app arranque.
- Modo desarrollo/tester de Meta únicamente — no se implementa flujo de App Review.
- Una sola Page compartida + `MESSENGER_DEFAULT_TENANT_ID` — no se implementa ruteo multi-tenant vía `IntegrationConfig` en esta fase.
- Solo texto entrante/saliente — sin botones, adjuntos, ni plantillas ricas.
- Los tests usan Prisma real contra la DB de desarrollo/test (no mocks de Prisma), con adapters mock/spy inyectados como dependencias — mismo patrón que el resto del repo. Ningún test debe depender de credenciales reales en `.env`; donde haga falta, se mockea `../config/env.js` con valores de prueba (ver `webhooks.twilio.test.ts` como referencia).
- Comentarios en español, solo donde el porqué no sea obvio — mismo estilo que el resto del código base. Sin comentarios que solo repitan el nombre de la función.
- Cada tarea deja el repo en estado verde: `tsc --noEmit` limpio y toda la suite de tests pasando, no solo los tests nuevos.

---

### Task 1: Generalizar claim/complete/fail de webhooks (de Twilio-específico a genérico por proveedor)

`WebhookReceipt` ya tiene un campo `provider` genérico (string) en el schema de Prisma — las funciones que reclaman/completan/fallan un mensaje no tienen nada específico de Twilio. Se extraen a un servicio compartido para que Messenger (Task 8) las reuse sin duplicar código ni crear una tabla paralela.

**Files:**
- Create: `apps/api/src/services/webhook-receipt.service.ts`
- Create: `apps/api/src/services/webhook-receipt.service.test.ts`
- Modify: `apps/api/src/services/twilio-webhook-security.service.ts` (quitar `claimTwilioMessage`/`completeTwilioMessage`/`failTwilioMessage`, dejar solo firma/URL)
- Modify: `apps/api/src/services/twilio-webhook-security.service.test.ts` (quitar el test de claim/complete/fail, que se mueve al archivo nuevo)
- Modify: `apps/api/src/routes/webhooks.ts` (usar las funciones genéricas con `provider: 'twilio'`)

**Interfaces:**
- Produces: `claimWebhookMessage(provider: string, tenantId: string, providerMessageId: string): Promise<WebhookMessageClaim>`, `completeWebhookMessage(provider: string, tenantId: string, providerMessageId: string, claimToken: string): Promise<void>`, `failWebhookMessage(provider: string, tenantId: string, providerMessageId: string, claimToken: string): Promise<void>`, donde `WebhookMessageClaim = { state: 'acquired'; claimToken: string } | { state: 'processing' } | { state: 'completed' } | { state: 'failed' }` — todas exportadas desde `apps/api/src/services/webhook-receipt.service.ts`. Task 8 las consume con `provider: 'messenger'`.

- [ ] **Step 1: Escribir el test del servicio compartido (aún no existe el módulo)**

Crear `apps/api/src/services/webhook-receipt.service.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import {
  claimWebhookMessage,
  completeWebhookMessage,
  failWebhookMessage,
} from './webhook-receipt.service.js';

describe('webhook receipt claim/complete/fail', () => {
  it('distinguishes processing, completed, and failed provider messages', async () => {
    const tenantId = 'tenant_test_webhook_receipt';
    const provider = 'test_provider';
    const messageId = 'MSG-security-test';
    await prisma.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: { id: tenantId, name: 'Webhook Receipt Test', province: 'BC' },
    });
    await prisma.webhookReceipt.deleteMany({ where: { tenantId } });

    const firstClaim = await claimWebhookMessage(provider, tenantId, messageId);
    expect(firstClaim.state).toBe('acquired');
    if (firstClaim.state !== 'acquired') throw new Error('Expected first claim to be acquired');
    expect(firstClaim.claimToken).toBeTruthy();
    await expect(claimWebhookMessage(provider, tenantId, messageId)).resolves.toEqual({ state: 'processing' });

    await completeWebhookMessage(provider, tenantId, messageId, firstClaim.claimToken);
    await expect(claimWebhookMessage(provider, tenantId, messageId)).resolves.toEqual({ state: 'completed' });

    const failedId = `${messageId}-failed`;
    const failedClaim = await claimWebhookMessage(provider, tenantId, failedId);
    expect(failedClaim.state).toBe('acquired');
    if (failedClaim.state !== 'acquired') throw new Error('Expected failed claim to be acquired first');
    await failWebhookMessage(provider, tenantId, failedId, failedClaim.claimToken);
    await expect(claimWebhookMessage(provider, tenantId, failedId)).resolves.toEqual({ state: 'failed' });

    await prisma.webhookReceipt.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  });

  it('keeps claims isolated per provider for the same tenant and message id', async () => {
    const tenantId = 'tenant_test_webhook_receipt_multi_provider';
    const messageId = 'MSG-shared-id';
    await prisma.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: { id: tenantId, name: 'Webhook Receipt Multi-Provider Test', province: 'BC' },
    });
    await prisma.webhookReceipt.deleteMany({ where: { tenantId } });

    const twilioClaim = await claimWebhookMessage('twilio', tenantId, messageId);
    const messengerClaim = await claimWebhookMessage('messenger', tenantId, messageId);
    expect(twilioClaim.state).toBe('acquired');
    expect(messengerClaim.state).toBe('acquired');

    await prisma.webhookReceipt.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla (el módulo no existe)**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/webhook-receipt.service.test.ts`
Expected: FAIL — `Cannot find module './webhook-receipt.service.js'`

- [ ] **Step 3: Crear el servicio compartido**

Crear `apps/api/src/services/webhook-receipt.service.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { prisma } from '../config/db.js';
import { withTenant } from '../config/tenant-context.js';

export type WebhookMessageClaim =
  | { state: 'acquired'; claimToken: string }
  | { state: 'processing' }
  | { state: 'completed' }
  | { state: 'failed' };

/**
 * Reclama un mensaje entrante de un webhook de proveedor (Twilio, Messenger,
 * ...) por su ID único de proveedor, para deduplicar reintentos. Genérico
 * sobre `provider`: WebhookReceipt no tiene nada específico de un canal en
 * particular, solo agrupa por (tenantId, provider, providerMessageId).
 */
export async function claimWebhookMessage(
  provider: string,
  tenantId: string,
  providerMessageId: string,
): Promise<WebhookMessageClaim> {
  return withTenant(prisma, tenantId, async (tx) => {
    const claimToken = randomUUID();
    const result = await tx.webhookReceipt.createMany({
      data: [{ tenantId, provider, providerMessageId, claimToken }],
      skipDuplicates: true,
    });
    if (result.count === 1) {
      return { state: 'acquired', claimToken };
    }

    const receipt = await tx.webhookReceipt.findUniqueOrThrow({
      where: {
        tenantId_provider_providerMessageId: {
          tenantId,
          provider,
          providerMessageId,
        },
      },
    });
    if (receipt.status === 'completed') return { state: 'completed' };
    if (receipt.status === 'failed') return { state: 'failed' };
    return { state: 'processing' };
  });
}

export async function failWebhookMessage(
  provider: string,
  tenantId: string,
  providerMessageId: string,
  claimToken: string,
): Promise<void> {
  await withTenant(prisma, tenantId, (tx) => tx.webhookReceipt.updateMany({
    where: { tenantId, provider, providerMessageId, status: 'processing', claimToken },
    data: { status: 'failed' },
  }));
}

export async function completeWebhookMessage(
  provider: string,
  tenantId: string,
  providerMessageId: string,
  claimToken: string,
): Promise<void> {
  await withTenant(prisma, tenantId, (tx) => tx.webhookReceipt.updateMany({
    where: { tenantId, provider, providerMessageId, status: 'processing', claimToken },
    data: { status: 'completed' },
  }));
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/webhook-receipt.service.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Reducir `twilio-webhook-security.service.ts` a solo lo específico de Twilio**

En `apps/api/src/services/twilio-webhook-security.service.ts`, quitar `claimTwilioMessage`, `failTwilioMessage`, `completeTwilioMessage`, y sus imports ya no usados (`randomUUID`, `prisma`, `withTenant`). El archivo debe quedar así (completo):

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

interface ValidateTwilioWebhookSignatureInput {
  authToken: string;
  url: string;
  body: Record<string, unknown>;
  signature: string;
}

export function buildTwilioWebhookUrl(apiUrl: string, originalUrl: string): string {
  return new URL(originalUrl, ensureTrailingSlash(apiUrl)).toString();
}

export function validateTwilioWebhookSignature(
  input: ValidateTwilioWebhookSignatureInput,
): boolean {
  if (!input.authToken || !input.signature) {
    return false;
  }

  const payload = Object.keys(input.body)
    .sort()
    .reduce((value, key) => value + key + toTwilioParameterValue(input.body[key]), input.url);
  const expected = createHmac('sha1', input.authToken).update(payload, 'utf8').digest();

  let supplied: Buffer;
  try {
    supplied = Buffer.from(input.signature, 'base64');
  } catch {
    return false;
  }

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function toTwilioParameterValue(value: unknown): string {
  if (Array.isArray(value)) {
    return [...value].map(String).sort().join('');
  }
  return typeof value === 'string' ? value : String(value ?? '');
}
```

- [ ] **Step 6: Quitar de `twilio-webhook-security.service.test.ts` el test que se movió**

En `apps/api/src/services/twilio-webhook-security.service.test.ts`, quitar el `it('distinguishes processing, completed, and failed provider messages', ...)` completo (ya cubierto por el nuevo `webhook-receipt.service.test.ts`) y los imports que dejan de usarse (`claimTwilioMessage`, `completeTwilioMessage`, `failTwilioMessage`, `prisma`). El archivo debe quedar así (completo):

```typescript
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildTwilioWebhookUrl,
  validateTwilioWebhookSignature,
} from './twilio-webhook-security.service.js';

function sign(url: string, params: Record<string, string>, authToken: string): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((value, key) => value + key + params[key], url);
  return createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
}

describe('Twilio webhook security', () => {
  it('accepts a valid signature and rejects a tampered payload', () => {
    const authToken = 'twilio-test-token';
    const url = 'https://pm-api.example.com/webhooks/twilio/sms';
    const body = {
      Body: 'Hello',
      From: '+16045550123',
      MessageSid: 'SM123',
      To: '+16045550576',
    };
    const signature = sign(url, body, authToken);

    expect(validateTwilioWebhookSignature({ authToken, url, body, signature })).toBe(true);
    expect(
      validateTwilioWebhookSignature({
        authToken,
        url,
        body: { ...body, Body: 'Tampered' },
        signature,
      }),
    ).toBe(false);
  });

  it('builds the externally configured callback URL including its query string', () => {
    expect(
      buildTwilioWebhookUrl('https://pm-api.example.com/', '/webhooks/twilio/sms?tenant=demo'),
    ).toBe('https://pm-api.example.com/webhooks/twilio/sms?tenant=demo');
  });
});
```

- [ ] **Step 7: Actualizar `webhooks.ts` para usar las funciones genéricas**

En `apps/api/src/routes/webhooks.ts`:

Cambiar el bloque de import de:
```typescript
import {
  buildTwilioWebhookUrl,
  claimTwilioMessage,
  completeTwilioMessage,
  failTwilioMessage,
  validateTwilioWebhookSignature,
} from '../services/twilio-webhook-security.service.js';
```
a:
```typescript
import {
  buildTwilioWebhookUrl,
  validateTwilioWebhookSignature,
} from '../services/twilio-webhook-security.service.js';
import {
  claimWebhookMessage,
  completeWebhookMessage,
  failWebhookMessage,
} from '../services/webhook-receipt.service.js';
```

En `claimAndPrepareTwilioMessage`, cambiar:
```typescript
  const claim = await claimTwilioMessage(tenantId, messageSid);
```
a:
```typescript
  const claim = await claimWebhookMessage('twilio', tenantId, messageSid);
```

Y unas líneas después, dentro del mismo `try`/`catch` (el que envuelve `messagingAdapter.parseWebhook`), cambiar:
```typescript
  } catch (error) {
    await failTwilioMessage(tenantId, messageSid, claim.claimToken);
    throw error;
  }
```
a:
```typescript
  } catch (error) {
    await failWebhookMessage('twilio', tenantId, messageSid, claim.claimToken);
    throw error;
  }
```

En `processClaimedTwilioMessage`, cambiar:
```typescript
    await completeTwilioMessage(tenantId, messageSid, claimToken);
  } catch (error) {
    await failTwilioMessage(tenantId, messageSid, claimToken);
    throw error;
  }
```
a:
```typescript
    await completeWebhookMessage('twilio', tenantId, messageSid, claimToken);
  } catch (error) {
    await failWebhookMessage('twilio', tenantId, messageSid, claimToken);
    throw error;
  }
```

- [ ] **Step 8: Correr toda la suite de `apps/api` y confirmar que sigue verde**

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — todos los tests, incluyendo `webhooks.twilio.test.ts` (no debería requerir cambios, ya que solo importa `claimAndPrepareTwilioMessage`/`processClaimedTwilioMessage` de `webhooks.ts`, no las funciones de claim directamente).

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/webhook-receipt.service.ts apps/api/src/services/webhook-receipt.service.test.ts apps/api/src/services/twilio-webhook-security.service.ts apps/api/src/services/twilio-webhook-security.service.test.ts apps/api/src/routes/webhooks.ts
git commit -m "refactor: generalize webhook claim/complete/fail beyond Twilio"
```

---

### Task 2: Extender tipos y esquema para el canal `messenger`

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`enum ChatChannel`, `enum LeadSource`)
- Create: migración de Prisma (generada por el comando del Step 2)
- Modify: `packages/config/src/env.ts` (variables nuevas, `IntegrationKey`, `isIntegrationConfigured`)
- Modify: `packages/adapters/src/contracts.ts` (`ChatChannel`)
- Modify: `apps/api/src/services/chatbot.service.ts:134-140` (usar `ChatChannel` importado en vez de la unión duplicada)
- Modify: `apps/api/src/routes/chat.ts:451,456` (ídem)
- Modify: `apps/api/src/routes/leads.ts:554` (ídem)
- Modify: `packages/adapters/src/factory.test.ts` (agregar los campos nuevos de `Env` al fixture `baseEnv`, si no se hace ya no compila)

**Interfaces:**
- Produces: `ChatChannel` (en `packages/adapters/src/contracts.ts`) incluye `'messenger'`. `Env` (en `packages/config/src/env.ts`) incluye `MESSENGER_PAGE_ACCESS_TOKEN: string`, `MESSENGER_APP_SECRET: string`, `MESSENGER_VERIFY_TOKEN: string`, `MESSENGER_DEFAULT_TENANT_ID: string`. `isIntegrationConfigured(env, 'messenger')` disponible.

Este task es principalmente de tipos/esquema — no tiene ciclo TDD propio significativo, pero deja el repo compilando y con la suite verde antes de seguir (Tasks 3-8 dependen de estos tipos).

- [ ] **Step 1: Extender los enums de Prisma**

En `apps/api/prisma/schema.prisma`, en `enum LeadSource` (línea ~524), agregar `messenger` después de `telegram`:

```prisma
enum LeadSource {
  unit_url // llegó por la URL pública de una unidad
  whatsapp // chatbot de WhatsApp
  sms // chatbot de SMS
  telegram // chatbot de Telegram
  messenger // chatbot de Facebook Messenger
  web // chat web embebido
  email // contacto por email
  showmojo // registro de visita en ShowMojo
  manual // cargado a mano
  // (deja el resto de los valores existentes sin tocar)
}
```

En `enum ChatChannel` (línea ~600):

```prisma
enum ChatChannel {
  whatsapp
  sms
  telegram
  messenger
  web
  email
}
```

- [ ] **Step 2: Generar y aplicar la migración**

Asegúrate de que Postgres esté corriendo (`pnpm db:up` si no lo está), luego:

Run: `pnpm --filter @property-manager/api exec prisma migrate dev --name add_messenger_channel`
Expected: crea `apps/api/prisma/migrations/<timestamp>_add_messenger_channel/migration.sql` con los `ALTER TYPE` correspondientes, y termina sin errores.

- [ ] **Step 3: Agregar las variables de entorno de Messenger**

En `packages/config/src/env.ts`, junto a las variables de Telegram, agregar:

```typescript
  MESSENGER_PAGE_ACCESS_TOKEN: z.string().optional().default(''),
  MESSENGER_APP_SECRET: z.string().optional().default(''),
  MESSENGER_VERIFY_TOKEN: z.string().optional().default(''),
  MESSENGER_DEFAULT_TENANT_ID: z
    .preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(1).default('tenant_demo_pm'),
    ),
```

(Coloca este bloque siguiendo el mismo patrón que `TELEGRAM_DEFAULT_TENANT_ID` — cópialo como referencia exacta de forma/preprocess.)

En el mismo archivo, agregar `'messenger'` a `IntegrationKey`:

```typescript
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
  | 'telegram'
  | 'messenger'
  | 'email';
```

Y en `isIntegrationConfigured`, agregar el caso:

```typescript
    case 'messenger':
      return Boolean(env.MESSENGER_PAGE_ACCESS_TOKEN && env.MESSENGER_APP_SECRET);
```

(justo después del `case 'telegram': return Boolean(env.TELEGRAM_BOT_TOKEN);`)

- [ ] **Step 4: Agregar `'messenger'` al tipo `ChatChannel`**

En `packages/adapters/src/contracts.ts`, cambiar:
```typescript
export type ChatChannel = 'whatsapp' | 'sms' | 'telegram' | 'web' | 'email';
```
a:
```typescript
export type ChatChannel = 'whatsapp' | 'sms' | 'telegram' | 'messenger' | 'web' | 'email';
```

- [ ] **Step 5: Reemplazar las uniones duplicadas de `ChatChannel` por el tipo importado**

Estos tres archivos duplican la unión de `ChatChannel` en vez de importarla — cada canal nuevo obliga a tocar los 4 lugares (el tipo real + estos 3). Se corrige de una vez para que esto no vuelva a pasar con el siguiente canal.

En `apps/api/src/services/chatbot.service.ts`, el import existente de adapters (cerca de la línea 7):
```typescript
import type { GlmAdapter, MessagingAdapter, ShowMojoAdapter } from '@property-manager/adapters';
```
cambia a:
```typescript
import type { ChatChannel, GlmAdapter, MessagingAdapter, ShowMojoAdapter } from '@property-manager/adapters';
```
Y en `InboundChatMessage` (línea ~134-140), cambiar:
```typescript
export interface InboundChatMessage {
  tenantId: string;
  from: string;
  body: string;
  channel: 'whatsapp' | 'sms' | 'telegram' | 'web' | 'email';
  mediaUrls?: string[];
}
```
a:
```typescript
export interface InboundChatMessage {
  tenantId: string;
  from: string;
  body: string;
  channel: ChatChannel;
  mediaUrls?: string[];
}
```

En `apps/api/src/routes/chat.ts`, agregar el import (junto a los demás imports de servicios, por ejemplo después de `import { getAdapters } from '../config/adapters.js';`):
```typescript
import type { ChatChannel } from '@property-manager/adapters';
```
Y cambiar las dos apariciones (líneas ~451 y ~456) de:
```typescript
      adapters.messaging[conversation.channel as 'whatsapp' | 'sms' | 'telegram' | 'web' | 'email'];
```
a:
```typescript
      adapters.messaging[conversation.channel as ChatChannel];
```
y de:
```typescript
        channel: conversation.channel as 'whatsapp' | 'sms' | 'telegram' | 'web' | 'email',
```
a:
```typescript
        channel: conversation.channel as ChatChannel,
```

En `apps/api/src/routes/leads.ts`, agregar el import (junto a `import { getAdapters } from '../config/adapters.js';`):
```typescript
import type { ChatChannel } from '@property-manager/adapters';
```
Y cambiar (línea ~554):
```typescript
    const ch = (channel ?? 'whatsapp') as 'whatsapp' | 'sms' | 'telegram' | 'web' | 'email';
```
a:
```typescript
    const ch = (channel ?? 'whatsapp') as ChatChannel;
```

- [ ] **Step 6: Actualizar el fixture `baseEnv` del test del factory**

En `packages/adapters/src/factory.test.ts`, agregar al objeto `baseEnv` (junto a los campos de `TELEGRAM_*`):
```typescript
  MESSENGER_PAGE_ACCESS_TOKEN: '',
  MESSENGER_APP_SECRET: '',
  MESSENGER_VERIFY_TOKEN: '',
  MESSENGER_DEFAULT_TENANT_ID: 'tenant_demo_pm',
```

- [ ] **Step 7: Verificar que todo compila y la suite sigue verde**

Run: `pnpm --filter @property-manager/config exec tsc --noEmit`
Expected: sin errores.

Run: `pnpm --filter @property-manager/adapters exec vitest run && pnpm --filter @property-manager/adapters exec tsc --noEmit`
Expected: PASS, sin errores (el `factory.test.ts` actualizado debe seguir pasando).

Run: `pnpm --filter @property-manager/api exec vitest run && pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: PASS, sin errores.

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations packages/config/src/env.ts packages/adapters/src/contracts.ts packages/adapters/src/factory.test.ts apps/api/src/services/chatbot.service.ts apps/api/src/routes/chat.ts apps/api/src/routes/leads.ts
git commit -m "feat: add messenger as a known ChatChannel/LeadSource/IntegrationKey"
```

---

### Task 3: Validación de firma del webhook de Messenger

Meta firma el body **crudo** con HMAC-SHA256 (`X-Hub-Signature-256: sha256=<hex>`), a diferencia de Twilio que firma sobre los parámetros del form.

**Files:**
- Create: `apps/api/src/services/messenger-webhook-security.service.ts`
- Create: `apps/api/src/services/messenger-webhook-security.service.test.ts`

**Interfaces:**
- Produces: `validateMessengerWebhookSignature(input: { appSecret: string; rawBody: Buffer; signatureHeader: string | undefined }): boolean`, exportada desde `apps/api/src/services/messenger-webhook-security.service.ts`. Consumida por Task 8.

- [ ] **Step 1: Escribir el test (el módulo aún no existe)**

Crear `apps/api/src/services/messenger-webhook-security.service.test.ts`:

```typescript
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateMessengerWebhookSignature } from './messenger-webhook-security.service.js';

function sign(rawBody: Buffer, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

describe('Messenger webhook signature', () => {
  it('accepts a valid signature over the raw body', () => {
    const appSecret = 'messenger-test-secret';
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }), 'utf8');
    const signatureHeader = sign(rawBody, appSecret);

    expect(validateMessengerWebhookSignature({ appSecret, rawBody, signatureHeader })).toBe(true);
  });

  it('rejects a signature computed over a different body', () => {
    const appSecret = 'messenger-test-secret';
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }), 'utf8');
    const tamperedBody = Buffer.from(JSON.stringify({ entry: [{ tampered: true }] }), 'utf8');
    const signatureHeader = sign(rawBody, appSecret);

    expect(validateMessengerWebhookSignature({ appSecret, rawBody: tamperedBody, signatureHeader })).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const rawBody = Buffer.from('{}', 'utf8');
    expect(validateMessengerWebhookSignature({ appSecret: 'secret', rawBody, signatureHeader: undefined })).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const rawBody = Buffer.from('{}', 'utf8');
    expect(validateMessengerWebhookSignature({ appSecret: 'secret', rawBody, signatureHeader: 'deadbeef' })).toBe(false);
  });

  it('rejects when no app secret is configured', () => {
    const rawBody = Buffer.from('{}', 'utf8');
    const signatureHeader = sign(rawBody, 'irrelevant');
    expect(validateMessengerWebhookSignature({ appSecret: '', rawBody, signatureHeader })).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/messenger-webhook-security.service.test.ts`
Expected: FAIL — `Cannot find module './messenger-webhook-security.service.js'`

- [ ] **Step 3: Implementar la validación de firma**

Crear `apps/api/src/services/messenger-webhook-security.service.ts`:

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

interface ValidateMessengerWebhookSignatureInput {
  appSecret: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
}

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Meta firma el body crudo del webhook (no los campos re-serializados) con
 * HMAC-SHA256 usando el App Secret. A diferencia de Twilio, que firma sobre
 * los parámetros del form, aquí el buffer exacto que llegó por HTTP importa
 * — ver el middleware `verify` de `express.json()` en `app.ts` que lo captura.
 */
export function validateMessengerWebhookSignature(
  input: ValidateMessengerWebhookSignatureInput,
): boolean {
  if (!input.appSecret || !input.signatureHeader) {
    return false;
  }
  if (!input.signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const suppliedHex = input.signatureHeader.slice(SIGNATURE_PREFIX.length);
  const expected = createHmac('sha256', input.appSecret).update(input.rawBody).digest();

  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedHex, 'hex');
  } catch {
    return false;
  }

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm --filter @property-manager/api exec vitest run src/services/messenger-webhook-security.service.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/messenger-webhook-security.service.ts apps/api/src/services/messenger-webhook-security.service.test.ts
git commit -m "feat: validate Messenger webhook signatures over the raw body"
```

---

### Task 4: Extractor puro del payload de Messenger

Función pura que interpreta el JSON de Meta y decide qué es "un mensaje de texto procesable" — reutilizada tanto por el adapter (Task 5/6) como por la ruta del webhook (Task 8, para poder reclamar por `mid` antes de invocar al bot).

**Files:**
- Create: `packages/adapters/src/real/messenger-payload.ts`
- Create: `packages/adapters/src/real/messenger-payload.test.ts`
- Modify: `packages/adapters/src/index.ts` (exportar el módulo nuevo)

**Interfaces:**
- Produces: `MessengerTextMessage = { senderId: string; mid: string; text: string }` y `extractMessengerTextMessage(body: unknown): MessengerTextMessage | null`, exportadas desde `packages/adapters/src/real/messenger-payload.ts` (y re-exportadas desde `@property-manager/adapters`). Consumida por Tasks 5, 6 y 8.

- [ ] **Step 1: Escribir el test (el módulo aún no existe)**

Crear `packages/adapters/src/real/messenger-payload.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { extractMessengerTextMessage } from './messenger-payload.js';

function textPayload(senderId: string, mid: string, text: string) {
  return {
    entry: [{ messaging: [{ sender: { id: senderId }, message: { mid, text } }] }],
  };
}

describe('extractMessengerTextMessage', () => {
  it('extracts sender, mid, and text from a normal text message', () => {
    expect(extractMessengerTextMessage(textPayload('psid-1', 'mid-1', 'Hola, ¿tienen disponibilidad?'))).toEqual({
      senderId: 'psid-1',
      mid: 'mid-1',
      text: 'Hola, ¿tienen disponibilidad?',
    });
  });

  it('ignores an echo of the Page\'s own message', () => {
    const payload = {
      entry: [{ messaging: [{ sender: { id: 'psid-1' }, message: { mid: 'mid-1', text: 'hi', is_echo: true } }] }],
    };
    expect(extractMessengerTextMessage(payload)).toBeNull();
  });

  it('ignores a message without text (e.g. an attachment)', () => {
    const payload = {
      entry: [{ messaging: [{ sender: { id: 'psid-1' }, message: { mid: 'mid-1', attachments: [{ type: 'image' }] } }] }],
    };
    expect(extractMessengerTextMessage(payload)).toBeNull();
  });

  it('ignores a postback event (no message field at all)', () => {
    const payload = {
      entry: [{ messaging: [{ sender: { id: 'psid-1' }, postback: { payload: 'GET_STARTED' } }] }],
    };
    expect(extractMessengerTextMessage(payload)).toBeNull();
  });

  it('picks the first valid text message when multiple entries are present', () => {
    const payload = {
      entry: [
        { messaging: [{ sender: { id: 'psid-1' }, message: { mid: 'mid-1', text: 'first' } }] },
        { messaging: [{ sender: { id: 'psid-2' }, message: { mid: 'mid-2', text: 'second' } }] },
      ],
    };
    expect(extractMessengerTextMessage(payload)).toEqual({ senderId: 'psid-1', mid: 'mid-1', text: 'first' });
  });

  it('returns null for a malformed or empty payload', () => {
    expect(extractMessengerTextMessage({})).toBeNull();
    expect(extractMessengerTextMessage(null)).toBeNull();
    expect(extractMessengerTextMessage('not an object')).toBeNull();
    expect(extractMessengerTextMessage({ entry: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/adapters exec vitest run src/real/messenger-payload.test.ts`
Expected: FAIL — `Cannot find module './messenger-payload.js'`

- [ ] **Step 3: Implementar el extractor**

Crear `packages/adapters/src/real/messenger-payload.ts`:

```typescript
export interface MessengerTextMessage {
  senderId: string;
  mid: string;
  text: string;
}

interface MessengerWebhookBody {
  entry?: Array<{
    messaging?: Array<{
      sender?: { id?: string };
      message?: { mid?: string; text?: string; is_echo?: boolean };
    }>;
  }>;
}

/**
 * Extrae el primer mensaje de texto entrante y no-eco de un payload de
 * webhook de Messenger. Devuelve null para eco, adjuntos, postbacks, o
 * payloads sin nada procesable — esos casos se ignoran (200 OK) en vez de
 * tratarse como error, tanto en el adapter (Task 5/6) como en la ruta del
 * webhook (Task 8).
 */
export function extractMessengerTextMessage(body: unknown): MessengerTextMessage | null {
  if (!body || typeof body !== 'object') return null;
  const payload = body as MessengerWebhookBody;

  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const message = event.message;
      if (!message || message.is_echo) continue;
      if (typeof message.text !== 'string' || message.text.length === 0) continue;
      if (typeof message.mid !== 'string' || message.mid.length === 0) continue;
      const senderId = event.sender?.id;
      if (typeof senderId !== 'string' || senderId.length === 0) continue;
      return { senderId, mid: message.mid, text: message.text };
    }
  }
  return null;
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm --filter @property-manager/adapters exec vitest run src/real/messenger-payload.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Exportar el módulo nuevo desde el paquete**

En `packages/adapters/src/index.ts`, agregar (junto a `export * from './real/telegram.real.js';`):
```typescript
export * from './real/messenger-payload.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/real/messenger-payload.ts packages/adapters/src/real/messenger-payload.test.ts packages/adapters/src/index.ts
git commit -m "feat: add a pure extractor for Messenger webhook text messages"
```

---

### Task 5: `MessengerRealAdapter`

**Files:**
- Create: `packages/adapters/src/real/messenger.real.ts`
- Create: `packages/adapters/src/real/messenger.real.test.ts`
- Modify: `packages/adapters/src/index.ts` (exportar el adapter)

**Interfaces:**
- Consumes: `extractMessengerTextMessage` de `./messenger-payload.js` (Task 4); `ChatChannel`, `InboundMessage`, `MessagingAdapter`, `OutboundMessage` de `../contracts.js`.
- Produces: `class MessengerRealAdapter implements MessagingAdapter` (constructor recibe `pageAccessToken: string`), exportada desde `packages/adapters/src/real/messenger.real.ts`. Consumida por Task 7 (factory).

- [ ] **Step 1: Escribir el test (el módulo aún no existe)**

Crear `packages/adapters/src/real/messenger.real.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessengerRealAdapter } from './messenger.real.js';

describe('MessengerRealAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a text message to the Graph API with the page access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message_id: 'mid-sent-1' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new MessengerRealAdapter('page-token-123');
    const result = await adapter.send({ to: 'psid-1', body: 'Hola', channel: 'messenger' });

    expect(result).toEqual({ messageId: 'mid-sent-1' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('graph.facebook.com');
    expect(String(url)).toContain('page-token-123');
    expect(JSON.parse(options.body)).toEqual({
      recipient: { id: 'psid-1' },
      message: { text: 'Hola' },
    });
  });

  it('throws with the Graph API error body when the send fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      text: async () => '{"error":"invalid token"}',
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new MessengerRealAdapter('bad-token');
    await expect(adapter.send({ to: 'psid-1', body: 'Hola', channel: 'messenger' }))
      .rejects.toThrow('invalid token');
  });

  it('parses a webhook payload into an InboundMessage', async () => {
    const adapter = new MessengerRealAdapter('page-token-123');
    const inbound = await adapter.parseWebhook({}, {
      entry: [{ messaging: [{ sender: { id: 'psid-1' }, message: { mid: 'mid-1', text: 'Hola' } }] }],
    });

    expect(inbound).toMatchObject({ from: 'psid-1', body: 'Hola', channel: 'messenger', messageId: 'mid-1' });
  });

  it('throws when the payload has nothing actionable (echo, attachment, postback)', async () => {
    const adapter = new MessengerRealAdapter('page-token-123');
    await expect(adapter.parseWebhook({}, { entry: [] })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/adapters exec vitest run src/real/messenger.real.test.ts`
Expected: FAIL — `Cannot find module './messenger.real.js'`

- [ ] **Step 3: Implementar el adapter**

Crear `packages/adapters/src/real/messenger.real.ts`:

```typescript
/**
 * Adapter REAL de Facebook Messenger — usa la Graph API de Meta vía webhook
 * (a diferencia de Telegram, Messenger no soporta long-polling).
 */
import type {
  ChatChannel,
  InboundMessage,
  MessagingAdapter,
  OutboundMessage,
} from '../contracts.js';
import { extractMessengerTextMessage } from './messenger-payload.js';

const GRAPH_API_VERSION = 'v21.0';

export class MessengerRealAdapter implements MessagingAdapter {
  readonly channel: ChatChannel = 'messenger';

  constructor(private readonly pageAccessToken: string) {}

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(this.pageAccessToken)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: message.to },
        message: { text: message.body },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Messenger send falló: ${err}`);
    }
    const data = (await res.json()) as { message_id: string };
    return { messageId: data.message_id };
  }

  async parseWebhook(_headers: Record<string, string>, body: unknown): Promise<InboundMessage> {
    const extracted = extractMessengerTextMessage(body);
    if (!extracted) {
      throw new Error('Messenger webhook payload sin mensaje de texto procesable (eco, adjunto, o postback)');
    }
    return {
      from: extracted.senderId,
      body: extracted.text,
      channel: 'messenger',
      receivedAt: new Date().toISOString(),
      messageId: extracted.mid,
    };
  }
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm --filter @property-manager/adapters exec vitest run src/real/messenger.real.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Exportar el adapter**

En `packages/adapters/src/index.ts`, agregar (junto a `export * from './real/telegram.real.js';`):
```typescript
export * from './real/messenger.real.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/real/messenger.real.ts packages/adapters/src/real/messenger.real.test.ts packages/adapters/src/index.ts
git commit -m "feat: add MessengerRealAdapter (Graph API send + webhook parsing)"
```

---

### Task 6: `MessengerMockAdapter`

**Files:**
- Create: `packages/adapters/src/mocks/messenger.mock.ts`
- Create: `packages/adapters/src/mocks/messenger.mock.test.ts`
- Modify: `packages/adapters/src/index.ts` (exportar el mock)

**Interfaces:**
- Consumes: `extractMessengerTextMessage` de `../real/messenger-payload.js` (Task 4).
- Produces: `class MessengerMockAdapter implements MessagingAdapter` (con `sent: OutboundMessage[]` público para inspección en tests), exportada desde `packages/adapters/src/mocks/messenger.mock.ts`. Consumida por Task 7 (factory).

- [ ] **Step 1: Escribir el test (el módulo aún no existe)**

Crear `packages/adapters/src/mocks/messenger.mock.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { MessengerMockAdapter } from './messenger.mock.js';

describe('MessengerMockAdapter', () => {
  it('records sent messages instead of calling a real API', async () => {
    const adapter = new MessengerMockAdapter();
    const result = await adapter.send({ to: 'psid-1', body: 'Hola', channel: 'messenger' });

    expect(result.messageId).toMatch(/^messenger_msg_/);
    expect(adapter.sent).toEqual([{ to: 'psid-1', body: 'Hola', channel: 'messenger' }]);
  });

  it('parses a webhook payload the same way the real adapter does', async () => {
    const adapter = new MessengerMockAdapter();
    const inbound = await adapter.parseWebhook({}, {
      entry: [{ messaging: [{ sender: { id: 'psid-1' }, message: { mid: 'mid-1', text: 'Hola' } }] }],
    });

    expect(inbound).toMatchObject({ from: 'psid-1', body: 'Hola', channel: 'messenger', messageId: 'mid-1' });
  });

  it('throws on a payload with nothing actionable', async () => {
    const adapter = new MessengerMockAdapter();
    await expect(adapter.parseWebhook({}, { entry: [] })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm --filter @property-manager/adapters exec vitest run src/mocks/messenger.mock.test.ts`
Expected: FAIL — `Cannot find module './messenger.mock.js'`

- [ ] **Step 3: Implementar el mock**

Crear `packages/adapters/src/mocks/messenger.mock.ts`:

```typescript
/**
 * Mock de la Graph API de Messenger.
 * Simula el envío y recepción de mensajes sin llamar a Meta.
 */
import type {
  ChatChannel,
  InboundMessage,
  MessagingAdapter,
  OutboundMessage,
} from '../contracts.js';
import { extractMessengerTextMessage } from '../real/messenger-payload.js';

export class MessengerMockAdapter implements MessagingAdapter {
  readonly channel: ChatChannel = 'messenger';

  sent: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    return { messageId: `messenger_msg_${Date.now()}` };
  }

  async parseWebhook(_headers: Record<string, string>, body: unknown): Promise<InboundMessage> {
    const extracted = extractMessengerTextMessage(body);
    if (!extracted) {
      throw new Error('Messenger webhook payload sin mensaje de texto procesable (eco, adjunto, o postback)');
    }
    return {
      from: extracted.senderId,
      body: extracted.text,
      channel: 'messenger',
      receivedAt: new Date().toISOString(),
      messageId: extracted.mid,
    };
  }
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm --filter @property-manager/adapters exec vitest run src/mocks/messenger.mock.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Exportar el mock**

En `packages/adapters/src/index.ts`, agregar (junto a `export * from './mocks/telegram.mock.js';`):
```typescript
export * from './mocks/messenger.mock.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/mocks/messenger.mock.ts packages/adapters/src/mocks/messenger.mock.test.ts packages/adapters/src/index.ts
git commit -m "feat: add MessengerMockAdapter"
```

---

### Task 7: Cablear Messenger en el factory de adapters

**Files:**
- Modify: `packages/adapters/src/factory.ts`
- Modify: `packages/adapters/src/factory.test.ts`

**Interfaces:**
- Consumes: `MessengerRealAdapter` (Task 5), `MessengerMockAdapter` (Task 6), `isIntegrationConfigured(env, 'messenger')` (Task 2).
- Produces: `createAdapters(env).messaging.messenger: MessagingAdapter` y `createAdapters(env).mockModes.messenger: boolean`.

- [ ] **Step 1: Escribir los tests del factory para Messenger (deben fallar — `messaging.messenger` no existe todavía)**

En `packages/adapters/src/factory.test.ts`, agregar al final del `describe('createAdapters', ...)` (antes del cierre):

```typescript
  it('uses Messenger mock messaging when Messenger credentials are not configured', () => {
    const adapters = createAdapters(baseEnv);

    expect(adapters.messaging.messenger).toBeInstanceOf(MessengerMockAdapter);
    expect(adapters.mockModes.messenger).toBe(true);
  });

  it('uses Messenger real messaging when Messenger credentials are configured', () => {
    const adapters = createAdapters({
      ...baseEnv,
      MESSENGER_PAGE_ACCESS_TOKEN: 'page-token-123',
      MESSENGER_APP_SECRET: 'app-secret-123',
    });

    expect(adapters.messaging.messenger).toBeInstanceOf(MessengerRealAdapter);
    expect(adapters.mockModes.messenger).toBe(false);
  });
```

Y en el bloque de imports del mismo archivo, agregar:
```typescript
import { MessengerMockAdapter } from './mocks/messenger.mock.js';
import { MessengerRealAdapter } from './real/messenger.real.js';
```

- [ ] **Step 2: Correr los tests nuevos y confirmar que fallan**

Run: `pnpm --filter @property-manager/adapters exec vitest run src/factory.test.ts`
Expected: FAIL — `adapters.messaging.messenger` es `undefined` (`Cannot read properties of undefined`).

- [ ] **Step 3: Cablear Messenger en el factory**

En `packages/adapters/src/factory.ts`, agregar los imports (junto a los de Telegram):
```typescript
import { MessengerMockAdapter } from './mocks/messenger.mock.js';
import { MessengerRealAdapter } from './real/messenger.real.js';
```

En el objeto `mockModes` dentro de `createAdapters`, agregar:
```typescript
    messenger: !isIntegrationConfigured(env, 'messenger'),
```
(junto a `telegram: !isIntegrationConfigured(env, 'telegram'),`)

En el objeto `messaging` que se retorna, agregar:
```typescript
      messenger: isIntegrationConfigured(env, 'messenger')
        ? new MessengerRealAdapter(env.MESSENGER_PAGE_ACCESS_TOKEN)
        : new MessengerMockAdapter(),
```
(junto al bloque de `telegram: isIntegrationConfigured(env, 'telegram') ? ... : ...,`)

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `pnpm --filter @property-manager/adapters exec vitest run`
Expected: PASS — toda la suite de `packages/adapters`, incluyendo los 2 tests nuevos.

Run: `pnpm --filter @property-manager/adapters exec tsc --noEmit`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/factory.ts packages/adapters/src/factory.test.ts
git commit -m "feat: wire Messenger into the adapters factory"
```

---

### Task 8: Rutas del webhook de Messenger

Última pieza: exponer `GET/POST /webhooks/messenger`, capturar el body crudo para la firma, y conectar el pipeline de claim/dedup + `handleInboundMessage`.

**Files:**
- Modify: `apps/api/src/app.ts` (capturar `req.rawBody` en el `express.json()` global)
- Modify: `apps/api/src/routes/webhooks.ts` (rutas nuevas + funciones exportadas)
- Create: `apps/api/src/routes/webhooks.messenger.test.ts`

**Interfaces:**
- Consumes: `validateMessengerWebhookSignature` (Task 3), `extractMessengerTextMessage` (Task 4), `claimWebhookMessage`/`completeWebhookMessage`/`failWebhookMessage` (Task 1), `getAdapters().messaging.messenger` (Task 7), `handleInboundMessage` (ya existente en `chatbot.service.ts`).
- Produces: `claimAndPrepareMessengerMessage(req: Request): Promise<MessengerClaimResult>`, `processClaimedMessengerMessage(claim): Promise<void>`, `resolveMessengerVerificationChallenge(query: Record<string, unknown>): { status: 200; challenge: string } | { status: 403 | 404 }` — todas exportadas desde `apps/api/src/routes/webhooks.ts`.

- [ ] **Step 1: Capturar el body crudo en el parser JSON global**

En `apps/api/src/app.ts`, cambiar:
```typescript
  app.use(express.json({ limit: '2mb' }));
```
a:
```typescript
  app.use(express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }));
```

(Esto captura el buffer crudo para **todas** las rutas JSON, no solo Messenger — es información inerte que solo `hasValidMessengerSignature` va a leer; no cambia el comportamiento de ninguna otra ruta.)

- [ ] **Step 2: Escribir los tests de la ruta (deben fallar — las funciones aún no existen)**

Crear `apps/api/src/routes/webhooks.messenger.test.ts`:

```typescript
import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';

/**
 * Mismo patrón que webhooks.twilio.test.ts: env mockeado con secretos de
 * prueba (no los de .env real), firma calculada igual que lo haría Meta,
 * para no depender de ni arriesgar credenciales/datos reales.
 */
const TENANT_ID = 'tenant_test_messenger_webhook_routing';
const TEST_APP_SECRET = 'test-only-messenger-app-secret';

vi.mock('../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env.js')>();
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      MESSENGER_APP_SECRET: TEST_APP_SECRET,
      MESSENGER_PAGE_ACCESS_TOKEN: '',
      MESSENGER_DEFAULT_TENANT_ID: TENANT_ID,
      MESSENGER_VERIFY_TOKEN: 'test-verify-token',
      ZAI_API_KEY: '',
    }),
  };
});

const {
  claimAndPrepareMessengerMessage,
  processClaimedMessengerMessage,
  resolveMessengerVerificationChallenge,
} = await import('./webhooks.js');

function messengerTextPayload(senderId: string, mid: string, text: string) {
  return {
    entry: [{ messaging: [{ sender: { id: senderId }, message: { mid, text } }] }],
  };
}

function signedMessengerRequest(body: object): Request {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  const signature = `sha256=${createHmac('sha256', TEST_APP_SECRET).update(rawBody).digest('hex')}`;
  return {
    headers: { 'x-hub-signature-256': signature },
    body,
    rawBody,
  } as unknown as Request;
}

async function cleanup() {
  await prisma.webhookReceipt.deleteMany({ where: { tenantId: TENANT_ID } });
  const conversations = await prisma.chatConversation.findMany({
    where: { tenantId: TENANT_ID },
    select: { id: true },
  });
  const conversationIds = conversations.map((c) => c.id);
  if (conversationIds.length > 0) {
    await prisma.conversationSlot.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await prisma.chatMessage.deleteMany({ where: { conversationId: { in: conversationIds } } });
  }
  await prisma.chatConversation.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
}

describe('Messenger webhook verification', () => {
  it('echoes the challenge when the verify token matches', () => {
    expect(resolveMessengerVerificationChallenge({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': 'challenge-123',
    })).toEqual({ status: 200, challenge: 'challenge-123' });
  });

  it('rejects a mismatched verify token', () => {
    expect(resolveMessengerVerificationChallenge({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge-123',
    })).toEqual({ status: 403 });
  });
});

describe('Messenger webhook ack/dispatch', () => {
  beforeEach(async () => {
    await cleanup();
    await prisma.tenant.upsert({
      where: { id: TENANT_ID },
      update: {},
      create: { id: TENANT_ID, name: 'Messenger Webhook Routing Test', province: 'BC' },
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('claims a fresh text message fast, without running the bot', async () => {
    const req = signedMessengerRequest(messengerTextPayload('psid-1', 'mid-fresh-1', 'Hi, is anyone there?'));

    const claim = await claimAndPrepareMessengerMessage(req);

    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('Expected claim to succeed');
    expect(claim.shouldProcess).toBe(true);
    if (!claim.shouldProcess) throw new Error('Expected shouldProcess true for a fresh message');
    expect(claim.job.tenantId).toBe(TENANT_ID);
    expect(claim.job.mid).toBe('mid-fresh-1');
    expect(claim.job.inbound.body).toBe('Hi, is anyone there?');

    const receipt = await prisma.webhookReceipt.findFirst({
      where: { tenantId: TENANT_ID, providerMessageId: 'mid-fresh-1' },
    });
    expect(receipt?.status).toBe('processing');
  });

  it('rejects an invalid signature before touching the claim table', async () => {
    const req = signedMessengerRequest(messengerTextPayload('psid-2', 'mid-bad-sig', 'Hello'));
    (req.headers as Record<string, string>)['x-hub-signature-256'] = 'sha256=deadbeef';

    const claim = await claimAndPrepareMessengerMessage(req);

    expect(claim).toEqual({ ok: false, status: 403, error: 'Invalid Messenger signature' });
    const receiptCount = await prisma.webhookReceipt.count({ where: { tenantId: TENANT_ID } });
    expect(receiptCount).toBe(0);
  });

  it('ignores an echo of the bot\'s own message without claiming anything', async () => {
    const req = signedMessengerRequest({
      entry: [{ messaging: [{ sender: { id: 'psid-3' }, message: { mid: 'mid-echo', text: 'hi', is_echo: true } }] }],
    });

    const claim = await claimAndPrepareMessengerMessage(req);

    expect(claim).toEqual({ ok: true, shouldProcess: false });
    const receiptCount = await prisma.webhookReceipt.count({ where: { tenantId: TENANT_ID } });
    expect(receiptCount).toBe(0);
  });

  it('does not reprocess a message already delivered successfully (idempotent retry)', async () => {
    const req = signedMessengerRequest(messengerTextPayload('psid-4', 'mid-already-done', 'Retry me'));

    const firstClaim = await claimAndPrepareMessengerMessage(req);
    if (!firstClaim.ok || !firstClaim.shouldProcess) throw new Error('Expected first claim to be processable');
    await processClaimedMessengerMessage(firstClaim);

    const retryClaim = await claimAndPrepareMessengerMessage(req);

    expect(retryClaim).toEqual({ ok: true, shouldProcess: false });
  });

  it('returns 409 for a message another request is still processing', async () => {
    const req = signedMessengerRequest(messengerTextPayload('psid-5', 'mid-concurrent', 'Concurrent delivery'));

    const firstClaim = await claimAndPrepareMessengerMessage(req);
    expect(firstClaim.ok).toBe(true);

    const secondClaim = await claimAndPrepareMessengerMessage(req);

    expect(secondClaim).toEqual({
      ok: false,
      status: 409,
      error: 'Messenger message is still processing',
    });
  });

  it('processClaimedMessengerMessage runs the bot and marks the receipt completed', async () => {
    const req = signedMessengerRequest(messengerTextPayload('psid-6', 'mid-completes', 'Hi'));
    const claim = await claimAndPrepareMessengerMessage(req);
    if (!claim.ok || !claim.shouldProcess) throw new Error('Expected a processable claim');

    await processClaimedMessengerMessage(claim);

    const receipt = await prisma.webhookReceipt.findFirst({
      where: { tenantId: TENANT_ID, providerMessageId: 'mid-completes' },
    });
    expect(receipt?.status).toBe('completed');
    const conversation = await prisma.chatConversation.findFirst({
      where: { tenantId: TENANT_ID },
      include: { messages: true },
    });
    expect(conversation).not.toBeNull();
    expect(conversation!.messages.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Correr los tests y confirmar que fallan**

Run: `pnpm --filter @property-manager/api exec vitest run src/routes/webhooks.messenger.test.ts`
Expected: FAIL — `claimAndPrepareMessengerMessage`/`processClaimedMessengerMessage`/`resolveMessengerVerificationChallenge` no están exportadas desde `webhooks.ts`.

- [ ] **Step 4: Implementar las rutas y funciones exportadas**

En `apps/api/src/routes/webhooks.ts`, agregar los imports nuevos (junto a los existentes de Twilio):
```typescript
import { validateMessengerWebhookSignature } from '../services/messenger-webhook-security.service.js';
import { extractMessengerTextMessage } from '@property-manager/adapters';
```

Agregar las rutas (después del bloque de rutas de Twilio, antes del webhook de ShowMojo):
```typescript
webhooksRouter.get('/messenger', (req, res) => {
  const result = resolveMessengerVerificationChallenge(req.query as Record<string, unknown>);
  if (result.status === 200) {
    res.status(200).type('text/plain').send(result.challenge);
    return;
  }
  res.status(result.status).end();
});

webhooksRouter.post('/messenger', async (req, res, next) => {
  try {
    await acknowledgeAndDispatchMessenger(req, res);
  } catch (err) {
    next(err);
  }
});
```

Agregar las funciones exportadas y helpers (por ejemplo, después de `collectTwilioMediaUrls`/antes de `sendTwilioWebhookAccepted`, o en cualquier punto del archivo a nivel de módulo):
```typescript
export function resolveMessengerVerificationChallenge(
  query: Record<string, unknown>,
): { status: 200; challenge: string } | { status: 403 | 404 } {
  const env = getEnv();
  if (!env.MESSENGER_VERIFY_TOKEN) {
    return { status: 404 };
  }
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token === env.MESSENGER_VERIFY_TOKEN && typeof challenge === 'string') {
    return { status: 200, challenge };
  }
  return { status: 403 };
}

export type MessengerClaimResult =
  | { ok: false; status: 403 | 409; error: string }
  | { ok: true; shouldProcess: false }
  | { ok: true; shouldProcess: true; job: ClaimedMessengerMessageJob };

export type ClaimedMessengerMessageJob = {
  tenantId: string;
  mid: string;
  claimToken: string;
  inbound: InboundMessage;
};

function hasValidMessengerSignature(req: Request): boolean {
  const env = getEnv();
  if (!env.MESSENGER_APP_SECRET) {
    return true;
  }
  const signatureHeader = req.headers['x-hub-signature-256'];
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  return validateMessengerWebhookSignature({
    appSecret: env.MESSENGER_APP_SECRET,
    rawBody,
    signatureHeader: typeof signatureHeader === 'string' ? signatureHeader : undefined,
  });
}

/**
 * Igual que claimAndPrepareTwilioMessage: solo el trabajo rápido antes de
 * responderle a Meta (firma, extracción del mensaje, claim/dedup). A
 * diferencia de Twilio, el ID de dedup (`mid`) está anidado dentro del
 * payload — hay que parsearlo antes de poder reclamar.
 */
export async function claimAndPrepareMessengerMessage(req: Request): Promise<MessengerClaimResult> {
  if (!hasValidMessengerSignature(req)) {
    return { ok: false, status: 403, error: 'Invalid Messenger signature' };
  }

  const extracted = extractMessengerTextMessage(req.body);
  if (!extracted) {
    // Eco, adjunto, postback, o payload sin nada procesable: no es un
    // error — Meta debe seguir viendo 200, simplemente no hay nada que
    // reclamar ni procesar.
    return { ok: true, shouldProcess: false };
  }

  const env = getEnv();
  const tenantId = env.MESSENGER_DEFAULT_TENANT_ID;
  const claim = await claimWebhookMessage('messenger', tenantId, extracted.mid);
  if (claim.state === 'completed') {
    return { ok: true, shouldProcess: false };
  }
  if (claim.state === 'processing') {
    return { ok: false, status: 409, error: 'Messenger message is still processing' };
  }
  if (claim.state === 'failed') {
    return { ok: false, status: 409, error: 'Messenger message requires manual retry' };
  }

  return {
    ok: true,
    shouldProcess: true,
    job: {
      tenantId,
      mid: extracted.mid,
      claimToken: claim.claimToken,
      inbound: {
        from: extracted.senderId,
        body: extracted.text,
        channel: 'messenger',
        receivedAt: new Date().toISOString(),
        messageId: extracted.mid,
      },
    },
  };
}

/**
 * Igual que processClaimedTwilioMessage: corre el bot y entrega la
 * respuesta, sin bloquear la conexión HTTP del webhook (no se espera).
 */
export async function processClaimedMessengerMessage(
  claim: Extract<MessengerClaimResult, { shouldProcess: true }>,
): Promise<void> {
  const { tenantId, mid, claimToken, inbound } = claim.job;
  const adapters = getAdapters();
  try {
    await handleInboundMessage(
      { tenantId, from: inbound.from, body: inbound.body, channel: 'messenger' },
      { glm: adapters.glm, messaging: adapters.messaging.messenger, showmojo: adapters.showmojo },
    );
    await completeWebhookMessage('messenger', tenantId, mid, claimToken);
  } catch (error) {
    await failWebhookMessage('messenger', tenantId, mid, claimToken);
    throw error;
  }
}

async function acknowledgeAndDispatchMessenger(req: Request, res: Response): Promise<void> {
  const claim = await claimAndPrepareMessengerMessage(req);
  if (!claim.ok) {
    res.status(claim.status).json({ error: claim.error });
    return;
  }
  res.status(200).json({ status: 'received' });
  if (claim.shouldProcess) {
    void processClaimedMessengerMessage(claim).catch((err) => {
      console.error('[Messenger webhook] Background processing failed:', err);
    });
  }
}
```

- [ ] **Step 5: Correr los tests y confirmar que pasan**

Run: `pnpm --filter @property-manager/api exec vitest run src/routes/webhooks.messenger.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Correr toda la suite y el typecheck**

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — toda la suite, incluyendo `webhooks.twilio.test.ts` (no debería verse afectado).

Run: `pnpm --filter @property-manager/api exec tsc --noEmit`
Expected: sin errores.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/routes/webhooks.ts apps/api/src/routes/webhooks.messenger.test.ts
git commit -m "feat: add Facebook Messenger webhook routes"
```

---

### Task 9: Regresión completa

**Files:** ninguno nuevo — solo verificación.

- [ ] **Step 1: Typecheck de todo el monorepo**

Run: `pnpm -r exec tsc --noEmit`
Expected: sin errores en ningún paquete.

- [ ] **Step 2: Suite completa de tests**

Run: `pnpm --filter @property-manager/api exec vitest run`
Expected: PASS — todos los tests (los ya existentes + los de Messenger).

Run: `pnpm --filter @property-manager/adapters exec vitest run`
Expected: PASS — todos los tests.

- [ ] **Step 3: Confirmar que el estado mock sigue siendo el default sin `.env` de Messenger**

Run: `pnpm --filter @property-manager/api exec node -e "const { loadEnv, isIntegrationConfigured } = require('@property-manager/config'); const env = loadEnv(); console.log('messenger mock mode:', !isIntegrationConfigured(env, 'messenger'));"`
Expected: imprime `messenger mock mode: true` mientras `MESSENGER_PAGE_ACCESS_TOKEN`/`MESSENGER_APP_SECRET` no estén en `.env` — confirma que la app sigue arrancando sin credenciales de Messenger.

- [ ] **Step 4: Commit (si algún ajuste fue necesario durante la regresión)**

Si los steps 1-3 no requirieron cambios, no hay nada que comitear — este task solo confirma el estado verde acumulado de los Tasks 1-8.

---

## Después de completar las tareas

Con los 9 tasks en verde, el código está listo pero **no probado contra Meta real**. El siguiente paso (fuera de este plan, hecho en la sesión principal junto con el usuario, no delegable a un subagente porque requiere su cuenta de Facebook/Meta) es:

1. Guiar al usuario paso a paso para crear la Facebook Page de prueba + la Meta Developer App.
2. Configurar `MESSENGER_PAGE_ACCESS_TOKEN`, `MESSENGER_APP_SECRET`, `MESSENGER_VERIFY_TOKEN` en `.env` (el usuario los pega directamente, igual que con Twilio).
3. Levantar el túnel de ngrok, conectar la URL del webhook en la consola de Meta (dispara el handshake `GET /webhooks/messenger`).
4. Agregar al usuario como tester de la Page.
5. Mandar un mensaje real desde Messenger y confirmar que la conversación aparece en el dashboard y la respuesta llega.
