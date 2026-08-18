import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAnnualIncome } from './leads.js';

/**
 * Fix 3 (final review): `annualIncome` es `Int` en Prisma, pero la ruta
 * aceptaba cualquier `number` de JS. Un decimal, un valor > 2^31, o
 * `Infinity` (que `JSON.parse` produce de `1e999`, y para el que
 * `typeof Infinity === 'number'` sigue siendo cierto) hacían que Prisma
 * lanzara al escribir → 500 genérico, y para entonces el documento de
 * identificación ya se había escrito a disco. `parseAnnualIncome` corre en
 * la ruta antes de llamar al servicio, así que un valor inválido nunca
 * llega a `submitRentalApplication` ni a `storage.putObject`.
 */
describe('parseAnnualIncome', () => {
  it('accepts a valid whole number', () => {
    expect(parseAnnualIncome(82000)).toEqual({ ok: true, value: 82000 });
  });

  it('accepts zero', () => {
    expect(parseAnnualIncome(0)).toEqual({ ok: true, value: 0 });
  });

  it('treats an absent value as valid and optional', () => {
    expect(parseAnnualIncome(undefined)).toEqual({ ok: true, value: null });
  });

  it('treats an explicit null as valid and optional', () => {
    expect(parseAnnualIncome(null)).toEqual({ ok: true, value: null });
  });

  it('rejects a decimal value', () => {
    const result = parseAnnualIncome(82000.5);
    expect(result.ok).toBe(false);
  });

  it('rejects a value above the range cap', () => {
    const result = parseAnnualIncome(2_000_000_001);
    expect(result.ok).toBe(false);
  });

  it('rejects a negative value', () => {
    const result = parseAnnualIncome(-1);
    expect(result.ok).toBe(false);
  });

  it('rejects Infinity (what JSON.parse produces from 1e999, still typeof "number")', () => {
    const result = parseAnnualIncome(Infinity);
    expect(result.ok).toBe(false);
  });

  it('rejects a value greater than 2^31', () => {
    const result = parseAnnualIncome(2 ** 31 + 1000);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-number value', () => {
    const result = parseAnnualIncome('82000');
    expect(result.ok).toBe(false);
  });

  it('accepts the upper bound of the range', () => {
    expect(parseAnnualIncome(2_000_000_000)).toEqual({ ok: true, value: 2_000_000_000 });
  });
});

/**
 * Task 5: ruta de aprobación manual del checkeo real de screening. Sin
 * infraestructura de supertest en este repo (ver integrations.test.ts), la
 * cadena de middleware se verifica por grep del código fuente — mismo
 * patrón que integrations.test.ts y tenant-enforcement.test.ts. La
 * transición de estado en sí (awaiting_approval -> requested, y el 409
 * cuando no lo está) ya la cubre screening.service.test.ts sobre
 * `approveScreening`, que es exactamente lo que esta ruta llama.
 */
describe('POST /applications/:applicationId/screening/:kind/approve', () => {
  const routeSource = readFileSync(join(process.cwd(), 'src', 'routes', 'leads.ts'), 'utf8');

  it('exige requireAuth y requireRole(property_manager, broker) en la cadena de middleware', () => {
    const postLine = routeSource
      .split('\n')
      .find((line) => line.includes("'/applications/:applicationId/screening/:kind/approve'"));
    expect(postLine, 'no se encontró la definición de la ruta').toBeDefined();

    const routeIndex = routeSource.indexOf("'/applications/:applicationId/screening/:kind/approve'");
    const chain = routeSource.slice(routeIndex, routeIndex + 200);
    expect(chain).toContain('requireAuth');
    expect(chain).toContain("requireRole('property_manager', 'broker')");
  });

  it('rechaza un kind inválido con 400 antes de llamar a approveScreening', () => {
    expect(routeSource).toContain("kind !== 'credit' && kind !== 'criminal'");
  });

  it('devuelve 409 cuando approveScreening responde ok:false', () => {
    const handlerIndex = routeSource.indexOf("'/applications/:applicationId/screening/:kind/approve'");
    const handler = routeSource.slice(handlerIndex, handlerIndex + 900);
    expect(handler).toContain('result.ok');
    expect(handler).toContain('res.status(409)');
  });
});

/**
 * Task 2 (Fase 2.2): ruta de carga manual de un reporte de screening
 * (PDF/OCR), cualquier proveedor. Mismo patrón de verificación por grep que
 * la suite de arriba — sin supertest en este repo. La lógica de
 * `recordManualScreeningReport` (400 sin veredicto confiable, override sin
 * guard de estado, aislamiento de tenant) ya está cubierta en
 * screening.service.test.ts.
 */
