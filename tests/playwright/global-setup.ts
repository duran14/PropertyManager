import { execSync } from 'node:child_process';

export default async function globalSetup() {
  execSync('pnpm db:seed', { shell: true, stdio: 'inherit' });
}
