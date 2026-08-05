# Technical Specification & Roadmap: Property Management SaaS

**Target:** AI-Driven Property Management & Trust Accounting Platform
**Architecture:** Modular Next.js/Node.js stack with Supabase / PostgreSQL backend.

> Este documento captura el roadmap de producto más allá del MVP actual (ver
> [`README.md`](../README.md) para el estado del MVP y
> [`PROJECT_HANDOFF.md`](./PROJECT_HANDOFF.md) para el estado técnico
> verificado). Las Fases 1-2 asumen el asistente omnicanal ya construido
> (ver [`CHANNEL_ROLLOUT_PLAN.md`](./CHANNEL_ROLLOUT_PLAN.md) y
> [`GUIA_MODULO_COMUNICACION_OMNICANAL.md`](./GUIA_MODULO_COMUNICACION_OMNICANAL.md))
> y lo extienden a un canal e integraciones nuevas.
>
> **Validado contra industria (ago 4, 2026):** conversación con Jorge Capote,
> asistente de un property manager/broker en operación real, confirmó el
> enfoque de las Fases 1, 2, 3 y 5 tal cual estaban documentadas, y motivó
> dos cambios: (a) la Fase 1B (remarketing) es nueva — no estaba en ningún
> lado; (b) la Fase 3 subió de "Importante" a "Urgente" — Jorge la describió
> sin dudar como *"el pollo, arroz con pollo"* (lo esencial del negocio:
> recibir la renta y pagar los bills), por encima de Messenger o screening.

## Execution Roadmap & Priority Matrix

```
[FASE 1: Messenger & Lead Auto-Booking] ──► [FASE 1B: Lead Re-engagement]
                       │
                       ▼
[FASE 2: Post-Showing & Screening] ──► [FASE 3: Core Ledger & Owner Statements]
                       │
                       ▼
[FASE 4: Listing Syndication] ──► [FASE 5: QB Integration & Time Tracking]
                       │
                       ▼
[FASE 6: Native Payroll & Embedded Finance]
```

| Fase | Objetivo | Prioridad | Complejidad |
|---|---|---|---|
| 1 | Facebook Messenger + auto-booking de showings | Urgente | Fácil |
| 1B | Lead re-engagement / remarketing con memoria de conversación | Importante | Fácil |
| 2 | Post-showing automation + tenant screening | Urgente | Media |
| 3 | Core ledger (trust accounting) + owner statements | **Urgente** | Media |
| 4 | Listing syndication / multi-posting | Moderado | Complejo |
| 5 | QuickBooks sync + time tracking | Futuro | Medio |
| 6 | Native accounting + embedded payroll | Largo plazo | Difícil |

---

## 🟢 Fase 1: Facebook Messenger Integration & Auto-Booking

**Prioridad:** Urgente / Fácil

**Objetivo:** Capturar leads automáticamente desde Facebook Marketplace/Messenger, responder FAQs con el asistente de IA y agendar citas de visualización (showings) en el calendario del property manager.

### 1.1 Meta / Facebook Messenger Webhook

- **Endpoint:** `/api/webhooks/messenger`
- **Funcionalidad:**
  - Validar tokens de verificación de Meta (`hub.verify_token`).
  - Ingesta de mensajes entrantes (`page_messaging`) y vinculación con la entidad `Lead`.
  - Procesar respuestas mediante el motor de IA con contexto de la propiedad asociada al anuncio.

### 1.2 Hand-off de IA a Humano

- **Trigger:** cuando el intent del usuario sea `REQUEST_HUMAN` o la confianza del modelo sea baja.
- **Acción:**
  - Cambiar el estado del chat en DB a `human_takeover: true`.
  - Pausar respuestas automáticas del bot.
  - Disparar una notificación instantánea al manager (Telegram Bot Webhook / Push / WhatsApp API) con el enlace directo al chat.

### 1.3 Asignación de Showings y Sync de Calendario