describe('POST /applications/:applicationId/screening/:kind/upload-report', () => {
  const routeSource = readFileSync(join(process.cwd(), 'src', 'routes', 'leads.ts'), 'utf8');

  it('existe con requireAuth y requireRole(property_manager, broker)', () => {
    expect(routeSource).toMatch(/leadsRouter\.post\(\s*'\/applications\/:applicationId\/screening\/:kind\/upload-report'/);
    const routeBlock = routeSource.slice(routeSource.indexOf("'/applications/:applicationId/screening/:kind/upload-report'"));
    expect(routeBlock.slice(0, 200)).toMatch(/requireAuth/);
    expect(routeBlock.slice(0, 200)).toMatch(/requireRole\('property_manager', 'broker'\)/);
  });

  it('rechaza un kind inválido con 400 antes de llamar a recordManualScreeningReport', () => {
    const handlerIndex = routeSource.indexOf("'/applications/:applicationId/screening/:kind/upload-report'");
    const handler = routeSource.slice(handlerIndex, handlerIndex + 1500);
    expect(handler).toContain("kind !== 'credit' && kind !== 'criminal'");
  });

  it('valida el body con uploadReportSchema y responde 400 según el status de recordManualScreeningReport', () => {
    const handlerIndex = routeSource.indexOf("'/applications/:applicationId/screening/:kind/upload-report'");
    const handler = routeSource.slice(handlerIndex, handlerIndex + 1500);
    expect(handler).toContain('uploadReportSchema.safeParse');
    expect(handler).toContain('recordManualScreeningReport');
    expect(handler).toContain('res.status(result.status)');
  });
});

/**
 * Task 2 (id-document-download): ruta de descarga del documento de
 * identificación. Mismo patrón de verificación por grep que las suites de
 * arriba — sin supertest en este repo. La lógica de negocio (aislamiento de
 * tenant, 404 sin documento, fallback de Content-Type para filas legacy) vive
 * en `getIdDocumentForDownload` y ya está cubierta con tests reales de
 * DB/disco en rental-application.service.test.ts.
 */
describe('GET /applications/:applicationId/id-document', () => {
  const routeSource = readFileSync(join(process.cwd(), 'src', 'routes', 'leads.ts'), 'utf8');

  it('existe con requireAuth y sin restricción de rol adicional, igual que la ruta de reportes de screening', () => {
    expect(routeSource).toMatch(/leadsRouter\.get\(\s*'\/applications\/:applicationId\/id-document',\s*requireAuth/);
  });

  it('delega en getIdDocumentForDownload y traduce { ok: false } al status devuelto', () => {
    const routeIndex = routeSource.indexOf("'/applications/:applicationId/id-document'");
    const handler = routeSource.slice(routeIndex, routeIndex + 700);
    expect(handler).toContain('getIdDocumentForDownload(applicationId, user.tenantId)');
    expect(handler).toContain('result.ok');
    expect(handler).toContain('res.status(result.status)');
  });

  it('sirve el archivo con el Content-Type devuelto por el servicio', () => {
    const routeIndex = routeSource.indexOf("'/applications/:applicationId/id-document'");
    // Ventana ampliada de 1000 a 1400 (Task 2, audit trail): el bloque de
    // writeAudit insertado antes de los setHeader corre el offset.
    const handler = routeSource.slice(routeIndex, routeIndex + 1400);
    expect(handler).toContain("res.setHeader('Content-Type', result.contentType)");
    expect(handler).toContain('res.send(result.file)');
  });

  // Critical 1 (revisión final): header de defensa en profundidad — aunque
  // getIdDocumentForDownload ya filtra el Content-Type contra una allowlist,
  // nosniff evita que el navegador reinterprete el body por su cuenta.
  it('agrega X-Content-Type-Options: nosniff antes de escribir el Content-Type', () => {
    const routeIndex = routeSource.indexOf("'/applications/:applicationId/id-document'");
    const handler = routeSource.slice(routeIndex, routeIndex + 1400);
    const nosniffIndex = handler.indexOf("res.setHeader('X-Content-Type-Options', 'nosniff')");
    const contentTypeIndex = handler.indexOf("res.setHeader('Content-Type', result.contentType)");
    expect(nosniffIndex).toBeGreaterThan(-1);
    expect(contentTypeIndex).toBeGreaterThan(-1);
    expect(nosniffIndex).toBeLessThan(contentTypeIndex);
  });
});

describe('audit trail en descargas de PII', () => {
  const routeSource = readFileSync(join(process.cwd(), 'src', 'routes', 'leads.ts'), 'utf8');

  // Minor 5 (revisión final): las ventanas de offset fijo (`slice(idx, idx +
  // N)`) fallaban ABIERTO — si el handler crecía más allá del offset, el
  // assert `not.toContain` de PII de más abajo dejaba de mirar la parte
  // nueva del handler y pasaba en verde sin haber revisado nada. Cortar
  // desde el índice de la ruta hasta el `});` que cierra el handler completo
  // (balance de paréntesis/llaves) elimina esa fragilidad: no hay número
  // mágico que se pueda quedar corto.
  function sliceRouteHandler(routePathLiteral: string): string {
    const routeIndex = routeSource.indexOf(routePathLiteral);
    if (routeIndex === -1) throw new Error(`no se encontró la ruta: ${routePathLiteral}`);
    let depth = 1; // ya estamos dentro del paréntesis de apertura de leadsRouter.get(/.post(
    for (let i = routeIndex; i < routeSource.length; i++) {
      const ch = routeSource[i];
      if (ch === '(' || ch === '{') depth++;
      else if (ch === ')' || ch === '}') {
        depth--;
        if (depth === 0) return routeSource.slice(routeIndex, i + 1);
      }
    }
    throw new Error(`no se encontró el cierre del handler: ${routePathLiteral}`);
  }

  it('la ruta de documento de identificación escribe una entrada de auditoría', () => {
    const handler = sliceRouteHandler("'/applications/:applicationId/id-document'");
    expect(handler).toContain('writeAudit');
    expect(handler).toContain("action: 'rental_application.id_document.downloaded'");
    expect(handler).toContain("entityType: 'rental_application'");
    expect(handler).toContain('actorFromUser(user.userId, user.role)');
  });

  it('la ruta de reporte de screening escribe una entrada de auditoría con el kind', () => {
    const handler = sliceRouteHandler("'/applications/:applicationId/report/:kind'");
    expect(handler).toContain('writeAudit');
    expect(handler).toContain("action: 'rental_application.screening_report.downloaded'");
    expect(handler).toContain('payload: { kind }');
  });

  it('ninguna de las dos rutas mete el archivo ni la storage key en el payload de auditoría', () => {
    // El payload de auditoría es consultable y persistente: meterle PII lo
    // convierte en una segunda copia de lo que se pretendía proteger. Se
    // acota a los handlers de descarga (y no a todo el archivo) porque
    // `idDocumentBase64` también aparece legítimamente en la ruta de
    // envío del formulario (línea ~249), que no forma parte de este cambio.
    const idDocumentHandler = sliceRouteHandler("'/applications/:applicationId/id-document'");
    const reportHandler = sliceRouteHandler("'/applications/:applicationId/report/:kind'");
    for (const handler of [idDocumentHandler, reportHandler]) {
      expect(handler).not.toContain('payload: { file');
      expect(handler).not.toContain('storageKey: key');
      expect(handler).not.toContain('idDocumentBase64');
    }
  });
});

describe('feed de sindicación', () => {
  const routeSource = readFileSync(join(process.cwd(), 'src', 'routes', 'leads.ts'), 'utf8');

  it('la ruta lee el tenant de la query, no del header', () => {
    const idx = routeSource.indexOf("'/listing-feed'");
    expect(idx).toBeGreaterThan(-1);
    const handler = routeSource.slice(idx, idx + 1200);
    expect(handler).toContain('req.query.tenant');
    expect(handler).not.toContain("x-tenant-id");
  });

  it('la ruta responde text/csv y delega en getListingFeed', () => {
    const idx = routeSource.indexOf("'/listing-feed'");
    const handler = routeSource.slice(idx, idx + 1200);
    expect(handler).toContain('getListingFeed(tenantId, new Date())');
    expect(handler).toContain("'text/csv; charset=utf-8'");
  });

  // Es una ruta pública a propósito, pero no debe colgarse del router
  // autenticado por accidente.
  it('la ruta vive en publicRouter, no en leadsRouter', () => {
    expect(routeSource).toContain("publicRouter.get('/listing-feed'");
  });

  // Minor 7 (ronda de corrección final): sin token, `findMany` sin `take`, y
  // el consumidor previsto es un poller en ciclo — sin Cache-Control un
  // crawler agresivo golpea la base en cada request.
  it('la ruta fija Cache-Control para el poller del portal', () => {
    const idx = routeSource.indexOf("'/listing-feed'");
    const handler = routeSource.slice(idx, idx + 1200);
    expect(handler).toContain("'Cache-Control'");
    expect(handler).toContain('max-age=300');
  });
});
