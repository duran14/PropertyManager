/** Tipos compartidos frontend — espejo de los de backend (zod-validated). */

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'property_manager' | 'bookkeeper' | 'broker';
  tenantId: string;
  tenantName: string;
}

export interface LoginResponse {
  accessToken: string;
  user: AuthUser;
}

export type BillStatus =
  | 'pending_ocr'
  | 'pending_review'
  | 'approved'
  | 'synced_to_qbo'
  | 'rejected';

export interface Bill {
  id: string;
  vendorName: string;
  billDate: string;
  totalCents: number;
  currency: string;
  category: string;
  ocrConfidence: number | null;
  qboBillId: string | null;
  qboSyncedAt: string | null;
  status: BillStatus;
  approvalRequest?: {
    id: string;
    status: string;
    confidenceScore: number;
    confidenceReasons: string[];
  } | null;
  createdAt: string;
}

export interface Discrepancy {
  id: string;
  kind: 'missing_in_qbo' | 'missing_in_buildium' | 'missing_in_bank' | 'amount_mismatch';
  entryReference: string;
  entryAmountCents: number;
  relatedReferences: string[];
  resolved: boolean;
  createdAt: string;
  reconciliationBatch?: { runDate: string };
}

export interface ReconciliationBatch {
  id: string;
  runDate: string;
  qboBalanceCents: number;
  bankBalanceCents: number;
  buildiumBalanceCents: number;
  balanced: boolean;
}

export type LeadSource = 'unit_url' | 'whatsapp' | 'sms' | 'telegram' | 'web' | 'email' | 'showmojo' | 'manual';

export type LeadStatus = 'new_' | 'contacted' | 'tour_scheduled' | 'qualified' | 'converted' | 'lost';

export interface Lead {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  source: LeadSource;
  status: LeadStatus;
  preferredChannel: string | null;
  createdAt: string;
  unit?: { name: string; property: { name: string } } | null;
  latestActivity?: {
    label: string;
    detail: string;
    createdAt: string;
  } | null;
  prospectProfile?: {
    budget?: string;
    moveInDate?: string;
    preferredArea?: string;
    occupants?: string;
    pets?: string;
    lastChannel?: string;
    conversationState?: string;
  };
}

export interface LeadDetail extends Lead {
  unit?: { name: string; property: { name: string; address: string; city: string } } | null;
  conversations: Array<{
    id: string;
    channel: string;
    state: string;
    updatedAt: string;
    slots: Array<{ key: string; value: string }>;
    messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
  }>;
  showings: Array<{
    id: string;
    scheduledAt: string;
    durationMinutes: number;
    status: string;
    unit: { name: string; property: { name: string; address: string; city: string } } | null;
  }>;
  conversationEvents: Array<{
    id: string;
    type: string;
    label: string;
    detail: string;
    tone: string;
    createdAt: string;
    actorUser?: { firstName: string; lastName: string } | null;
  }>;
  notes: Array<{
    id: string;
    detail: string;
    payload?: Record<string, unknown>;
    createdAt: string;
    actorUser?: { firstName: string; lastName: string } | null;
  }>;
}

export interface TenantOnboardingProfile {
  id: string;
  logoUrl: string | null;
  services: string[];
  values: string[];
  pricingNotes: string | null;
  showingPreferences: string | null;
  petPolicy: string | null;
  handoffName: string | null;
  handoffEmail: string | null;
  handoffPhone: string | null;
  aiTone: string | null;
  aiInstructions: string | null;
}

export interface PropertyUnit {
  id: string;
  propertyId: string;
  name: string;
  rentCents: number;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFeet: number | null;
  availableFrom: string | null;
  amenities: string[];
  petPolicy: string | null;
  parking: string | null;
  utilities: string | null;
  slug: string;
  isActive: boolean;
}

export interface PropertyRecord {
  id: string;
  name: string;
  address: string;
  city: string;
  province: string;
  postalCode: string | null;
  units: PropertyUnit[];
}

export interface Lease {
  id: string;
  startDate: string;
  endDate: string | null;
  rentCents: number;
  depositCents: number | null;
  status: 'draft' | 'active' | 'ended' | 'terminated';
  rtaDraftDocRef: string | null;
  signedDocRef: string | null;
  unit?: { name: string; property: { name: string; city: string } } | null;
  tenantRecord?: { firstName: string; lastName: string; email: string | null } | null;
}

export interface RtaDraft {
  leaseId: string;
  draftDocRef: string;
  content: string;
  fields: {
    landlordName: string;
    tenantName: string;
    propertyAddress: string;
    unitName: string;
    startDate: string;
    endDate: string | null;
    rentCents: number;
    depositCents: number;
    tenancyType: string;
  };
  disclaimer: string;
}

export interface SentinelStatus {
  queues: {
    reconciliation: Record<string, number>;
    bankNotification: Record<string, number>;
  };
  recentActions: Array<{
    action: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }>;
}

export interface AuditEntry {
  id: string;
  actorId: string;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string;
  occurredAt: string;
  previousHash: string;
  hash: string;
}

export interface ChainVerification {
  firstBrokenIndex: number | null;
  totalEntries: number;
  intact: boolean;
}
