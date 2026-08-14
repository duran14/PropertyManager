# Fase 2.2 nivel 3 — Reporte manual por PDF/OCR — Diseño

## 1. El gap

`docs/PRODUCT_ROADMAP.md`, sección 2.2: *"Nivel 3 — PDF parser / OCR:
extracción de datos clave mediante visión/OCR si el manager sube el
reporte manualmente en PDF. No implementado."*

Esto es independiente de qué proveedor de antecedentes penales se elija
(Sterling u otro) — el staff puede haber obtenido el reporte de CUALQUIER
fuente (por fuera de esta app) y solo necesita registrarlo. No requiere
ninguna decisión de proveedor pendiente.

## 2. Diseño

### 2.1 `GlmAdapter` gana un método genérico (NO reutiliza `extractCreditReport`)

`extractCreditReport` (ya existente, del branch de FrontLobby) tiene un
prompt atado semánticamente al layout de FrontLobby — espera un "score
gauge" y una sección literalmente llamada *"AI Summary"*. Un reporte de
Sterling, TransUnion, Certn, o un reporte de antecedentes penales (que no
tiene un score numérico comparable) no calza ahí. Se agrega un método
nuevo, deliberadamente agnóstico de proveedor y de tipo de checkeo:

```ts
export interface ScreeningReportExtraction {
  /** null si el modelo no pudo determinar un veredicto del documento. */
  verdict: 'passed' | 'flagged' | null;
  /** Resumen en texto plano de lo que dice el reporte (2-4 oraciones). */
  summaryText: string;
  confidence: number; // 0..1
}

export interface GlmAdapter {
  readonly name: 'glm';
  reason(...): Promise<GlmReasoningResponse>;
  extractReceipt(...): Promise<OcrResult>;
  extractCreditReport(...): Promise<CreditReportExtraction>;
  extractScreeningReport(input: {
    mimeType: string; base64: string; filename?: string; kind: 'credit' | 'criminal';
  }): Promise<ScreeningReportExtraction>; // NUEVO
}
```

Prompt (real): *"This is a tenant [credit report / criminal background
check] PDF for a rental applicant. Read it and summarize the key findings
in 2-4 sentences. Based on the content, decide a verdict: 'passed' if the
report shows no significant concerns (good credit standing / no criminal
record found), 'flagged' if it shows concerns worth human review (poor
credit standing, collections, evictions / a criminal record found). If you
cannot determine either from the document, use null. Respond as JSON:
{"verdict": "passed"|"flagged"|null, "summaryText": string, "confidence":
number between 0 and 1}."* — el `kind` sustituye la parte entre corchetes.

Esto evita depender de un score numérico (que ni existe para antecedentes
penales, ni tiene el mismo formato entre proveedores de crédito) y hace el
mismo método servir para ambos tipos de checkeo.

### 2.2 Servicio nuevo — reutiliza los mapas de campo ya existentes en `screening.service.ts`, sin tocar `persistTerminalResult`

`persistTerminalResult` (privada, no exportada) tiene un guard
`[STATUS_FIELD[kind]]: { in: OPEN_STATUSES }` (`OPEN_STATUSES =
['requested','pending']`) diseñado para que una escritura terminal
*rezagada* de una cadena de jobs automática nunca pise un veredicto ya
cerrado. Una carga manual es lo opuesto: una acción humana explícita que
debe poder registrar un resultado sin importar el estado actual (incluso
`'awaiting_approval'`, `'failed'`, o vacío) — así que NO reutiliza esa
función ni su guard. Función nueva, en el mismo archivo (reutiliza
`STATUS_FIELD`/`SUMMARY_FIELD`/`REPORT_KEY_FIELD`/`COMPLETED_AT_FIELD`, ya
privados ahí, sin necesidad de exportarlos):

```ts
const MANUAL_UPLOAD_MIN_CONFIDENCE = 0.5;

export async function recordManualScreeningReport(
  applicationId: string,
  tenantId: string,
  kind: ScreeningCheckKind,
  upload: { mimeType: string; base64: string; filename?: string },
): Promise<{ ok: true; verdict: 'passed' | 'flagged' } | { ok: false; status: 400 | 404; error: string }> {
  const application = await prisma.rentalApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: { id: true },
  });
  if (!application) return { ok: false, status: 404, error: 'Application not found' };

  const { getAdapters } = await import('../config/adapters.js');
  const extraction = await getAdapters().glm.extractScreeningReport({
    mimeType: upload.mimeType, base64: upload.base64, filename: upload.filename, kind,
  });
  if (extraction.verdict === null || extraction.confidence < MANUAL_UPLOAD_MIN_CONFIDENCE) {
    return { ok: false, status: 400, error: 'Could not determine a verdict from this report — review it manually' };
  }

  const env = getEnv();
  const storage = createLocalDocumentStorage({ rootDir: env.DOCUMENT_STORAGE_DIR, publicBaseUrl: env.DOCUMENT_STORAGE_PUBLIC_BASE_URL || undefined });
  const stored = await storage.putObject({
    key: buildDocumentStorageKey({ tenantId, documentId: `${applicationId}-${kind}`, filename: `${kind}-report.pdf` }),
    body: decodeBase64Payload(upload.base64),
    contentType: upload.mimeType,
  });

  const now = new Date();
  await prisma.rentalApplication.updateMany({
    where: { id: applicationId, tenantId },
    data: {
      [STATUS_FIELD[kind]]: extraction.verdict,
      [SUMMARY_FIELD[kind]]: `[AUTOMATED] ${extraction.summaryText}`,
      [REPORT_KEY_FIELD[kind]]: stored.storageKey,
      [COMPLETED_AT_FIELD[kind]]: now,
      // No hay providerRef/requestedAt equivalente -- fue el staff quien
      // "solicitó" el checkeo por fuera de esta app.
    },
  });
  return { ok: true, verdict: extraction.verdict };
}
```

