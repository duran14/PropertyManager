import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const apiSrc = join(process.cwd(), 'src');

const sensitiveFiles = [
  'services/bills.service.ts',
  'services/reconciliation.service.ts',
  'routes/bills.ts',
  'routes/reconciliation.ts',
];

describe('tenant context enforcement', () => {
  it('wraps sensitive accounting data access with the RLS tenant context helper', () => {
    for (const file of sensitiveFiles) {
      const source = readFileSync(join(apiSrc, file), 'utf8');

      expect(source, file).toContain('withTenant');
      expect(source, file).toContain('../config/tenant-context.js');
    }
  });

  it('does not bypass tenant context with direct sensitive Prisma model access', () => {
    const directSensitiveAccess =
      /\bprisma\.(bill|approvalRequest|transaction|reconciliationBatch|discrepancy|auditEntry)\b/;

    for (const file of sensitiveFiles) {
      const source = readFileSync(join(apiSrc, file), 'utf8');

      expect(source, file).not.toMatch(directSensitiveAccess);
    }
  });
});
