/**
 * Contracts (ports) de todas las integraciones externas.
 *
 * Cada adapter implementa una de estas interfaces. La lógica de negocio en
 * `core` y `apps/api` depende SOLO de estas interfaces, nunca de implementaciones
 * concretas. Así podemos enchufar mocks hoy y APIs reales mañana sin tocar
 * el dominio.
 *
 * Convención: todas las interfaces son async porque las APIs reales lo son,
 * incluso si el mock es sincrónico internamente.
 */
import type {
  AccountCategory,
  Currency,
  IsoDate,
  Money,
} from '@property-manager/core';

// =============================================================================
// Buildium — gestión operativa (propiedades, contratos, pagos)
// =============================================================================

export interface BuildiumProperty {
  id: string;
  name: string;
  address: string;
  city: string;
  province: string;
}

export interface BuildiumUnit {
  id: string;
  propertyId: string;
  name: string; // ej: "Apt 302"
  rentCents: number;
}

export interface BuildiumLease {
  id: string;
  unitId: string;
  tenantName: string;
  tenantEmail: string;
  rentCents: number;
  startDate: IsoDate;
  endDate: IsoDate;
}

export interface BuildiumPayment {
  id: string;
  leaseId: string;
  amountCents: number;
  receivedAt: IsoDate;
  method: 'etransfer' | 'cheque' | 'bank_draft' | 'cash' | 'other';
  reference: string; // e-Transfer confirmation, cheque number, etc.
}

export interface BuildiumAdapter {
  readonly name: 'buildium';
  listProperties(): Promise<BuildiumProperty[]>;
  listUnits(propertyId: string): Promise<BuildiumUnit[]>;
  listLeases(unitId: string): Promise<BuildiumLease[]>;
  markLeasePaid(leaseId: string, payment: { amountCents: number; receivedAt: IsoDate; reference: string }): Promise<void>;
  /** Webhook events recibidos de Buildium (Payment/Tenant/Lease). */
  parseWebhook(headers: Record<string, string>, body: unknown): Promise<BuildiumWebhookEvent>;
}

export type BuildiumWebhookEvent =
  | { type: 'payment.received'; payment: BuildiumPayment }
  | { type: 'lease.created'; lease: BuildiumLease }
  | { type: 'lease.updated'; lease: BuildiumLease };

// =============================================================================
// QuickBooks Online — contabilidad (Bills, Journal Entries)
// =============================================================================

export interface QboBillLine {
  accountCategory: AccountCategory;
  description: string;
  amountCents: number;
}

export interface QboBill {
  id?: string;
  vendorName: string;
  billDate: IsoDate;
  dueDate?: IsoDate;
  currency: Currency;
  lines: QboBillLine[];
  /** Documento de origen (recibo) referenciado, para auditoría. */
  sourceDocumentRef?: string;
}

export interface QboJournalLine {
  accountName: string; // ej: "Trust Account", "Operating Account"
  amountCents: number; // positivo = débito, negativo = crédito
}

export interface QboJournalEntry {
  id?: string;
  date: IsoDate;
  memo: string;
  lines: QboJournalLine[];
}

export interface QboAdapter {
  readonly name: 'qbo';
  createBill(bill: QboBill): Promise<{ id: string }>;
  createJournalEntry(entry: QboJournalEntry): Promise<{ id: string }>;
  getAccountBalance(accountName: string, asOf: IsoDate): Promise<Money>;
  /** Sincroniza desde Buildium: crea Bills a partir de facturas pendientes. */
  parseWebhook(headers: Record<string, string>, body: unknown): Promise<QboWebhookEvent>;
}

export type QboWebhookEvent =
  | { type: 'bill.created'; bill: QboBill }
  | { type: 'payment.posted'; vendorName: string; amountCents: number; date: IsoDate };

// =============================================================================
// Twilio — WhatsApp/SMS para prospección y notificaciones
// =============================================================================

export interface TwilioMessage {
  to: string; // E.164 ej: +16045551234
  from: string;
  body: string;
  channel: 'whatsapp' | 'sms';
}

export interface TwilioInbound {
  from: string;
  to: string;
  body: string;
  channel: 'whatsapp' | 'sms';
  receivedAt: IsoDate;
  messageId: string;
}