- **Integración:** Google Calendar API (OAuth 2.0 per User/Manager).
- **Lógica:**
  - Leer eventos existentes para identificar huecos disponibles según el horario configurado del manager (ej. L-V 9:00-17:00).
  - Ocultar razones personales del calendario (mostrar únicamente slots como `Disponible` / `Ocupado`).
  - Generar la cita en Google Calendar y crear el registro en la tabla `showings`.

---

## 🟢 Fase 1B: Lead Re-engagement / Remarketing con Memoria de Conversación

**Prioridad:** Importante / Fácil

**Objetivo:** aprovechar el historial de conversación que el asistente omnicanal ya guarda (base de datos existente, sin infraestructura nueva) para recontactar automáticamente a leads que escribieron pero nunca agendaron un showing — antes de que se enfríen.

> Origen: idea surgida en la conversación con Jorge Capote — el volumen alto
> de mensajes por Facebook Messenger hace que muchos leads se pierdan sin
> seguimiento porque nadie tiene tiempo de darles una segunda vuelta.

### 1B.1 Selección de audiencia

- Query periódica (ej. mensual, configurable) sobre `Lead`/`ChatConversation`: leads con `status` en el funnel temprano (`new_`, `contacted`) sin `Showing` asociado, y sin actividad reciente (ej. > 14 días desde el último mensaje).
- Excluir leads marcados como `lost` o con `handoff` humano sin resolver.

### 1B.2 Generación y envío del mensaje de reactivación

- El asistente de IA redacta un mensaje de seguimiento corto usando el contexto ya guardado de esa conversación (área, presupuesto, unidad que le interesó) — no un mensaje genérico.
- Envío por el mismo canal donde se originó la conversación (`preferredChannel` / `lastChannel`, ya trackeados en el MVP actual).
- Reutiliza el `MessagingAdapter` y el patrón de reintentos de entrega ya construidos para el asistente omnicanal — no requiere una integración nueva, solo un job programado (BullMQ, ya en uso para otros jobs periódicos).

### 1B.3 Control de frecuencia y opt-out

- Un lead no debe recibir más de N mensajes de remarketing (ej. 1 por ciclo) para evitar sentirse acosado.
- Respetar cualquier señal previa de "no interesado" / solicitud de no ser contactado.

---

## 🟡 Fase 2: Post-Showing Automation & Tenant Screening

**Prioridad:** Urgente / Media

**Objetivo:** Automatizar el seguimiento tras el showing y consultar el historial crediticio y penal del candidato, reduciendo la intervención manual.

### 2.1 Post-Showing Form Trigger

- **Trigger:** transcurridas 2 horas desde la finalización del evento `showing` en el calendario.
- **Acción:** enviar un mensaje con un enlace seguro (`/apply/[showing_id]`) con token temporal, conteniendo el formulario de solicitud formal de arrendamiento (ingresos, referencias, identificación, autorización firmada).

### 2.2 Tenant Screening Engine

- **Mecanismo primario (API directa):** integración mediante API/webhooks con proveedores de screening (ej. TransUnion SmartMove, Certn, SingleKey).
- **Mecanismo secundario (browser automation / fallback):**
  - Script/worker asíncrono con Playwright / browser-use para portales cerrados.
  - Autenticación con credenciales cifradas de la agencia (`vault.credentials`).
  - Ingesta de datos del candidato → ejecución de consulta → extracción del status (`PASS` / `FLAGGED`) y score crediticio → captura de pantalla de la confirmación.
- **Mecanismo terciario (PDF parser / OCR):** extracción de datos clave mediante visión/OCR si el manager sube el reporte manualmente en PDF.

---

## 🟠 Fase 3: Core Property Trust Accounting & Owner Statements

**Prioridad:** Urgente / Media *(elevada desde "Importante" — ver nota de validación arriba)*

**Objetivo:** Gestión contable por cuentas segregadas (trust account) con liquidación exacta en $0.00 al cierre de mes.

### 3.1 Modelo de datos (PostgreSQL / Supabase)

