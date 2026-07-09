/**
 * Mock de Buildium con datos realistas de British Columbia.
 *
 * Devuelve siempre los mismos datos (determinista) para que los tests y la UI
 * sean estables. Cuando se enchufe el adapter real, la lógica de negocio no
 * nota la diferencia.
 */
import type {
  BuildiumAdapter,
  BuildiumLease,
  BuildiumPayment,
  BuildiumProperty,
  BuildiumUnit,
  BuildiumWebhookEvent,
} from '../contracts.js';

const PROPERTIES: BuildiumProperty[] = [
  {
    id: 'prop_001',
    name: 'Cedar Court Apartments',
    address: '1200 Granville St',
    city: 'Vancouver',
    province: 'BC',
  },
  {
    id: 'prop_002',
    name: 'Harbour View Suites',
    address: '789 Wharf St',
    city: 'Victoria',
    province: 'BC',
  },
];

const UNITS: BuildiumUnit[] = [
  { id: 'unit_101', propertyId: 'prop_001', name: 'Apt 101', rentCents: 2_400_00 },
  { id: 'unit_102', propertyId: 'prop_001', name: 'Apt 102', rentCents: 2_650_00 },
  { id: 'unit_201', propertyId: 'prop_002', name: 'Suite 201', rentCents: 1_950_00 },
];

const LEASES: BuildiumLease[] = [
  {
    id: 'lease_001',
    unitId: 'unit_101',
    tenantName: 'Sarah Chen',
    tenantEmail: 'sarah.chen@example.ca',
    rentCents: 2_400_00,
    startDate: '2026-03-01',
    endDate: '2027-02-28',
  },
  {
    id: 'lease_002',
    unitId: 'unit_102',
    tenantName: 'Michael Wright',
    tenantEmail: 'm.wright@example.ca',
    rentCents: 2_650_00,
    startDate: '2026-01-15',
    endDate: '2027-01-14',
  },
];

const PAYMENTS: BuildiumPayment[] = [
  {
    id: 'pay_001',
    leaseId: 'lease_001',
    amountCents: 2_400_00,
    receivedAt: '2026-07-01T09:14:00Z',
    method: 'etransfer',
    reference: 'ETR-2026-0701-88213',
  },
];

export class BuildiumMockAdapter implements BuildiumAdapter {
  readonly name = 'buildium' as const;

  private properties = [...PROPERTIES];
  private units = [...UNITS];
  private leases = [...LEASES];
  private payments = [...PAYMENTS];

  async listProperties(): Promise<BuildiumProperty[]> {
    return structuredClone(this.properties);
  }

  async listUnits(propertyId: string): Promise<BuildiumUnit[]> {
    return structuredClone(this.units.filter((u) => u.propertyId === propertyId));
  }

  async listLeases(unitId: string): Promise<BuildiumLease[]> {
    return structuredClone(this.leases.filter((l) => l.unitId === unitId));
  }

  async markLeasePaid(
    leaseId: string,
    payment: { amountCents: number; receivedAt: string; reference: string },
  ): Promise<void> {
    const lease = this.leases.find((l) => l.id === leaseId);
    if (!lease) {
      throw new Error(`Lease no encontrado: ${leaseId}`);
    }
    const newPayment: BuildiumPayment = {
      id: `pay_${this.payments.length + 1}`.padStart(7, '0'),
      leaseId,
      amountCents: payment.amountCents,
      receivedAt: payment.receivedAt,
      method: 'etransfer',
      reference: payment.reference,
    };
    this.payments.push(newPayment);
  }

  async parseWebhook(
    _headers: Record<string, string>,
    body: unknown,
  ): Promise<BuildiumWebhookEvent> {
    const payload = body as { type?: string };
    if (payload.type === 'payment.received') {
      return { type: 'payment.received', payment: PAYMENTS[0]! };
    }
    if (payload.type === 'lease.created') {
      return { type: 'lease.created', lease: LEASES[0]! };
    }
    throw new Error(`Webhook de Buildium no reconocido: ${payload.type}`);
  }
}
