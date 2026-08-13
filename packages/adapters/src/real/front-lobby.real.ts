/**
 * Adapter real de FrontLobby (checkeo de crédito) vía Playwright. Un
 * navegador nuevo por llamada (nunca sesión colgada) — mismo principio que
 * el resto de esta feature. La navegación real NO tiene test automatizado
 * (ver el task que crea este archivo) — cualquier fallo se traduce en
 * `{status: 'failed', reason: ...}` con el error real, nunca en un
 * resultado inventado.
 */
import { chromium, type Browser, type Page } from 'playwright';
import type {
  ScreeningAdapter,
  ScreeningApplicantInput,
  ScreeningCheckKind,
  ScreeningRunResult,
  GlmAdapter,
} from '../contracts.js';
import {
  decodeProviderRef,
  encodeProviderRef,
  escapeRegExp,
  formatAutomatedSummary,
  isExtractionConfident,
  pickReportRowIndex,
  scoreToVerdict,
} from './front-lobby.helpers.js';

const FRONTLOBBY_BASE_URL = 'https://app.frontlobby.com';

export interface FrontLobbyProperty {
  name: string;
  address: string;
  city: string;
  province: string;
  postalCode: string;
}

export class FrontLobbyScreeningAdapter implements ScreeningAdapter {
  readonly name = 'screening_playwright' as const;

  constructor(
    private readonly credentials: { username: string; password: string },
    private readonly glm: GlmAdapter,
  ) {}