export interface TwilioAdapter {
  readonly name: 'twilio';
  send(message: TwilioMessage): Promise<{ messageId: string }>;
  parseWebhook(headers: Record<string, string>, body: unknown): Promise<TwilioInbound>;
}

// =============================================================================
// MessagingAdapter — abstracción unificada para múltiples canales de chat.
//
// El chatbot depende de esta interfaz, no de adapters específicos por canal.
// Cada canal (Twilio/WhatsApp, Telegram, WebChat) implementa esta interfaz.
// =============================================================================

/** Canal de mensajería soportado por el chatbot. */
export type ChatChannel = 'whatsapp' | 'sms' | 'telegram' | 'messenger' | 'web' | 'email';

/** Mensaje saliente del bot hacia el usuario. */
export interface OutboundMessage {
  to: string; // identificador del destinatario (teléfono, chat id, session id)
  body: string;
  channel: ChatChannel;
  subject?: string;
}

/** Mensaje entrante del usuario hacia el bot, normalizado desde cualquier canal. */
export interface InboundMessage {
  from: string; // identificador del remitente
  body: string;
  channel: ChatChannel;
  receivedAt: IsoDate;
  messageId: string;
  /** URLs de media (imágenes) si el mensaje las incluye. */
  mediaUrls?: string[];
}

/**
 * Adapter unificado de mensajería.
 * Cada canal implementa esta interfaz; el chatbot no sabe qué canal es.
 */
export interface MessagingAdapter {
  readonly channel: ChatChannel;
  send(message: OutboundMessage): Promise<{ messageId: string }>;
  parseWebhook(headers: Record<string, string>, body: unknown): Promise<InboundMessage>;
  /**
   * Muestra el indicador de "escribiendo…" en el canal del usuario.
   * Opcional: solo los canales que lo soportan nativamente (Telegram) lo implementan.
   * Los adapters que no lo implementan simplemente dejan que el caller lo salte vía `?.`.
   */
  sendTyping?(chatId: string): Promise<void>;
  /** Envía una fotografía pública con un caption breve cuando el canal lo permite. */
  sendPhoto?(chatId: string, photoUrl: string, caption?: string): Promise<void>;
}

// =============================================================================
// GLM (Z.ai) — IA: reasoning + OCR
// =============================================================================

export interface GlmReasoningRequest {
  systemPrompt: string;
  userPrompt: string;
  /** JSON schema esperado en la respuesta para forzar salida estructurada. */
  responseSchema?: Record<string, unknown>;
  temperature?: number;
}

export interface GlmReasoningResponse {
  content: string;
  /** Confidence del modelo sobre su propia respuesta (0..1) si se pidió. */
  selfReportedConfidence?: number;
}

export interface OcrResult {
  vendorName: string;
  billDate: IsoDate;
  totalCents: number;
  currency: Currency;
  lineItems: Array<{
    description: string;
    amountCents: number;
    suggestedCategory: AccountCategory;
  }>;
  /** Confidence global de la extracción (0..1). */
  confidence: number;
}

export interface CreditReportExtraction {
  /** null si el modelo no pudo leer el gauge de score del PDF. */
  score: number | null;
  /** Texto completo de la sección "AI Summary" del reporte, tal cual. */
  aiSummaryText: string;
  /** Confidence global de la extracción (0..1). */
  confidence: number;
}

export interface GlmAdapter {
  readonly name: 'glm';
  reason(request: GlmReasoningRequest): Promise<GlmReasoningResponse>;
  /** OCR de un recibo/factura (PDF o imagen). */
  extractReceipt(input: { mimeType: string; base64: string; filename?: string }): Promise<OcrResult>;
  /** OCR de un reporte de crédito (PDF) — score + texto del resumen de IA. */
  extractCreditReport(input: { mimeType: string; base64: string; filename?: string }): Promise<CreditReportExtraction>;
}

// =============================================================================
// Plaid — lectura de saldos bancarios (solo lectura, NUNCA ejecución)
// =============================================================================

export interface PlaidAccount {
  accountId: string;
  name: string;
  mask: string; // últimos 4 dígitos
  type: 'depository' | 'credit' | 'loan' | 'other';
  currentBalanceCents: number;
  availableBalanceCents: number;
  currency: Currency;
}

export interface PlaidTransaction {
  id: string;
  accountId: string;
  amountCents: number; // negativo = salida
  date: IsoDate;
  name: string; // descripción
  pending: boolean;
}

