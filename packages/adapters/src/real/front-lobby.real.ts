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
import { decodeProviderRef, encodeProviderRef, formatAutomatedSummary, scoreToVerdict } from './front-lobby.helpers.js';

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
    const existingRow = page.getByRole('row', { name: new RegExp(property.address, 'i') });
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
    try {
      return await this.withBrowser(async (page) => {
        await page.goto(`${FRONTLOBBY_BASE_URL}/tenant-screening`);
        await page.click('text=Screen Tenant');
        await page.click('text=You Pay and You Fill Out Information');
        await page.click('button:has-text("Continue")');
        await page.click('text=Credit Report');
        await page.click('button:has-text("Continue")');
        const property: FrontLobbyProperty = {
          name: input.currentAddress,
          address: input.currentAddress,
          city: input.currentCity,
          province: input.currentProvince,
          postalCode: input.currentPostalCode,
        };
        await this.ensureProperty(page, property);
        await this.fillApplicantDetails(page, input, property);
        await page.click('button:has-text("Continue")');
        // Paso 4 (confirmación/pago) — no verificado contra la app real
        // (ver la nota del task que creó este archivo). Confirmar el envío
        // real y, si aparece un ID propio de FrontLobby, preferirlo sobre
        // encodeProviderRef.
        await page.click('button:has-text("Submit")');
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
    const { fullName } = decodeProviderRef(providerRef);
    try {
      return await this.withBrowser(async (page) => {
        await page.goto(`${FRONTLOBBY_BASE_URL}/tenant-screening/reports`);
        await page.fill('input[placeholder="Search for applicant or property"]', fullName);
        const row = page.getByRole('row', { name: new RegExp(fullName, 'i') });
        if (await row.count() === 0) {
          return { status: 'pending', providerRef };
        }
        const statusText = (await row.first().textContent()) ?? '';
        // El texto real de "completado" en la columna Status no se pudo
        // observar (cuenta sin reportes generados aún) — se asume que
        // contiene "complete" o "ready", ajustar tras la primera corrida
        // real si el texto real difiere.
        if (!/complete|ready/i.test(statusText)) {
          return { status: 'pending', providerRef };
        }
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          row.first().getByRole('link', { name: /report|download/i }).click(),
        ]);
        const stream = await download.createReadStream();
        const chunks: Buffer[] = [];
        if (stream) {
          for await (const chunk of stream) {
            chunks.push(chunk as Buffer);
          }
        }
        const pdfBuffer = Buffer.concat(chunks);
        const base64 = pdfBuffer.toString('base64');
        const extraction = await this.glm.extractCreditReport({ mimeType: 'application/pdf', base64 });
        if (extraction.score === null) {
          return { status: 'failed', reason: 'Could not read credit score from report' };
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