```sql
-- Schema simplificado para Trust Accounting
CREATE TABLE properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  reserve_fund_target NUMERIC DEFAULT 0.00,
  management_fee_percentage NUMERIC DEFAULT 12.5
);

CREATE TABLE property_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id),
  type TEXT CHECK (type IN ('RENT_INCOME', 'MANAGEMENT_FEE', 'REPAIR_EXPENSE', 'UTILITY_BILL', 'OWNER_PAYOUT')),
  amount NUMERIC NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

> Nota de integración: el MVP actual ya tiene un modelo de conciliación y
> `Money`/`audit` en `packages/core` (ver `docs/adr/ADR-004-confidence-veto.md`
> y `ADR-005-no-fund-custody.md`). Este esquema de Fase 3 debe reconciliarse
> con ese modelo existente en vez de vivir como un sistema paralelo — la
> "Regla de Oro" (nunca custodio de fondos) sigue aplicando aquí.

### 3.2 Algoritmo de liquidación mensual (Owner Statement)

```
Balance = Σ RENT_INCOME − Σ UTILITY_BILL − Σ REPAIR_EXPENSE − MANAGEMENT_FEE − RESERVE_FUND
```

- **Comisión automática:** `MANAGEMENT_FEE = RENT_INCOME × (12.5 / 100)`
- **Cierre de ciclo:**
  - Se emite el registro `OWNER_PAYOUT` equivalente al `Balance` resultante.
  - El balance disponible de la subcuenta de la propiedad para distribución se reinicia en $0.00 (manteniendo intacto el `reserve_fund_target` retenido).

---

## 🔵 Fase 4: Listing Syndication / Multi-posting

**Prioridad:** Moderado / Complejo

**Objetivo:** Publicar una vacante una sola vez y distribuirla a Facebook Marketplace y portales inmobiliarios.

### 4.1 Meta Real Estate Catalog Sync

- Implementar generación de XML/JSON bajo estándar RESO (Real Estate Standards Organization).
- Conectar con Graph API de Meta para sincronización automática con el catálogo de bienes raíces de la Facebook Page de la agencia.

### 4.2 API Syndication Middleware

- Conectar con APIs de distribución inmobiliaria (ej. RentLinx / ListHub API) para envío multicanal.
- Sincronizador de estado: al marcar una propiedad como `RENTED`, enviar señal `DELETE`/`UNPUBLISH` a todos los canales conectados de forma síncrona.

---

## 🟣 Fase 5: QuickBooks Integration & Employee Time Tracking

**Prioridad:** Futuro / Medio

**Objetivo:** Sincronizar finanzas con QuickBooks Online y recopilar horas trabajadas para nómina externa.

### 5.1 Sync bidireccional con QuickBooks Online API

- **Accounts Payable / Expenses:** mapear los gastos por propiedad registrados en el ledger hacia cuentas de gastos en QuickBooks.
- **Sync de depósitos:** importar transacciones bancarias para conciliación previa.

### 5.2 Time Tracking Module (mobile-friendly / PWA)

- Pantalla simple para empleados con botones `Clock In` / `Clock Out`.
- Captura de geolocalización opcional y cálculo de horas trabajadas por quincena.
- Exportación de hoja de horas (timesheet) lista para enviar al módulo de nómina de QuickBooks.

---

## 🔴 Fase 6: Native Light Accounting & Embedded Payroll

**Prioridad:** Largo plazo / Difícil

**Objetivo:** Sustituir QuickBooks por completo en la operación diaria de la agencia.

### 6.1 Native Bank Feed Connection

- Integración con Plaid / Flinks API para consumo de estados de cuenta en tiempo real.
- Motor de reglas e IA para autocategorización de transacciones bancarias entrantes.

### 6.2 Embedded Payroll Engine

- **Enfoque recomendado:** integración por API con plataformas de nómina incrustada (ej. Gusto Embedded API / Check HQ).
- **Funciones:** cálculo automático de retenciones fiscales de la jurisdicción, emisión de comprobantes de pago (pay stubs) y reporte fiscal automático a las agencias tributarias correspondientes.
