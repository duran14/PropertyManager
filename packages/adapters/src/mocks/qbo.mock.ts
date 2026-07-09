/**
 * Mock de QuickBooks Online.
 *
 * Mantiene Bills y Journal Entries en memoria y un set de saldos fijos.
 * El balance de las cuentas Trust y Operating es lo que la reconciliación
 * debe cuadrar contra Buildium y el banco.
 */
import type {
  QboAdapter,
  QboBill,
  QboJournalEntry,
  QboWebhookEvent,
} from '../contracts.js';
import type { Money } from '@property-manager/core';

interface AccountState {
  name: string;
  balanceCents: number;
  currency: 'CAD' | 'USD';
}

export class QboMockAdapter implements QboAdapter {
  readonly name = 'qbo' as const;

  private bills: QboBill[] = [];
  private journalEntries: QboJournalEntry[] = [];

  private accounts: AccountState[] = [
    { name: 'Trust Account', balanceCents: 48_250_00, currency: 'CAD' },
    { name: 'Operating Account', balanceCents: 12_780_50, currency: 'CAD' },
  ];

  async createBill(bill: QboBill): Promise<{ id: string }> {
    const id = `bill_${this.bills.length + 1}`.padStart(8, '0');
    this.bills.push({ ...bill, id });
    return { id };
  }

  async createJournalEntry(entry: QboJournalEntry): Promise<{ id: string }> {
    const id = `je_${this.journalEntries.length + 1}`.padStart(8, '0');
    this.journalEntries.push({ ...entry, id });

    // Aplica el efecto contable sobre los saldos en memoria.
    for (const line of entry.lines) {
      const account = this.accounts.find((a) => a.name === line.accountName);
      if (account) {
        account.balanceCents += line.amountCents;
      }
    }
    return { id };
  }

  async getAccountBalance(accountName: string, _asOf: string): Promise<Money> {
    const account = this.accounts.find((a) => a.name === accountName);
    if (!account) {
      throw new Error(`Cuenta no encontrada en QBO: ${accountName}`);
    }
    return { amount: account.balanceCents, currency: account.currency };
  }

  async parseWebhook(
    _headers: Record<string, string>,
    body: unknown,
  ): Promise<QboWebhookEvent> {
    const payload = body as { type?: string };
    if (payload.type === 'bill.created') {
      return {
        type: 'bill.created',
        bill: this.bills[0] ?? {
          vendorName: 'Acme Plumbing',
          billDate: '2026-07-01',
          currency: 'CAD',
          lines: [{ accountCategory: 'repairs', description: 'Faucet repair', amountCents: 185_00 }],
        },
      };
    }
    throw new Error(`Webhook de QBO no reconocido: ${payload.type}`);
  }

  // Helper de test: inyectar saldo inicial.
  setAccountBalance(name: string, balanceCents: number): void {
    const account = this.accounts.find((a) => a.name === name);
    if (account) account.balanceCents = balanceCents;
  }
}