export interface PlaidAdapter {
  readonly name: 'plaid';
  getAccounts(itemId: string): Promise<PlaidAccount[]>;
  getTransactions(itemId: string, startDate: IsoDate, endDate: IsoDate): Promise<PlaidTransaction[]>;
}

// =============================================================================
// Stripe Connect — REGLA DE ORO: solo autorización de instrucciones, nunca ejecución de fondos.
// En el MVP quedará como contract sin uso activo (no hay credenciales).
// =============================================================================

export interface StripeAdapter {
  readonly name: 'stripe';
  /** Crea un PaymentIntent (instrucción de cobro). No ejecuta por sí solo. */
  createPaymentIntent(input: {
    amountCents: number;
    currency: Currency;
    customerId?: string;
    description: string;
  }): Promise<{ id: string; clientSecret: string }>;
}

// =============================================================================
// PhotoEnhancement — Autoenhance.ai (mejora de fotos de inmuebles con IA)
//
// Tres capacidades:
//  - enhance: HDR, corrección de iluminación, sky replacement, day-to-dusk
//  - object_removal: quitar muebles, cajas, objetos que estorban
//  - virtual_staging: añadir muebles virtuales a habitaciones vacías
//
// Flujo asíncrono: se envía la imagen → se recibe un orderId → cuando termina,
// Autoenhance llama al webhook nuestro con la URL de la imagen procesada.
// =============================================================================

export type EnhancementType = 'enhance' | 'object_removal' | 'virtual_staging';

export interface EnhancementRequest {
  imageUrl: string; // URL pública de la imagen original
  type: EnhancementType;
  /** Estilo de staging (solo para virtual_staging). Ej: 'modern', 'scandinavian'. */
  style?: string;
}

export interface EnhancementResult {
  orderId: string; // ID para correlacionar con el webhook
  status: 'processing' | 'completed' | 'failed';
  enhancedUrl?: string; // URL de la imagen procesada (disponible al completar)
}

export interface PhotoEnhancementAdapter {
  readonly name: 'photo_enhancement';
  /** Envía una imagen para procesamiento. Devuelve el orderId para tracking. */
  requestEnhancement(request: EnhancementRequest): Promise<{ orderId: string }>;
  /** Consulta el estado de un procesamiento (alternativa al webhook). */
  getEnhancementStatus(orderId: string): Promise<EnhancementResult>;
  /** Parsea el webhook de Autoenhance cuando una imagen está lista. */
  parseWebhook(headers: Record<string, string>, body: unknown): Promise<{
    orderId: string;
    status: 'completed' | 'failed';
    enhancedUrl?: string;
  }>;
}

// =============================================================================
// ShowMojo — agendamiento de visitas a propiedades
//
// ShowMojo gestiona el calendario de brokers/PMs y permite a los prospectos
// agendar visitas. La integración es bidireccional:
//  - Outbound: pushListing (publicar unidad), getAvailableSlots (horarios)
//  - Inbound: webhooks (lead_captured, showing_scheduled, showing_confirmed)
// =============================================================================

export interface ShowMojoListing {
  code: string; // ID interno nuestro
  address: string;
  unit?: string;
  city: string;
  state: string; // 'BC'
  rentCents: number;
  beds?: number;
  baths?: number;
  title?: string;
}

export interface ShowMojoSlot {
  startAt: IsoDate; // inicio del horario disponible
  endAt: IsoDate;
  brokerName?: string;
}

export interface ShowMojoShowing {
  id: string;
  listingCode: string;
  slot: ShowMojoSlot;
  prospectName: string;
  prospectPhone?: string;
  prospectEmail?: string;
  status: 'scheduled' | 'confirmed' | 'cancelled' | 'completed';
  confirmUrl?: string; // URL que el broker usa para confirmar
  showmojoUrl?: string; // URL de la visita en ShowMojo
}

export type ShowMojoWebhookEvent =
  | { type: 'lead_captured'; leadName: string; leadPhone?: string; leadEmail?: string; listingCode: string }
  | { type: 'showing_scheduled'; showing: ShowMojoShowing }
  | { type: 'showing_confirmed'; showingId: string }
  | { type: 'showing_cancelled'; showingId: string; reason?: string };

