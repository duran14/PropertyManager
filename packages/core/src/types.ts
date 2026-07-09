/**
 * Tipos primitivos y enums compartidos por todo el dominio.
 * Sin dependencias externas: este paquete es lógica pura.
 */

/** Identificadores en formato string (CUID/UUID generados por la BD). */
export type Id = string;

/** Marca de tiempo ISO-8601 (UTC). */
export type IsoDate = string;

/** Provincia canadiense (BC primero; Quebec excluido del producto). */
export const CANADIAN_PROVINCES = [
  'AB',
  'BC',
  'MB',
  'NB',
  'NL',
  'NS',
  'NT',
  'NU',
  'ON',
  'PE',
  'SK',
  'YT',
] as const;
export type CanadianProvince = (typeof CANADIAN_PROVINCES)[number];

/**
 * Roles de usuario dentro de un tenant (RBAC).
 * El MVP se lanza en BC; los permisos reflejan RESA-BC (Real Estate Services Act).
 */
export const USER_ROLES = [
  'property_manager', // Admin del tenant: propiedades, contratos, integraciones.
  'bookkeeper', // Contabilidad: conciliación, aprobaciones HITL, discrepancias.
  'broker', // Managing Broker: supervisión legal, firma de contratos RTA.
] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Usuarios externos al tenant (no son staff de la PM company).
 * Tienen acceso restringido: portals de autoservicio.
 */
export const EXTERNAL_USER_TYPES = ['tenant', 'owner'] as const;
export type ExternalUserType = (typeof EXTERNAL_USER_TYPES)[number];

/** Divisa. El MVP opera en CAD (dólar canadiense). */
export type Currency = 'CAD' | 'USD';

/** Representación segura de dinero como enteros (centavos) para evitar errores de float. */
export interface Money {
  /** Monto en centavos (ej: $1,234.56 → 123456). Siempre entero. */
  amount: number;
  currency: Currency;
}

/**
 * Fuentes de una transacción.
 * Indica de qué sistema provino originalmente el movimiento.
 */
export const TRANSACTION_SOURCES = [
  'buildium', // Sincronizado desde Buildium.
  'qbo', // Sincronizado desde QuickBooks Online.
  'bank', // Aviso bancario / e-Transfer leído.
  'manual', // Cargado a mano por un usuario.
] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

/**
 * Tipos de movimiento contable.
 * CRÍTICO para la reconciliación Trust ↔ Operating.
 */
export const TRANSACTION_TYPES = [
  'rent_payment', // Pago de renta de inquilino.
  'owner_contribution', // Aporte del propietario.
  'owner_distribution', // Distribución al propietario.
  'vendor_bill', // Factura de proveedor (mantenimiento, reparaciones, etc.).
  'vendor_payment', // Pago a proveedor.
  'trust_deposit', // Depósito a la cuenta Trust (depósito de seguridad).
  'trust_refund', // Devolución de depósito de seguridad.
  'internal_transfer', // Transferencia entre Trust y Operating.
  'fee', // Comisión de la PM company.
  'other',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * Resultado de un intento de matching automático entre movimientos.
 * Determina si el sistema puede actuar solo o requiere revisión humana (HITL).
 */
export const CONFIDENCE_DECISIONS = ['auto_approve', 'review', 'reject'] as const;
export type ConfidenceDecision = (typeof CONFIDENCE_DECISIONS)[number];

/** Cuentas contables estándar para clasificar facturas (Chart of Accounts simplificado). */
export const ACCOUNT_CATEGORIES = [
  'repairs', // Reparaciones
  'maintenance', // Mantenimiento general
  'utilities', // Servicios públicos (hydro, gas, water)
  'property_tax', // Impuestos municipales
  'insurance', // Seguros
  'management_fee', // Honorarios de administración
  'advertising', // Publicidad / marketing
  'supplies', // Insumos
  'contract_services', // Servicios contratados (jardinería, limpieza)
  'legal_professional', // Honorarios legales / profesionales
  'other',
] as const;
export type AccountCategory = (typeof ACCOUNT_CATEGORIES)[number];
