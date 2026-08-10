# Configurar Google Calendar (Fase 1.3)

Guía para conectar el calendario del property manager y que el asistente
pueda agendar showings solo. Ver el diseño completo en
[`docs/superpowers/sdd/2026-08-10-fase-1-3-google-calendar/`](./superpowers/sdd/2026-08-10-fase-1-3-google-calendar/).

No necesitas ayuda de Claude Code para estos pasos — son 100% en la
consola de Google Cloud con tu propia cuenta. Al final solo faltan un par
de variables de entorno.

## 1. Crear el proyecto en Google Cloud Console

Ve a [console.cloud.google.com](https://console.cloud.google.com/) →
selector de proyecto (arriba) → **Nuevo proyecto**. Cualquier nombre sirve
(ej. "Property Manager").

## 2. Habilitar la Google Calendar API

Con el proyecto seleccionado, ve a **APIs y servicios → Biblioteca**,
busca **Google Calendar API** y haz clic en **Habilitar**.

## 3. Configurar la pantalla de consentimiento OAuth

En **APIs y servicios → Pantalla de consentimiento de OAuth**:

1. Tipo de usuario: **Externo** (a menos que tengas Google Workspace y
   quieras restringirlo a tu organización).
2. Completa el nombre de la app y el correo de soporte.
3. En **Scopes**, agrega exactamente estos tres:
   - `https://www.googleapis.com/auth/calendar.freebusy`
   - `https://www.googleapis.com/auth/calendar.app.created`
   - `openid`
   - `email`

## 4. Crear credenciales OAuth de tipo Aplicación web

En **APIs y servicios → Credenciales → Crear credenciales → ID de cliente
de OAuth**, tipo de aplicación **Aplicación web**. Al terminar, Google te
da un `Client ID` y un `Client secret`.

## 5. Registrar la URI de redirección

En la misma pantalla de credenciales, en **URIs de redirección
autorizados**, registra la de la **API** (sin `/api`):

```
https://<host-de-la-api>/integrations/google-calendar/callback
```

y en local:

```
http://localhost:4000/integrations/google-calendar/callback
```

Debe coincidir carácter por carácter con la que manda la app o Google
rechaza el canje del código de autorización.

## 6. Configurar las variables de entorno

En `apps/api/.env`:

```
GOOGLE_CLIENT_ID="<el Client ID del paso 4>"
GOOGLE_CLIENT_SECRET="<el Client secret del paso 4>"
GOOGLE_OAUTH_REDIRECT_URI="<opcional — solo si la URI no se puede derivar del host de la API>"
```

## 7. Conectar desde la app

Reinicia la API si ya estaba corriendo, entra a la app y ve a
**Showings → Agenda y calendario → Conectar Google Calendar**.

## ⚠️ Modo Testing y refresh tokens de 7 días

Mientras la app esté en modo **Testing** en la pantalla de consentimiento
OAuth, **Google caduca los refresh tokens a los 7 días**, y el calendario
se desconectará solo cada semana. Para que dejen de caducar hay que
**publicar la app a producción** en la pantalla de consentimiento (no
requiere el proceso completo de verificación de Google mientras solo se
usen estos tres scopes de bajo riesgo).

## Qué NO puede ver la app

Con los scopes de arriba, la app solo puede leer y crear bloques de
**ocupado/disponible** en el calendario — nunca ve títulos, invitados ni
descripciones de eventos personales del manager.

## Si algo falla

- **"redirect_uri_mismatch" al conectar:** la URI registrada en el paso 5
  no coincide carácter por carácter con la que la API está mandando
  (revisa `http` vs `https`, el puerto, y que no tenga `/api`).
- **El calendario se desconecta cada semana:** la app sigue en modo
  Testing (ver la advertencia arriba) — publícala a producción.
- **"invalid_client" al canjear el código:** `GOOGLE_CLIENT_ID` o
  `GOOGLE_CLIENT_SECRET` no coinciden con los del paso 4, o el `.env` no
  se recargó tras editarlo.
