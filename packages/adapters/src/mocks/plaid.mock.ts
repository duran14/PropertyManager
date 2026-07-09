import type { PlaidAdapter, PlaidAccount, PlaidTransaction } from '../contracts.js';

/**
 * Mock de Plaid (solo lectura). Devuelve cuentas y transacciones simuladas
 * que representan los saldos reales del banco.
 */
export class PlaidMockAdapter implements PlaidAdapter {
  readonly name = 'plaid' as const;

  private accounts: Record<string, PlaidAccount[]> = {
    item_demo: [
      {
        accountId: 'acc_trust',
        name: 'Trust Account — RBC',
        mask: '4471',
        type: 'depository',
        currentBalanceCents: 48_250_00,
        availableBalanceCents: 48_200_00,
        currency: 'CAD',
      },
      {
        accountId: 'acc_operating',
        name: 'Operating Account — RBC',
        mask: '4472',
        type: 'depository',
        currentBalanceCents: 12_780_50,
        availableBalanceCents: 12_730_50,
        currency: 'CAD',
      },
    ],
  };

  async getAccounts(itemId: string): Promise<PlaidAccount[]> {
    return structuredClone(this.accounts[itemId] ?? []);
  }

  async getTransactions(
    itemId: string,
    _startDate: string,
    _endDate: string,
  ): Promise<PlaidTransaction[]> {
    if (!this.accounts[itemId]) return [];
    return [
      {
        id: 'plaid_tx_001',
        accountId: 'acc_operating',
        amountCents: -2_400_00, // e-Transfer entrante (pago de renta)
        date: '2026-07-01',
        name: 'Interac e-Transfer from Sarah Chen',
        pending: false,
      },
      {
        id: 'plaid_tx_002',
        accountId: 'acc_operating',
        amountCents: 185_00, // pago a proveedor (salida)
        date: '2026-07-02',
        name: 'Acme Plumbing Ltd.',
        pending: false,
      },
    ];
  }
}
