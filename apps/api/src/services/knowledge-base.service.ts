interface KnowledgeOnboarding {
  services: string[];
  values: string[];
  pricingNotes?: string | null;
  showingPreferences?: string | null;
  petPolicy?: string | null;
  aiTone?: string | null;
  aiInstructions?: string | null;
}

interface KnowledgeUnit {
  name: string;
  rentCents: number;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFeet?: number | null;
  availableFrom?: Date | string | null;
  amenities: string[];
  petPolicy?: string | null;
  parking?: string | null;
  utilities?: string | null;
  isActive: boolean;
}

interface KnowledgeProperty {
  name: string;
  address: string;
  city: string;
  province: string;
  postalCode?: string | null;
  units: KnowledgeUnit[];
}

interface KnowledgeDocument {
  filename: string;
  category: string;
  description?: string | null;
  textContent?: string | null;
}

export interface ObsidianMarkdownFile {
  path: string;
  content: string;
}

export function buildObsidianMarkdownFiles(input: {
  tenantName: string;
  onboarding: KnowledgeOnboarding | null;
  properties: KnowledgeProperty[];
  documents: KnowledgeDocument[];
}): ObsidianMarkdownFile[] {
  return [
    {
      path: `Company/${safeFileName(input.tenantName)}.md`,
      content: buildCompanyMarkdown(input.tenantName, input.onboarding),
    },
    ...input.properties.map((property) => ({
      path: `Properties/${safeFileName(property.name)}.md`,
      content: buildPropertyMarkdown(property),
    })),
    ...input.documents.map((document) => ({
      path: `Documents/${safeFileName(stripExtension(document.filename))}.md`,
      content: buildDocumentMarkdown(document),
    })),
  ];
}

function buildCompanyMarkdown(tenantName: string, onboarding: KnowledgeOnboarding | null): string {
  return [
    `# ${tenantName}`,
    '',
    '## Services',
    list(onboarding?.services),
    '',
    '## Values',
    list(onboarding?.values),
    '',
    '## Pricing Notes',
    onboarding?.pricingNotes ?? 'Not provided.',
    '',
    '## Showing Preferences',
    onboarding?.showingPreferences ?? 'Not provided.',
    '',
    '## Pet Policy',
    onboarding?.petPolicy ?? 'Not provided.',
    '',
    '## AI Tone',
    onboarding?.aiTone ?? 'Not provided.',
    '',
    '## AI Instructions',
    onboarding?.aiInstructions ?? 'Not provided.',
  ].join('\n');
}

function buildPropertyMarkdown(property: KnowledgeProperty): string {
  return [
    `# ${property.name}`,
    '',
    `Address: ${property.address}, ${property.city}, ${property.province}${property.postalCode ? ` ${property.postalCode}` : ''}`,
    '',
    '## Units',
    property.units.length > 0
      ? property.units.map((unit) => `- ${unit.name}: $${(unit.rentCents / 100).toLocaleString('en-CA')}/month${unit.isActive ? '' : ' (inactive)'}`).join('\n')
      : 'No units recorded.',
    '',
    ...property.units.flatMap((unit) => [
      `### ${unit.name}`,
      `Rent: $${(unit.rentCents / 100).toLocaleString('en-CA')}/month`,
      `Beds/Baths: ${unit.bedrooms ?? '-'} / ${unit.bathrooms ?? '-'}`,
      `Square feet: ${unit.squareFeet ?? '-'}`,
      `Available from: ${formatDate(unit.availableFrom)}`,
      `Amenities: ${unit.amenities.length > 0 ? unit.amenities.join(', ') : '-'}`,
      `Pet policy: ${unit.petPolicy ?? '-'}`,
      `Parking: ${unit.parking ?? '-'}`,
      `Utilities: ${unit.utilities ?? '-'}`,
      '',
    ]),
  ].join('\n');
}

function buildDocumentMarkdown(document: KnowledgeDocument): string {
  return [
    `# ${stripExtension(document.filename)}`,
    '',
    `Category: ${document.category}`,
    '',
    '## Description',
    document.description ?? 'Not provided.',
    '',
    '## Extracted Text',
    document.textContent ?? 'No extracted text yet.',
  ].join('\n');
}

function list(values: string[] | undefined): string {
  return values && values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : 'Not provided.';
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('en-CA');
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*]+/g, '-').trim() || 'Untitled';
}
