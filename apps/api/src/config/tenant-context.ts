import type { Prisma, PrismaClient } from '@prisma/client';

type TenantTransactionClient = Prisma.TransactionClient;

type TransactionCapableClient = Pick<PrismaClient, '$transaction'>;

/**
 * Ejecuta trabajo de BD con el tenant configurado en la transaccion actual.
 *
 * Las policies RLS leen `app.tenant_id`; usar `set_config(..., true)` evita que
 * el valor sobreviva fuera de esta transaccion o se filtre a otra request.
 */
export async function withTenant<T>(
  client: TransactionCapableClient,
  tenantId: string,
  work: (tx: TenantTransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return work(tx);
  });
}
