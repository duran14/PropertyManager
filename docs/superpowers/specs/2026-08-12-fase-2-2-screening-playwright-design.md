# Fase 2.2 (nivel 2) — Motor de screening vía automatización de navegador

**Fecha:** 2026-08-12
**Estado:** aprobado por el usuario, listo para plan de implementación
**Roadmap:** [`docs/PRODUCT_ROADMAP.md`](../../PRODUCT_ROADMAP.md) §2.2

## Problema

La Fase 2A ya captura, al enviar la solicitud de renta, dos consentimientos
por separado (`consentCreditCheckAt`, `consentPoliceCheckAt`), pero nadie
corre el checkeo real: hoy el consentimiento se guarda y ahí termina todo.

El roadmap especifica tres niveles de mecanismo para esta pieza — API
directa, automatización de navegador, y PDF+OCR manual — pensados como
niveles de un mismo sistema, no como opciones excluyentes. Investigación
de proveedores (fuera de este documento, resumida abajo) descartó uno de
los tres candidatos originales del roadmap y dejó dos: **FrontLobby**
(crédito, vía Equifax) y **Sterling** (antecedentes penales, con fuente
CPIC confirmada — a diferencia de FrontLobby y Certn, cuyo "background
check" es agregación de registros públicos, no verificación policial
certificada). TransUnion SmartMove se descartó: solo opera en EE.UU.

Ninguno de los dos publica documentación de API de autoservicio — el
acceso, si existe, pasa por ventas empresarial. Se mandó contacto directo
a ambos (plantillas en
[`docs/SCREENING_PROVIDER_OUTREACH.md`](../../SCREENING_PROVIDER_OUTREACH.md)),
pero no hay garantía de cuándo (o si) responden con acceso real.

Este spec cubre el **nivel 2**: automatizar el portal web de cada
proveedor con las credenciales de la propia agencia, como si un empleado
más lo operara. Es el camino que sí se puede construir sin depender de
que un tercero apruebe una solicitud de API — el usuario aún no tiene
cuenta con ninguno de los dos, así que hoy tampoco es inmediato, pero
crear una cuenta de cliente normal es un trámite propio, no una
aprobación de partner.

## Alcance

**Dentro:**

- Modelo de datos: campos de identidad faltantes en `RentalApplication`
  (fecha de nacimiento, dirección actual) y los campos de resultado de
  ambos checkeos.
- Bóveda de credenciales de la agencia, dándole uso real al modelo
  `IntegrationConfig` que existe en el schema desde el MVP original y
  nunca se conectó a nada.
- El contrato `ScreeningAdapter`, agnóstico de proveedor y de mecanismo —
  el mismo contrato que usará el nivel 1 (API) si algún día llega, y el
  nivel 3 (PDF+OCR) si hace falta.
- Disparo automático de ambos checkeos al enviar la solicitud, si ambos
  consentimientos están dados.
- El modelo de job asíncrono: envío + sondeo periódico, porque un
  checkeo de crédito/antecedentes casi nunca es instantáneo.
- Pantalla de "Integraciones" donde el manager guarda las credenciales de
  FrontLobby/Sterling.
- Extensión de la sección de aplicación en `ShowingsPage.tsx` con el
  resultado.
- Almacenamiento del reporte completo + resumen para decisión rápida.

**Fuera (decisiones explícitas):**

- **Los selectores/flujo exactos de automatización de cada portal.**
  Ningún selector CSS, nombre de campo, ni el número de pasos del login
  de FrontLobby o Sterling se puede verificar hoy — no existe cuenta
  creada con ninguno de los dos. El plan de implementación deja esto como
  una tarea explícita y bloqueada; ver Sección 5.
- **Nivel 1 (API directa) y Nivel 3 (PDF+OCR).** Quedan como fases
  futuras independientes detrás del mismo contrato `ScreeningAdapter` —
  ver Sección 3.
- **Verificación de dos factores / CAPTCHA en el login del proveedor.**
  Si el portal real los exige de forma consistente, la automatización
  desatendida deja de ser viable para ese proveedor y hay que revisar el
  enfoque en ese momento — no se puede diseñar una solución genérica sin
  saber si aplica.

## Restricciones globales

1. **Nunca reportar como hecho algo que no ocurrió.** Un login fallido,
   un selector roto, un timeout, o un CAPTCHA inesperado se traducen
   siempre en `status: 'failed'` con aviso al staff — nunca en un
   resultado inventado ni en silencio.
2. **Credenciales cifradas en reposo.** Usuario y contraseña de cada
   portal se cifran con `encrypt()`/`decrypt()` de
   `apps/api/src/config/crypto.ts` (AES-256-GCM, ya existe desde la
   Fase 1.3). Nunca en texto plano, nunca en logs, nunca en payloads de
   auditoría. La contraseña **nunca** se devuelve al frontend una vez
   guardada.