export interface ShowMojoAdapter {
  readonly name: 'showmojo';
  /** Publica (o actualiza) una unidad como listing en ShowMojo. */
  pushListing(listing: ShowMojoListing): Promise<{ listingCode: string; showmojoUrl: string }>;
  /** Obtiene los horarios disponibles para visitar una unidad. */
  getAvailableSlots(listingCode: string, from: IsoDate, to: IsoDate): Promise<ShowMojoSlot[]>;
  /** Agenda una visita para un prospecto. */
  createShowing(input: {
    listingCode: string;
    slot: ShowMojoSlot;
    prospectName: string;
    prospectPhone?: string;
    prospectEmail?: string;
  }): Promise<{ showing: ShowMojoShowing }>;
  /** Obtiene los detalles de una visita. */
  getShowing(showingId: string): Promise<ShowMojoShowing>;
  /** Confirma una visita (desde el broker/PM). */
  confirmShowing(showingId: string): Promise<{ status: 'confirmed' }>;
  /** Cancela una visita. */
  cancelShowing(showingId: string, reason?: string): Promise<{ status: 'cancelled' }>;
  /** Parsea los webhooks entrantes de ShowMojo. */
  parseWebhook(headers: Record<string, string>, body: unknown): Promise<ShowMojoWebhookEvent>;
}

// -----------------------------------------------------------------------------
// Calendario — disponibilidad y eventos de showings
//
// El adapter NO sabe de la base de datos: recibe un access token ya válido y
// hace la llamada. Quien guarda, descifra y refresca tokens es el servicio.
// -----------------------------------------------------------------------------

export interface CalendarBusyInterval {
  startAt: IsoDate;
  endAt: IsoDate;
}

export interface CalendarEventInput {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  startAt: IsoDate;
  endAt: IsoDate;
  timeZone: string;
  /** Si viene vacío o ausente, el evento se crea sin invitados. */
  attendeeEmails?: string[];
}

export type CalendarRefreshResult =
  | { ok: true; accessToken: string; expiresInSeconds: number }
  | { ok: false; reason: 'revoked' | 'provider_error'; detail: string };

export interface CalendarAdapter {
  readonly name: 'google_calendar' | 'calendar_mock';

  /** Construye la URL de consentimiento. `state` va tal cual. */
  buildAuthorizeUrl(input: { redirectUri: string; state: string }): string;

  exchangeAuthorizationCode(input: { code: string; redirectUri: string }): Promise<{
    refreshToken: string;
    accessToken: string;
    expiresInSeconds: number;
    accountEmail: string;
  }>;

  /**
   * Discriminado a propósito: distinguir "el manager revocó el acceso" de
   * "Google está caído" cambia lo que hace el sistema — lo primero apaga la
   * conexión, lo segundo es transitorio.
   */
  refreshAccessToken(input: { refreshToken: string }): Promise<CalendarRefreshResult>;

  /** Crea el calendario "Property Showings" si no existe. Idempotente. */
  ensureShowingsCalendar(input: {
    accessToken: string;
    timeZone: string;
  }): Promise<{ calendarId: string }>;

  getBusy(input: {
    accessToken: string;
    calendarIds: string[];
    from: IsoDate;
    to: IsoDate;
  }): Promise<CalendarBusyInterval[]>;

  createEvent(
    input: { accessToken: string } & CalendarEventInput,
  ): Promise<{ eventId: string; htmlLink?: string }>;

  deleteEvent(input: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<void>;
}

// -----------------------------------------------------------------------------
// Screening — checkeo de crédito y antecedentes penales de un solicitante.
//
// Agnóstico de proveedor y de mecanismo: el mismo contrato sirve para
// automatización de navegador (esta fase), y para una API real o un flujo
// de PDF+OCR si algún día existen, sin que el resto del sistema cambie.
// -----------------------------------------------------------------------------

export interface ScreeningApplicantInput {
  fullName: string;
  dateOfBirth: string; // ISO date (YYYY-MM-DD)
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
  readonly name: 'screening_mock' | 'screening_playwright';
  /** Envía la solicitud. Un mecanismo de navegador casi siempre devuelve 'pending'. */
  runCheck(kind: ScreeningCheckKind, input: ScreeningApplicantInput): Promise<ScreeningRunResult>;
  /** Revisa si un envío 'pending' ya tiene resultado. */
  pollResult(kind: ScreeningCheckKind, providerRef: string): Promise<ScreeningRunResult>;
}
