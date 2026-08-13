/**
 * Sin infraestructura de supertest en este repo, las rutas se verifican por
 * grep del código fuente (mismo patrón que
 * ../config/tenant-enforcement.test.ts): confirma que POST / exige el rol
 * property_manager en la cadena de middleware, y que la ruta nunca toca la
 * contraseña en claro — la password nunca sale de saveIntegrationCredentials
 * hacia una respuesta HTTP.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const routeSource = readFileSync(join(process.cwd(), 'src', 'routes', 'integrations.ts'), 'utf8');

describe('integrationsRouter', () => {
  it('POST / exige requireAuth y requireRole(property_manager) en la cadena de middleware', () => {
    const postLine = routeSource
      .split('\n')
      .find((line) => line.includes("integrationsRouter.post('/'"));
    expect(postLine, 'no se encontró la definición de POST /').toBeDefined();
    expect(postLine).toContain('requireAuth');
    expect(postLine).toContain("requireRole('property_manager')");
  });

  it('GET / exige requireAuth en la cadena de middleware', () => {
    const getLine = routeSource
      .split('\n')
      .find((line) => line.includes("integrationsRouter.get('/'"));
    expect(getLine, 'no se encontró la definición de GET /').toBeDefined();
    expect(getLine).toContain('requireAuth');
  });

  it('nunca importa getIntegrationCredentials — ningún endpoint HTTP puede devolver la contraseña', () => {
    expect(routeSource).not.toContain('getIntegrationCredentials');
  });

  it('no logea ni serializa el password del body en ninguna respuesta', () => {
    expect(routeSource).not.toMatch(/res\.(json|send)\([^)]*password/i);
    expect(routeSource).not.toMatch(/console\.(log|error|warn)/);
  });
});