3. **Aislamiento por tenant.** Toda consulta filtra por `tenantId`.
4. **Errores por valor de retorno, no por excepción**, donde aplique — el
   manejador global de `app.ts` convierte cualquier `throw` en 500.
5. **El repo se queda verde.**
6. **Excepción única y documentada a "cero dependencias nuevas":**
   `@playwright/test` pasa de ser solo una devDependency de pruebas E2E a
   una dependencia real de `apps/api` en producción. Es la única forma de
   automatizar un navegador; no hay alternativa con `fetch` puro como el
   resto de los adapters de este proyecto.

---

## Arquitectura

```
apps/api/src/services/screening.service.ts
  ├─ trigger: al enviar la solicitud (Fase 2A), si ambos consentimientos
  │  existen, encola dos jobs independientes (crédito, antecedentes).
  │
  ├─ ScreeningAdapter (contrato, packages/adapters)
  │     PlaywrightScreeningAdapter   ← esta fase
  │     ScreeningMockAdapter         ← desarrollo y pruebas
  │     (futuro) FrontLobbyApiAdapter / SterlingApiAdapter — nivel 1
  │     (futuro) PdfOcrScreeningAdapter — nivel 3
  │
  └─ resultado → document-storage (reporte completo) + resumen +
     notifyStaffTargets (Fase 1.2) + sección en ShowingsPage.tsx
```

---

## 1. Modelo de datos

### 1.1 Campos de identidad faltantes en `RentalApplication`

Ni FrontLobby ni Sterling pueden identificar a una persona solo con
nombre — hace falta fecha de nacimiento y dirección actual. Se agregan al
mismo formulario público que ya pide ingresos y consentimientos
(`apps/web/src/pages/ApplyPage.tsx`), como campos requeridos:

```prisma
  dateOfBirth        DateTime?
  currentAddress     String?
  currentCity        String?
  currentProvince    String?
  currentPostalCode  String?
```

Nulables a nivel de base porque las solicitudes que ya existen en la BD
(sembradas antes de esta fase) no los tienen — la validación de
"requerido" vive en el formulario público (zod), no en el schema.

### 1.2 Resultado de los dos checkeos

Cada uno con su propio ciclo de vida — pueden completarse en momentos
distintos, uno puede fallar mientras el otro tiene éxito:

```prisma
  creditCheckStatus       String?   // requested | pending | passed | flagged | failed
  creditCheckSummary      String?
  creditCheckReportKey    String?
  creditCheckProviderRef  String?   // referencia para el job de sondeo
  creditCheckRequestedAt  DateTime?
  creditCheckCompletedAt  DateTime?

  criminalCheckStatus       String?
  criminalCheckSummary      String?
  criminalCheckReportKey    String?
  criminalCheckProviderRef  String?
  criminalCheckRequestedAt  DateTime?
  criminalCheckCompletedAt  DateTime?
```

`creditCheckReportKey`/`criminalCheckReportKey` son claves de
`document-storage.service.ts` (`DocumentObjectStorage.putObject`, ya
existe desde la Fase 2A para los IDs subidos) — el reporte completo se
guarda ahí, cifrado en el storage local igual que cualquier otro
documento sensible del sistema.

### 1.3 La bóveda de credenciales — `IntegrationConfig`

