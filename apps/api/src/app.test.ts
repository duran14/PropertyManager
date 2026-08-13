/**
 * Fix de seguridad (Task 3 de Fase 2.2, hallazgo de review): un body JSON
 * malformado hace que express.json() (body-parser) lance ANTES de que
 * cualquier route handler corra. El manejador de errores genérico de este
 * archivo hacía `res.json({ error: err.message })` fuera de producción, y
 * err.message de un fallo de JSON.parse puede embeber un fragmento crudo
 * del body — para POST /integrations, eso puede ser la contraseña en claro
 * que el usuario acaba de escribir. Este test reproduce el caso end-to-end
 * contra la app real (sin supertest en este repo: se levanta con
 * server.listen(0) y se pega con fetch, igual que se hizo para verificar
 * el fix manualmente).
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('app-level error handling', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('no se pudo levantar el servidor de prueba');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('un JSON malformado en POST /integrations nunca hace echo del fragmento crudo del body (fuga de password)', async () => {
    const marker = 'SuperSecretMarker123';
    // String sin cerrar justo donde iría el valor del password — dispara
    // entity.parse.failed en body-parser antes de que la ruta lo vea.
    const malformedBody = `{"provider":"frontlobby_portal","username":"a","password":"${marker}`;

    const res = await fetch(`${baseUrl}/integrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: malformedBody,
    });
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(text).not.toContain(marker);
  });
});
