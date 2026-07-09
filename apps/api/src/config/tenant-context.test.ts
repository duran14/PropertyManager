import { describe, expect, it } from 'vitest';
import { withTenant } from './tenant-context.js';

describe('withTenant', () => {
  it('sets app.tenant_id locally before running tenant-scoped work', async () => {
    const calls: unknown[] = [];
    const tx = {
      $executeRaw: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(1);
      },
    };
    const prisma = {
      $transaction: async (fn: (client: typeof tx) => Promise<string>) => fn(tx),
    };

    const result = await withTenant(prisma as never, 'tenant_demo', async (client) => {
      expect(client).toBe(tx);
      return 'done';
    });

    expect(result).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      ['SELECT set_config(\'app.tenant_id\', ', ', true)'],
      'tenant_demo',
    ]);
  });
});