Este modelo existe en `schema.prisma` desde el MVP original
(`apps/api/prisma/schema.prisma`, sección "Integraciones — credenciales
cifradas por tenant") pero **nunca se conectó a nada real** — grep
confirma que solo aparece en comentarios aspiracionales
(`apps/api/src/config/adapters.ts`: *"aquí se construirá el adapter
leyendo IntegrationConfig del tenant"*). Esta fase le da su primer uso
real, sin cambiar su forma:

```prisma
model IntegrationConfig {
  id                    String    @id @default(cuid())
  tenantId              String
  provider              String // buildium | qbo | twilio | plaid | stripe | frontlobby_portal | sterling_portal
  encryptedCredentials  String
  encryptedRefreshToken String?
  status                String    @default("pending") // pending | connected | error
  lastSyncedAt          DateTime?
  ...
}
```

Solo cambia el comentario del campo `provider` (agregar
`frontlobby_portal | sterling_portal`) — sigue siendo un `String` libre,
no un enum, consistente con cómo ya está declarado.

`encryptedCredentials` guarda un JSON cifrado de una sola pieza:
`{ "username": "...", "password": "..." }`, serializado y luego pasado
por `encrypt()`. `status` refleja si el último intento de login
funcionó: `'connected'` tras un login exitoso, `'error'` si falló
(credenciales inválidas, cuenta bloqueada, etc.), lo que la pantalla de
Integraciones (Sección 4) muestra directo.

---

## 2. El contrato `ScreeningAdapter`

Vive en `packages/adapters/src/contracts.ts`, agnóstico de proveedor y
de mecanismo — el mismo contrato sirve para Playwright hoy, y para una
API real o un flujo de PDF+OCR el día que existan, sin que el resto del
sistema (job, storage, notificación, UI) tenga que cambiar:

```ts
export interface ScreeningApplicantInput {
  fullName: string;
  dateOfBirth: string; // ISO date
  currentAddress: string;
  currentCity: string;
  currentProvince: string;
  currentPostalCode: string;
  email?: string;
  phone?: string;
}

export type ScreeningCheckKind = 'credit' | 'criminal';

export type ScreeningRunResult =
  | {
    status: 'completed';
    verdict: 'passed' | 'flagged';
    summary: string;
    reportBase64: string;
    reportMimeType: string;
  }
  | { status: 'pending'; providerRef: string }
  | { status: 'failed'; reason: string };

export interface ScreeningAdapter {
  readonly name: string;
  /** Envía la solicitud. Para Playwright, casi siempre devuelve 'pending'. */
  runCheck(kind: ScreeningCheckKind, input: ScreeningApplicantInput): Promise<ScreeningRunResult>;
  /** Revisa si un envío 'pending' ya tiene resultado. */
  pollResult(kind: ScreeningCheckKind, providerRef: string): Promise<ScreeningRunResult>;
}
```

`pollResult` es necesario porque `ScreeningRunResult` con `status:
'pending'` no alcanza para el modelo de sondeo — hace falta un método
separado para "¿ya está listo lo que pedí?", distinto de "pedir uno
nuevo". Un adapter de nivel 1 (API con webhook) probablemente nunca use
`pollResult` en la práctica (el webhook empuja el resultado en vez de que
alguien pregunte), pero el contrato lo expone igual para que el modelo
de sondeo de Playwright tenga dónde vivir sin ensuciar la interfaz con
detalles específicos de un solo mecanismo.

---

## 3. `PlaywrightScreeningAdapter`

Implementación real de esta fase, en
`packages/adapters/src/real/screening-playwright.real.ts`. Depende de
`@playwright/test` (o el paquete `playwright` base — el plan de
implementación decide cuál, dado que `@playwright/test` ya está en el
`package.json` raíz).

**`runCheck`:**

1. Lanza un navegador headless, inicia sesión con las credenciales
   descifradas de `IntegrationConfig` para ese proveedor.
2. Navega al formulario de nueva solicitud de screening.
3. Llena los datos de `ScreeningApplicantInput`.
4. Envía y captura la referencia de la solicitud (el ID que el portal le
   asigna, para buscarla después).
5. Cierra el navegador. Devuelve `{ status: 'pending', providerRef }`.

**No se mantiene la sesión abierta esperando el resultado** — un checkeo
de crédito o antecedentes penales casi nunca es instantáneo, y una
sesión de navegador abierta por minutos u horas es frágil (se puede
caer, expirar, o levantar sospechas de automatización en el portal).

**`pollResult`:** inicia sesión de nuevo, busca la solicitud por
`providerRef`, y si el resultado ya está disponible, lo extrae
(veredicto, resumen, descarga del reporte) y lo devuelve como
`'completed'`. Si sigue en trámite, devuelve `'pending'` otra vez.

**Fallos:** login fallido, selector no encontrado, timeout, o cualquier
señal de que el portal cambió o pide algo inesperado (CAPTCHA, 2FA no
configurado) se capturan y devuelven `{ status: 'failed', reason }` —
nunca se relanza el error crudo hacia el llamador (Restricción global 1).

---

## 4. El job asíncrono

Dos piezas nuevas en `apps/api/src/jobs/queues.ts`, siguiendo el patrón
ya establecido (`remarketingQueue`/`reconciliationQueue`):

```ts
export interface ScreeningRequestJobData {
  tenantId: string;
  applicationId: string;
  kind: ScreeningCheckKind;
}

export const screeningRequestQueue = new Queue<ScreeningRequestJobData, unknown, string>(
  QUEUE_NAMES.screeningRequest,
  { connection: redis, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } } },
);

export interface ScreeningPollJobData {
  tenantId: string;
  applicationId: string;
  kind: ScreeningCheckKind;
  providerRef: string;
}

export const screeningPollQueue = new Queue<ScreeningPollJobData, unknown, string>(
  QUEUE_NAMES.screeningPoll,
  { connection: redis, defaultJobOptions: { attempts: 10, backoff: { type: 'fixed', delay: 15 * 60_000 } } },
);
```

El job de envío (`screeningRequestQueue`) corre una vez, llama a
`runCheck`, y si el resultado es `'pending'`, encola un job de sondeo con
`delay` inicial (ej. 15 minutos). El job de sondeo llama a `pollResult`;
si sigue `'pending'`, se vuelve a encolar a sí mismo con el mismo delay
(hasta el límite de `attempts`); si `'completed'` o `'failed'`, persiste
el resultado y termina.

**Tope de reintentos real:** 10 intentos × 15 minutos ≈ 2.5 horas de
sondeo. Si para entonces sigue sin resultado, el checkeo pasa a
`'failed'` con `reason: 'timeout'` y se avisa al staff — no se sondea
indefinidamente.

---

## 5. Lo que queda pendiente — la automatización específica de cada portal

**Esto es intencional, no un olvido.** El adapter de la Sección 3 define
el contrato y el esqueleto (login → navegar → llenar → enviar → extraer),
pero los selectores CSS reales, los nombres exactos de los campos del
formulario, cuántos pasos tiene el login, y si pide verificación en dos
pasos **no se pueden escribir sin ver el portal real** — no existe cuenta
creada con FrontLobby ni con Sterling todavía.

Restricción de seguridad que aplica aquí de forma directa: **el asistente
nunca introduce contraseñas del usuario en un formulario ni inicia sesión
en su nombre**, sin excepción. Eso significa que cuando exista la cuenta,
el camino para completar esta pieza es que el usuario navegue el portal
(login, pantalla de nueva solicitud, pantalla de resultado) mientras se
observa la estructura — o comparta capturas de pantalla — no que el
asistente entre con la contraseña real.

El plan de implementación construye todo lo demás (Secciones 1, 2, 4 de
este spec, más las Secciones 6 y 7 abajo) contra un
`ScreeningMockAdapter` determinista, y deja una tarea final explícita,
marcada como bloqueada, con instrucciones precisas de qué información
hace falta reunir cuando la cuenta exista, para escribir el
`PlaywrightScreeningAdapter` real sin adivinar.

---

## 6. Interfaz

**Pantalla de Integraciones** — ruta nueva `/integrations` en
`apps/web/src/App.tsx` (no existe hoy ninguna ruta de ajustes/credenciales
en la app; las existentes son `/properties`, `/leads`, `/showings`,
`/conversations`, `/sentinel`, `/bills`, `/leases`, `/reconciliation`,
`/owner-statements`, `/audit` — todas de datos operativos, ninguna de
configuración). `IntegrationsPage.tsx` nuevo, con entrada en el menú de
navegación de `Layout.tsx`. Una tarjeta por proveedor (FrontLobby,
Sterling): campos de usuario/contraseña, botón guardar, y un indicador de
estado (`connected` / `error` con el motivo / sin configurar). Solo
`property_manager` puede ver y editar. La contraseña nunca se pre-llena
ni se devuelve del backend — el campo siempre empieza vacío; guardar
sobrescribe la credencial anterior.

**Sección de aplicación en `ShowingsPage.tsx`:** debajo de los datos que
ya se muestran (ingresos, referencias, ID), dos bloques — crédito y
antecedentes — cada uno con estado (`requested`/`pending`/`passed`/
`flagged`/`failed`), el resumen si ya está listo, y un link para
descargar el reporte completo desde `document-storage`.

---

## 7. Pruebas

- **Contrato:** `ScreeningMockAdapter`, determinista, cubre `runCheck` y
  `pollResult` con casos completado-al-primer-intento,
  pendiente-luego-completado, y fallido — usado por todas las pruebas de
  servicio/job, nunca toca un navegador real.
- **Servicio:** disparo automático solo cuando ambos consentimientos
  existen; el job de envío persiste `creditCheckStatus: 'pending'` +
  `creditCheckProviderRef`; el job de sondeo transiciona a `'passed'`/
  `'flagged'`/`'failed'` correctamente; tope de reintentos agotado →
  `'failed'` con `reason: 'timeout'`; notificación al staff en cada
  transición a estado terminal.
- **Bóveda de credenciales:** guardar cifra antes de persistir; nunca se
  devuelve la contraseña en claro por ningún endpoint; `status` se
  actualiza tras un intento de login fallido/exitoso.
- **`PlaywrightScreeningAdapter` real:** fuera de alcance de este spec —
  se prueba contra fixtures locales (páginas HTML estáticas que simulan
  el portal) una vez que la Sección 5 esté resuelta, nunca contra el
  sitio real en CI.

---

## 8. Documentación

`docs/PRODUCT_ROADMAP.md` marca la §2.2 con una nota clara: nivel 2
entregado, nivel 1 y nivel 3 pendientes, y la automatización de portal
específica bloqueada hasta que existan las cuentas de FrontLobby/Sterling.
