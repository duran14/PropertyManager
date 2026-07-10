import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '@property-manager/config';
import { describe, expect, it } from 'vitest';

const apiSrc = join(process.cwd(), 'src');

describe('Telegram shared bot routing', () => {
  it('routes the shared Telegram bot through explicit tenant configuration', () => {
    const pollerSource = readFileSync(join(apiSrc, 'jobs/telegram-poller.ts'), 'utf8');
    const envSource = readFileSync(
      new URL('../../../../packages/config/src/env.ts', import.meta.url),
      'utf8',
    );

    expect(envSource).toContain('TELEGRAM_DEFAULT_TENANT_ID');
    expect(pollerSource).toContain('TELEGRAM_DEFAULT_TENANT_ID');
    expect(pollerSource).not.toContain("'tenant_demo_pm'");
    expect(pollerSource).not.toContain('"tenant_demo_pm"');
  });

  it('uses the demo tenant when the shared Telegram tenant setting is blank', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://pm_dev:pm_dev_password@localhost:5433/property_manager?schema=public',
      REDIS_URL: 'redis://localhost:6380',
      API_URL: 'http://localhost:4000',
      WEB_URL: 'http://localhost:5173',
      JWT_ACCESS_SECRET: 'change-me-access-secret',
      JWT_REFRESH_SECRET: 'change-me-refresh-secret',
      INTEGRATION_ENCRYPTION_KEY: 'change-me-32-byte-encryption-key',
      TELEGRAM_DEFAULT_TENANT_ID: '',
    });

    expect(env.TELEGRAM_DEFAULT_TENANT_ID).toBe('tenant_demo_pm');
  });
});
