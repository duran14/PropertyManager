# Configurar Facebook Messenger (Fase 1.1)

Guía para conectar el canal de Messenger a una Page de prueba en modo
desarrollo/tester (sin App Review de Meta). Ver el diseño completo en
[`docs/superpowers/specs/2026-08-05-messenger-integration-design.md`](./superpowers/specs/2026-08-05-messenger-integration-design.md).

No necesitas ayuda de Claude Code para estos pasos — son 100% en las
consolas de Meta/Facebook con tu propia cuenta. Al final solo faltan 4
variables de entorno.

## 1. Crear una Facebook Page de prueba

Si no tienes una: [facebook.com/pages/create](https://www.facebook.com/pages/create) →
cualquier nombre/categoría sirve para pruebas (ej. "Property Manager Demo").

## 2. Crear una Meta Developer App

1. Ve a [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Crear app**.
2. Tipo de app: **Otro** → **Empresa** (o el flujo que te ofrezca "Messenger").
3. Dentro del panel de la app, en **Agregar productos**, agrega **Messenger**.

## 3. Conectar la Page y obtener el Page Access Token

1. En el panel de **Messenger → Configuración de la API**, en la sección
   "Tokens de acceso", conecta la Page que creaste en el paso 1.
2. Genera el **Page Access Token** — es un texto largo que empieza distinto
   cada vez que lo regeneras. Este es tu `MESSENGER_PAGE_ACCESS_TOKEN`.

## 4. Obtener el App Secret

En **Configuración de la app → Básica**, el campo **Clave secreta** (haz clic
en "Mostrar", te pedirá tu contraseña de Facebook). Este es tu
`MESSENGER_APP_SECRET`.

## 5. Levantar el túnel de ngrok

Igual que hicimos con WhatsApp — necesitas una URL pública apuntando a tu
API local (puerto 4000):

```bash
ngrok http 4000
```

Copia la URL `https://algo.ngrok-free.dev` (o tu dominio reservado si ya
tienes uno).

## 6. Configurar el webhook en Meta

En **Messenger → Configuración de la API → Webhooks** (o **Configuración de
la app → Webhooks**):

1. **URL de callback:** `https://TU-TUNEL.ngrok-free.dev/webhooks/messenger`
2. **Token de verificación:** invéntate un texto cualquiera (ej. una
   contraseña larga aleatoria) — este mismo texto es tu
   `MESSENGER_VERIFY_TOKEN`. Meta lo usa una sola vez, al guardar, para
   confirmar que la URL es tuya.
3. Guarda. Si el `.env` ya tiene `MESSENGER_VERIFY_TOKEN` configurado con
   el mismo valor y el servidor está corriendo, Meta debería aceptar la
   URL de inmediato (responde el `hub.challenge` que manda Meta).
4. En **Campos del webhook**, suscríbete al menos a **messages**.
5. Vuelve a la sección de tokens (paso 3) y confirma que la Page está
   suscrita al webhook.

## 7. Agregarte como tester

En **Roles de la app → Roles**, agrégate como **Administrador** o **Tester**
si no lo estás ya (normalmente el creador de la app ya lo es). Sin App
Review, **solo los admins/testers de la app pueden escribirle a la Page**
— cualquier otra cuenta de Facebook no recibirá respuesta. Esto es
intencional para esta fase (ver el spec).

## 8. Configurar las variables de entorno

En `apps/api/.env` (y en la raíz del monorepo, `.env` — ambos archivos
existen y Vitest/Prisma leen el de la raíz; copia los mismos valores a
los dos por consistencia):

```
MESSENGER_PAGE_ACCESS_TOKEN="<el token del paso 3>"
MESSENGER_APP_SECRET="<la clave secreta del paso 4>"
MESSENGER_VERIFY_TOKEN="<el texto que inventaste en el paso 6>"
MESSENGER_DEFAULT_TENANT_ID="tenant_demo_pm"
```

`MESSENGER_DEFAULT_TENANT_ID` puede quedarse en `tenant_demo_pm` (el tenant
de demo del MVP) a menos que quieras probar con otro tenant existente.

## 9. Reiniciar la API

Si `pnpm --filter @property-manager/api dev` ya estaba corriendo,
reinícialo para que recoja las nuevas variables de entorno.

## 10. Probarlo

1. Abre Messenger (app o web) con la cuenta de Facebook que agregaste como
   tester en el paso 7.
2. Busca tu Page y mándale un mensaje de texto (ej. "Hola, busco depa de
   2 recámaras en Surrey").
3. Deberías recibir una respuesta del bot en segundos.
4. En el dashboard del Property Manager, la conversación debería aparecer
   en **Conversaciones** con `channel: messenger`, y el lead correspondiente
   en **Leads** con `source: messenger`.

## Si algo falla

- **Meta no acepta la URL del webhook al guardar:** revisa que el servidor
  esté corriendo, que el túnel de ngrok siga activo, y que
  `MESSENGER_VERIFY_TOKEN` en `.env` sea idéntico al que pusiste en la
  consola de Meta (sensible a mayúsculas/espacios).
- **El bot no responde:** revisa los logs de la API — un `403 Invalid
  Messenger signature` casi siempre significa que `MESSENGER_APP_SECRET`
  no coincide con el de la consola, o que el `.env` no se recargó tras
  editarlo.
- **"Esta persona no puede recibir mensajes ahora mismo" o nada llega:**
  confirma que la cuenta que escribe es admin/tester de la app (paso 7) —
  sin App Review, es la causa más común.