Igual que el resto del archivo, `[AUTOMATED]` deja claro que fue una
interpretación por OCR/IA del documento, no una lectura humana línea por
línea — mismo principio que ya se aplica al veredicto por umbral de score
de FrontLobby.

**Composición con el resto del sistema, ya cubierta sin cambios
adicionales:** si un checkeo automático (FrontLobby real o mock) sigue en
vuelo (`'requested'`/`'pending'`) cuando el staff sube un reporte manual,
esta función lo cierra igual (sin el guard de `OPEN_STATUSES`). Cuando la
cadena automática eventualmente intente su propio cierre vía
`persistTerminalResult`, su guard ya existente (`WHERE ... IN
('requested','pending')`) no encuentra la fila (ya no está en esos
estados) y descarta la escritura en silencio — comportamiento ya construido
y probado en una fase anterior, no requiere ningún cambio aquí.

### 2.3 Ruta nueva — mismo patrón de auth que la aprobación de FrontLobby

`apps/api/src/routes/leads.ts`, junto a la ruta de aprobación existente:

```ts
const uploadReportSchema = z.object({
  mimeType: z.string().min(5),
  base64: z.string().min(10),
  filename: z.string().optional(),
});
const MAX_REPORT_BASE64_LENGTH = 1_500_000; // mismo tope que idDocumentBase64

leadsRouter.post(
  '/applications/:applicationId/screening/:kind/upload-report',
  requireAuth,
  requireRole('property_manager', 'broker'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { applicationId, kind } = req.params;
      if (kind !== 'credit' && kind !== 'criminal') {
        res.status(400).json({ error: 'Invalid screening kind' });
        return;
      }
      const parsed = uploadReportSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid upload', details: parsed.error.flatten() });
        return;
      }
      if (parsed.data.base64.length > MAX_REPORT_BASE64_LENGTH) {
        res.status(400).json({ error: 'The report file is too large' });
        return;
      }
      const result = await recordManualScreeningReport(applicationId, user.tenantId, kind, parsed.data);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ ok: true, verdict: result.verdict });
    } catch (err) {
      next(err);
    }
  },
);
```

Mismo tope de tamaño (`1_500_000`) que `idDocumentBase64` en el formulario
público — el límite global de `express.json({ limit: '2mb' })` ya acota
esto de todos modos, pero un 400 explícito da un mensaje más claro que el
error genérico de body-parser.

### 2.4 UI — botón de carga en `ScreeningBlock`, mismo patrón que `BillsPage.tsx`

`apps/web/src/pages/ShowingsPage.tsx`, `ScreeningBlock`: un `<input
type="file" accept="application/pdf">` oculto, disparado por un botón
*"Upload report manually"*, visible con el mismo gate de rol que el botón
de aprobación (`canApprove`) — es una decisión de screening, mismo nivel
de permiso. Convierte el archivo a base64 igual que
`BillsPage.tsx:198-209` (`FileReader.readAsDataURL` + strip del prefijo
`data:...;base64,`), hace `POST
/leads/applications/${applicationId}/screening/${kind}/upload-report`, e
invalida la query `['showing-application']` al éxito — mismo patrón que la
mutación de aprobación ya existente en el mismo componente. El botón de
descarga del reporte (ya existente, sin cambios) sigue funcionando igual
una vez que `reportKey` queda seteado.

## 3. Fuera de alcance

- No se agrega un estado "necesita revisión manual" al enum de status —
  cuando el modelo no puede determinar un veredicto confiable, la carga se
  rechaza con un error claro y el staff decide qué hacer (reintentar con
  otro documento, o revisar y decidir el veredicto fuera de esta feature).
  YAGNI: agregar ese estado es una extensión futura si en la práctica
  resulta necesario, no una suposición de este diseño.
- No se toca `extractCreditReport` ni ningún código de `front-lobby.real.ts`
  — esta feature es deliberadamente independiente del adapter de
  FrontLobby, para no acoplar "cualquier proveedor, reporte manual" a la
  lógica específica de un proveedor en particular.
- No se agrega ningún campo nuevo al schema — los campos
  `creditCheck*`/`criminalCheck*` ya existentes son genéricos y suficientes.