  private async withBrowser<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const browser: Browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await this.login(page);
      return await fn(page);
    } finally {
      await browser.close();
    }
  }

  private async login(page: Page): Promise<void> {
    await page.goto(`${FRONTLOBBY_BASE_URL}/login`);
    await page.fill('#email', this.credentials.username);
    await page.fill('#password', this.credentials.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${FRONTLOBBY_BASE_URL}/dashboard`, { timeout: 15_000 });
  }

  private async ensureProperty(page: Page, property: FrontLobbyProperty): Promise<void> {
    await page.goto(`${FRONTLOBBY_BASE_URL}/property`);
    await page.fill('input[placeholder="Search for address..."]', property.address);
    // `count()` no auto-espera a que la tabla reaccione al filtro recién
    // escrito (a diferencia de la mayoría de los métodos de Playwright) —
    // sin esta pausa se puede leer el estado viejo de la tabla y crear una
    // Property duplicada en la cuenta real. 500ms es el mínimo aceptable
    // documentado; ajustar si una corrida real muestra que no alcanza.
    await page.waitForTimeout(500);
    const existingRow = page.getByRole('row', { name: new RegExp(escapeRegExp(property.address), 'i') });
    if (await existingRow.count() > 0) return;

    await page.click('text=+ Add Property');
    await page.getByLabel('Property Name').fill(property.name);
    await page.getByLabel('Street').fill(property.address);
    await page.getByLabel('City/Town').fill(property.city);
    await page.getByLabel('Country').selectOption({ label: 'Canada' });
    await page.getByLabel('Region').selectOption({ label: property.province });
    await page.getByLabel('Postal Code').fill(property.postalCode);
    await page.click('button:has-text("Save")');
    await page.waitForSelector(`text=${property.address}`, { timeout: 10_000 });
  }

  private async fillApplicantDetails(page: Page, input: ScreeningApplicantInput, property: FrontLobbyProperty): Promise<void> {
    await page.getByLabel('First name').fill(input.firstName);
    await page.getByLabel('Last name').fill(input.lastName);
    const [year, month, day] = input.dateOfBirth.split('-').map(Number);
    await page.getByLabel('Date of birth').locator('select').nth(0).selectOption({ value: String(month! - 1) });
    await page.getByLabel('Date of birth').locator('select').nth(1).selectOption({ label: String(day) });
    await page.getByLabel('Date of birth').locator('select').nth(2).selectOption({ label: String(year) });
    await page.getByLabel('Street').fill(input.currentAddress);
    await page.getByLabel('City/Town').fill(input.currentCity);
    await page.getByLabel('Province').selectOption({ label: input.currentProvince });
    await page.getByLabel('Postal Code').fill(input.currentPostalCode);
    const [startYear, startMonth, startDay] = input.currentAddressStartDate.split('-').map(Number);
    await page.getByLabel('Address start date').locator('select').nth(0).selectOption({ value: String(startMonth! - 1) });
    await page.getByLabel('Address start date').locator('select').nth(1).selectOption({ label: String(startDay) });
    await page.getByLabel('Address start date').locator('select').nth(2).selectOption({ label: String(startYear) });
    await page.getByLabel('Property this Screening is for').click();
    await page.getByText(property.address).click();
  }

  async runCheck(kind: ScreeningCheckKind, input: ScreeningApplicantInput): Promise<ScreeningRunResult> {
    if (kind !== 'credit') {
      return { status: 'failed', reason: 'FrontLobbyScreeningAdapter only handles credit checks' };
    }
    // `ensureProperty` construye un RegExp dinámico a partir de esta
    // dirección — un valor vacío/solo espacios matchearía CUALQUIER fila de
    // la tabla de Properties y podría reusar/crear la Property equivocada.
    // Se rechaza acá, antes de lanzar el navegador y gastar el checkeo real.
    if (!input.currentAddress.trim()) {
      return { status: 'failed', reason: 'currentAddress is required to create/search the FrontLobby property' };
    }
    // `input.fullName` viaja en el `providerRef` (vía `encodeProviderRef`) y
    // `pollResult` lo necesita para volver a encontrar la fila en Reports —
    // ese método ya rechaza un nombre vacío, pero si no se valida ACÁ
    // primero, `runCheck` gastaría el cargo real de $18.99 completo y el
    // sondeo fallaría de inmediato después, dejando el checkeo pagado
    // huérfano. `application.applicantFullName` es nullable en Prisma, así
    // que un `''` es alcanzable desde `screening.service.ts`.
    if (!input.fullName.trim()) {
      return { status: 'failed', reason: 'fullName is required to submit and later find this screening' };
    }
    // `fillApplicantDetails` escribe estos dos campos directo en el
    // formulario del paso 3; con `''` el `getByLabel(...).fill('')` no falla
    // pero deja el envío incompleto (y FrontLobby lo rechaza recién después
    // de cobrar). Ambos son nullable en Prisma para las solicitudes previas
    // a la migración de esta fase, así que un `''` es alcanzable desde
    // `screening.service.ts`.
    if (!input.firstName.trim()) {
      return { status: 'failed', reason: 'firstName is required' };
    }
    if (!input.lastName.trim()) {
      return { status: 'failed', reason: 'lastName is required' };
    }
    // `fillApplicantDetails` hace `.split('-').map(Number)` sobre estas dos
    // fechas y mete el resultado en `selectOption({value: String(month - 1)})`.
    // Con `''` eso produce `NaN` → se busca la opción literal `"NaN"` en el
    // <select> → Playwright agota un timeout de 30s con un error críptico,
    // en vez de decir lo único útil: que esta solicitud (anterior a la
    // migración de esta fase) no tiene los datos que FrontLobby necesita.
    // Mismo patrón de validación que ya usa `rental-application.service.ts`
    // para el formulario público.
    const parsedDateOfBirth = new Date(input.dateOfBirth);
    if (!input.dateOfBirth.trim() || Number.isNaN(parsedDateOfBirth.getTime())) {
      return { status: 'failed', reason: 'A valid dateOfBirth is required' };
    }
    const parsedAddressStartDate = new Date(input.currentAddressStartDate);
    if (!input.currentAddressStartDate.trim() || Number.isNaN(parsedAddressStartDate.getTime())) {
      return { status: 'failed', reason: 'A valid currentAddressStartDate is required' };
    }
    try {
      return await this.withBrowser(async (page) => {
        const property: FrontLobbyProperty = {
          name: input.currentAddress,
          address: input.currentAddress,
          city: input.currentCity,
          province: input.currentProvince,
          postalCode: input.currentPostalCode,
        };
        // `ensureProperty` navega a /property (y eventualmente abre el modal
        // de "Add Property"), así que TIENE que correr ANTES de entrar al
        // wizard de Tenant Screening: hacerlo en medio del paso 3 dejaba la
        // página fuera del wizard y `fillApplicantDetails` corría contra la
        // pantalla equivocada, con timeout garantizado en `getByLabel('First
        // name')`. El wizard se abre recién después, ya con la Property
        // existente para que el dropdown "Property this Screening is for"
        // (dentro de `fillApplicantDetails`) pueda encontrarla por dirección.
        await this.ensureProperty(page, property);
        await page.goto(`${FRONTLOBBY_BASE_URL}/tenant-screening`);
        await page.click('text=Screen Tenant');
        await page.click('text=You Pay and You Fill Out Information');
        await page.click('button:has-text("Continue")');
        await page.click('text=Credit Report');
        await page.click('button:has-text("Continue")');
        await this.fillApplicantDetails(page, input, property);
        await page.click('button:has-text("Continue")');
        // Paso 4 (confirmación/pago) — no verificado contra la app real
        // (ver la nota del task que creó este archivo). Confirmar el envío
        // real y, si aparece un ID propio de FrontLobby, preferirlo sobre
        // encodeProviderRef.
        await page.click('button:has-text("Submit")');
        // El clic de Submit retorna en cuanto el clic se despacha, no
        // cuando FrontLobby terminó de procesar el envío del cargo real de
        // $18.99 — sin esperar una señal, `withBrowser` cerraría el
        // navegador de inmediato y podría abortar un envío en vuelo,
        // dejando el cargo en un estado ambiguo. El selector/URL exacto de
        // la pantalla de confirmación no se pudo observar en el recorrido
        // original (para no gastar dinero de prueba) — como señal
        // conservadora se espera a que el botón Submit deje de estar
        // visible. Si esto no coincide con la app real, lanza y el
        // llamador recibe `failed` (nunca un 'pending' sin confirmación).
        await page.waitForSelector('button:has-text("Submit")', { state: 'hidden', timeout: 20_000 });
        const submittedAtIso = new Date().toISOString();
        return { status: 'pending', providerRef: encodeProviderRef(input.fullName, submittedAtIso) };
      });
    } catch (err) {
      return { status: 'failed', reason: err instanceof Error ? err.message : 'Unknown FrontLobby error' };
    }
  }

  async pollResult(kind: ScreeningCheckKind, providerRef: string): Promise<ScreeningRunResult> {
    if (kind !== 'credit') {
      return { status: 'failed', reason: 'FrontLobbyScreeningAdapter only handles credit checks' };
    }
    try {
      // `decodeProviderRef` va DENTRO del try — es la única línea de este
      // adapter que podía lanzar sin que nadie la capturara si `providerRef`
      // llegara malformado en runtime (el tipo dice `string`, pero nada
      // garantiza el formato en producción).
      const { fullName, submittedAtIso } = decodeProviderRef(providerRef);
      // El nombre decodificado se usa para construir un RegExp dinámico
      // contra la tabla de Reports — un valor vacío/solo espacios
      // matchearía CUALQUIER fila y podría devolver el reporte de otro
      // solicitante. Se rechaza acá, antes de lanzar el navegador.
      if (!fullName.trim()) {
        return { status: 'failed', reason: 'providerRef does not contain a usable applicant full name' };
      }
      // `submittedAtIso` es lo único que permite a `isOnOrAfterSubmittedDay`
      // desambiguar filas más abajo — si viene vacío (providerRef
      // malformado), ninguna fila podría matchear NUNCA (el checkeo se
      // quedaría en `pending` hasta agotar reintentos, aunque el reporte
      // real ya se haya generado y pagado). Se rechaza acá con el mismo
      // tratamiento que el guard de `fullName` vacío, en vez de sondear en
      // vano por horas.
      if (!submittedAtIso.trim()) {
        return { status: 'failed', reason: 'providerRef does not contain a usable submission timestamp' };
      }
      return await this.withBrowser(async (page) => {
        await page.goto(`${FRONTLOBBY_BASE_URL}/tenant-screening/reports`);
        await page.fill('input[placeholder="Search for applicant or property"]', fullName);
        // `count()` no auto-espera a que la tabla reaccione al filtro
        // recién escrito — sin esta pausa se puede leer el estado viejo de
        // la tabla. 500ms es el mínimo aceptable documentado.
        await page.waitForTimeout(500);
        const rows = page.getByRole('row', { name: new RegExp(escapeRegExp(fullName), 'i') });
        const rowCount = await rows.count();
        if (rowCount === 0) {
          // Sin este log, un selector/placeholder equivocado (nada de esto
          // se pudo observar en una corrida real) es indistinguible de
          // "FrontLobby todavía no generó el reporte": el checkeo se queda
          // `pending` los 10 reintentos (~2.5h) y muere como 'failed' sin
          // dejar rastro de por qué.
          console.warn(`[FrontLobby] No se encontró ninguna fila para "${fullName}" en Reports`);
          return { status: 'pending', providerRef };
        }
        // Un re-screening del mismo solicitante puede dejar una fila VIEJA
        // con status "complete" en la tabla — sin desambiguar por fecha, se
        // podría leer y persistir el veredicto del checkeo anterior en vez
        // del que se acaba de pagar. Se prefiere la primera fila cuya
        // "Date Created" caiga en o después del DÍA CALENDARIO (UTC) del
        // envío (`submittedAtIso`, codificado en el providerRef) —
        // `isOnOrAfterSubmittedDay` compara por día calendario, no por
        // timestamp exacto, porque `parseRowDate` normalmente solo puede
        // leer una fecha sin hora de la fila, y el reporte casi siempre se
        // genera horas después del envío el MISMO día calendario.
        //
        // Si ninguna fila tiene una fecha parseable que caiga en o después
        // de ese día (o `submittedAtIso` no parsea), NO se adivina cuál
        // fila usar (ni "la última" ni "la primera") — devolvemos
        // `pending` y dejamos que el próximo sondeo lo reintente. Adivinar
        // mal acá persistiría el veredicto de crédito de otro checkeo o
        // solicitante, que es peor que esperar un ciclo más. El formato
        // exacto de la columna "Date Created" queda como punto de
        // verificación de la primera corrida real.
        //
        // Entre VARIAS filas candidatas (posible con la tolerancia de 24h de
        // `isOnOrAfterSubmittedDay` cuando el mismo solicitante se re-screenea
        // dentro de ~48h) se elige la de fecha más reciente, no la primera del
        // DOM — ver `pickReportRowIndex`, que es donde vive esa decisión como
        // función pura testeable.
        const rowTexts: string[] = [];
        for (let i = 0; i < rowCount; i += 1) {
          rowTexts.push((await rows.nth(i).textContent()) ?? '');
        }
        const targetIndex = pickReportRowIndex(rowTexts, submittedAtIso);
        if (targetIndex === null) {
          // Se incluye el texto crudo de las filas que sí aparecieron: si el
          // parseo de fecha está fallando (el formato real de "Date Created"
          // nunca se observó), este log es lo único que permite ver el
          // formato verdadero sin acceso interactivo al navegador.
          console.warn(
            `[FrontLobby] ${rowCount} fila(s) encontradas para "${fullName}" pero ninguna con fecha aceptable (envío: ${submittedAtIso}). Textos de fila: ${JSON.stringify(rowTexts)}`,
          );
          return { status: 'pending', providerRef };
        }
        const targetRow = rows.nth(targetIndex);
        const statusText = rowTexts[targetIndex] ?? '';
        // El texto real de "completado" en la columna Status no se pudo
        // observar (cuenta sin reportes generados aún) — se asume que
        // contiene "complete" o "ready", ajustar tras la primera corrida
        // real si el texto real difiere.
        if (!/complete|ready/i.test(statusText)) {
          return { status: 'pending', providerRef };
        }
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          targetRow.getByRole('link', { name: /report|download/i }).click(),
        ]);
        const stream = await download.createReadStream();
        const chunks: Buffer[] = [];
        if (stream) {
          for await (const chunk of stream) {
            chunks.push(chunk as Buffer);
          }
        }
        const pdfBuffer = Buffer.concat(chunks);
        if (pdfBuffer.length === 0) {
          return { status: 'failed', reason: 'Downloaded report was empty' };
        }
        const base64 = pdfBuffer.toString('base64');
        const extraction = await this.glm.extractCreditReport({ mimeType: 'application/pdf', base64 });
        if (extraction.score === null) {
          return { status: 'failed', reason: 'Could not read credit score from report' };
        }
        if (!isExtractionConfident(extraction.confidence)) {
          return { status: 'failed', reason: 'Credit score extraction confidence too low to trust' };
        }
        return {
          status: 'completed',
          verdict: scoreToVerdict(extraction.score),
          summary: formatAutomatedSummary(extraction.score, extraction.aiSummaryText),
          reportBase64: base64,
          reportMimeType: 'application/pdf',
        };
      });
    } catch (err) {
      return { status: 'failed', reason: err instanceof Error ? err.message : 'Unknown FrontLobby error' };
    }
  }
}
