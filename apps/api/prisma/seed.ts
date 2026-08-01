/**
 * Demo seed for British Columbia property management workflows.
 *
 * This seed is intentionally deterministic: it rebuilds the demo tenant from
 * scratch so the product demo can be reset before every walkthrough.
 *
 * Password for all demo users: Password123!
 */
import { buildAuditEntry, type AuditActorType } from '@property-manager/core';
import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEMO_TENANT_ID = 'tenant_demo_pm';
const DEMO_PASSWORD = 'Password123!';

async function main() {
  console.log('Starting BC demo seed...');

  await prisma.tenant.delete({ where: { id: DEMO_TENANT_ID } }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return undefined;
    }
    throw error;
  });

  const tenant = await prisma.tenant.create({
    data: {
      id: DEMO_TENANT_ID,
      name: 'Pacific Ridge Property Management',
      province: 'BC',
    },
  });

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const pm = await prisma.user.create({
    data: {
      id: 'user_demo_pm',
      tenantId: tenant.id,
      email: 'pm@pacificridge.ca',
      passwordHash,
      firstName: 'Diana',
      lastName: 'Reyes',
      role: UserRole.property_manager,
      lastLoginAt: new Date('2026-07-09T15:05:00-07:00'),
    },
  });
  const bookkeeper = await prisma.user.create({
    data: {
      id: 'user_demo_books',
      tenantId: tenant.id,
      email: 'books@pacificridge.ca',
      passwordHash,
      firstName: 'Jorge',
      lastName: 'Liu',
      role: UserRole.bookkeeper,
      lastLoginAt: new Date('2026-07-09T14:52:00-07:00'),
    },
  });
  const broker = await prisma.user.create({
    data: {
      id: 'user_demo_broker',
      tenantId: tenant.id,
      email: 'broker@pacificridge.ca',
      passwordHash,
      firstName: 'Marcus',
      lastName: 'Beaulieu',
      role: UserRole.broker,
      lastLoginAt: new Date('2026-07-09T13:20:00-07:00'),
    },
  });

  // ============================================================
  // Properties (8) — broader BC geography: Vancouver, Burnaby,
  // Richmond, Surrey, North Vancouver, Victoria, Kelowna.
  // ============================================================
  const cedarCourt = await prisma.property.create({
    data: {
      id: 'property_cedar_court',
      tenantId: tenant.id,
      name: 'Cedar Court Apartments',
      address: '1200 Granville St',
      city: 'Vancouver',
      province: 'BC',
      postalCode: 'V6Z 1R9',
    },
  });
  const harbourView = await prisma.property.create({
    data: {
      id: 'property_harbour_view',
      tenantId: tenant.id,
      name: 'Harbour View Suites',
      address: '789 Wharf St',
      city: 'Victoria',
      province: 'BC',
      postalCode: 'V8W 1T3',
    },
  });
  const kitsPoint = await prisma.property.create({
    data: {
      id: 'property_kits_point',
      tenantId: tenant.id,
      name: 'Kits Point Walkups',
      address: '2145 Cornwall Ave',
      city: 'Vancouver',
      province: 'BC',
      postalCode: 'V6K 1B5',
    },
  });
  const burnabyHeights = await prisma.property.create({
    data: {
      id: 'property_burnaby_heights',
      tenantId: tenant.id,
      name: 'Burnaby Heights Lofts',
      address: '4100 Hastings St',
      city: 'Burnaby',
      province: 'BC',
      postalCode: 'V5C 2K4',
    },
  });
  const richmondGardens = await prisma.property.create({
    data: {
      id: 'property_richmond_gardens',
      tenantId: tenant.id,
      name: 'Richmond Garden Towers',
      address: '6500 No 3 Rd',
      city: 'Richmond',
      province: 'BC',
      postalCode: 'V6Y 2C6',
    },
  });
  const surreyCrossing = await prisma.property.create({
    data: {
      id: 'property_surrey_crossing',
      tenantId: tenant.id,
      name: 'Surrey Crossing Residences',
      address: '10253 King George Blvd',
      city: 'Surrey',
      province: 'BC',
      postalCode: 'V3T 2W3',
    },
  });
  const northVanBluffs = await prisma.property.create({
    data: {
      id: 'property_northvan_bluffs',
      tenantId: tenant.id,
      name: 'North Van Bluffs Estates',
      address: '1455 Marine Dr W',
      city: 'North Vancouver',
      province: 'BC',
      postalCode: 'V7P 1T5',
    },
  });
  const kelownaVista = await prisma.property.create({
    data: {
      id: 'property_kelowna_vista',
      tenantId: tenant.id,
      name: 'Kelowna Lakeside Vista',
      address: '1500 Abbott St',
      city: 'Kelowna',
      province: 'BC',
      postalCode: 'V1Y 8X5',
    },
  });

  // ============================================================
  // Units (15) — every field the chatbot uses for matching is
  // populated: bedrooms, bathrooms, squareFeet, availableFrom,
  // amenities, petPolicy, parking, utilities, isActive.
  // ============================================================
  const unit101 = await prisma.unit.create({
    data: {
      id: 'unit_cedar_101',
      tenantId: tenant.id,
      propertyId: cedarCourt.id,
      name: 'Apt 101',
      rentCents: 240000,
      slug: 'cedar-court-apt-101',
      bedrooms: 1,
      bathrooms: 1,
      squareFeet: 620,
      availableFrom: new Date('2026-08-01'),
      amenities: ['in-suite laundry', 'dishwasher', 'storage locker'],
      petPolicy: 'Cats allowed',
      parking: 'Street permit parking',
      utilities: 'Tenant pays hydro',
    },
  });
  const unit102 = await prisma.unit.create({
    data: {
      id: 'unit_cedar_102',
      tenantId: tenant.id,
      propertyId: cedarCourt.id,
      name: 'Apt 102',
      rentCents: 265000,
      slug: 'cedar-court-apt-102',
      bedrooms: 2,
      bathrooms: 1,
      squareFeet: 850,
      availableFrom: new Date('2026-07-15'),
      amenities: ['in-suite laundry', 'dishwasher', 'balcony'],
      petPolicy: 'Pet friendly',
      parking: '1 stall included',
      utilities: 'Tenant pays hydro',
    },
  });
  const unitPH = await prisma.unit.create({
    data: {
      id: 'unit_harbour_ph',
      tenantId: tenant.id,
      propertyId: harbourView.id,
      name: 'Penthouse 4',
      rentCents: 385000,
      slug: 'harbour-view-penthouse-4',
      bedrooms: 2,
      bathrooms: 2,
      squareFeet: 1200,
      availableFrom: new Date('2026-09-01'),
      amenities: ['in-suite laundry', 'dishwasher', 'conciege', 'rooftop deck', 'gym'],
      petPolicy: 'No pets',
      parking: '2 secured stalls included',
      utilities: 'Heat and hot water included',
    },
  });
  const unitKits = await prisma.unit.create({
    data: {
      id: 'unit_kits_203',
      tenantId: tenant.id,
      propertyId: kitsPoint.id,
      name: 'Suite 203',
      rentCents: 295000,
      slug: 'kits-point-suite-203',
      bedrooms: 2,
      bathrooms: 1,
      squareFeet: 910,
      availableFrom: new Date('2026-08-15'),
      amenities: ['shared laundry', 'dishwasher', 'patio'],
      petPolicy: 'Pet friendly',
      parking: '1 stall included',
      utilities: 'Tenant pays hydro',
    },
  });
  const unitBurnaby301 = await prisma.unit.create({
    data: {
      id: 'unit_burnaby_301',
      tenantId: tenant.id,
      propertyId: burnabyHeights.id,
      name: 'Loft 301',
      rentCents: 255000,
      slug: 'burnaby-heights-loft-301',
      bedrooms: 1,
      bathrooms: 1,
      squareFeet: 700,
      availableFrom: new Date('2026-08-01'),
      amenities: ['in-suite laundry', 'dishwasher', 'hardwood floors'],
      petPolicy: 'Cats allowed',
      parking: '1 secured stall included',
      utilities: 'Tenant pays hydro',
    },
  });
  const unitBurnaby410 = await prisma.unit.create({
    data: {
      id: 'unit_burnaby_410',
      tenantId: tenant.id,
      propertyId: burnabyHeights.id,
      name: 'Loft 410',
      rentCents: 275000,
      slug: 'burnaby-heights-loft-410',
      bedrooms: 2,
      bathrooms: 2,
      squareFeet: 980,
      availableFrom: new Date('2026-08-15'),
      amenities: ['in-suite laundry', 'dishwasher', 'city view balcony'],
      petPolicy: 'Pet friendly',
      parking: '1 stall included',
      utilities: 'Heat included',
    },
  });
  const unitRichmond502 = await prisma.unit.create({
    data: {
      id: 'unit_richmond_502',
      tenantId: tenant.id,
      propertyId: richmondGardens.id,
      name: 'Tower 502',
      rentCents: 225000,
      slug: 'richmond-garden-tower-502',
      bedrooms: 1,
      bathrooms: 1,
      squareFeet: 590,
      availableFrom: new Date('2026-07-20'),
      amenities: ['gym', 'shared laundry', 'bike storage'],
      petPolicy: 'No pets',
      parking: 'Paid parking available',
      utilities: 'Tenant pays hydro',
    },
  });
  const unitRichmond611 = await prisma.unit.create({
    data: {
      id: 'unit_richmond_611',
      tenantId: tenant.id,
      propertyId: richmondGardens.id,
      name: 'Tower 611',
      rentCents: 320000,
      slug: 'richmond-garden-tower-611',
      bedrooms: 3,
      bathrooms: 2,
      squareFeet: 1150,
      availableFrom: new Date('2026-09-15'),
      amenities: ['gym', 'in-suite laundry', 'dishwasher', 'balcony'],
      petPolicy: 'Pet friendly',
      parking: '2 stalls included',
      utilities: 'Heat included',
    },
  });
  const unitSurrey204 = await prisma.unit.create({
    data: {
      id: 'unit_surrey_204',
      tenantId: tenant.id,
      propertyId: surreyCrossing.id,
      name: 'Suite 204',
      rentCents: 205000,
      slug: 'surrey-crossing-suite-204',
      bedrooms: 1,
      bathrooms: 1,
      squareFeet: 560,
      availableFrom: new Date('2026-08-01'),
      amenities: ['shared laundry', 'bike storage'],
      petPolicy: 'Cats allowed',
      parking: 'Street permit parking',
      utilities: 'Tenant pays hydro',
    },
  });
  const unitSurrey305 = await prisma.unit.create({
    data: {
      id: 'unit_surrey_305',
      tenantId: tenant.id,
      propertyId: surreyCrossing.id,
      name: 'Suite 305',
      rentCents: 245000,
      slug: 'surrey-crossing-suite-305',
      bedrooms: 2,
      bathrooms: 1,
      squareFeet: 820,
      availableFrom: new Date('2026-08-15'),
      amenities: ['in-suite laundry', 'dishwasher'],
      petPolicy: 'No pets',
      parking: '1 stall included',
      utilities: 'Tenant pays hydro',
    },
  });
  const unitNorthVan101 = await prisma.unit.create({
    data: {
      id: 'unit_northvan_101',
      tenantId: tenant.id,
      propertyId: northVanBluffs.id,
      name: 'Estates 101',
      rentCents: 310000,
      slug: 'northvan-bluffs-estates-101',
      bedrooms: 2,
      bathrooms: 2,
      squareFeet: 1000,
      availableFrom: new Date('2026-08-10'),
      amenities: ['in-suite laundry', 'dishwasher', 'mountain view', 'gym'],
      petPolicy: 'Pet friendly',
      parking: '1 secured stall included',
      utilities: 'Heat and hot water included',
    },
  });
  const unitNorthVan202 = await prisma.unit.create({
    data: {
      id: 'unit_northvan_202',
      tenantId: tenant.id,
      propertyId: northVanBluffs.id,
      name: 'Estates 202',
      rentCents: 345000,
      slug: 'northvan-bluffs-estates-202',
      bedrooms: 3,
      bathrooms: 2,
      squareFeet: 1280,
      availableFrom: new Date('2026-09-01'),
      amenities: ['in-suite laundry', 'dishwasher', 'patio', 'gym'],
      petPolicy: 'Pet friendly',
      parking: '2 stalls included',
      utilities: 'Heat included',
    },
  });
  const unitKelowna303 = await prisma.unit.create({
    data: {
      id: 'unit_kelowna_303',
      tenantId: tenant.id,
      propertyId: kelownaVista.id,
      name: 'Lakeside 303',
      rentCents: 215000,
      slug: 'kelowna-lakeside-vista-303',
      bedrooms: 1,
      bathrooms: 1,
      squareFeet: 580,
      availableFrom: new Date('2026-08-01'),
      amenities: ['shared laundry', 'lake view', 'bike storage'],
      petPolicy: 'Cats allowed',
      parking: 'Street permit parking',
      utilities: 'Tenant pays hydro',
    },
  });
  const unitKelowna404 = await prisma.unit.create({
    data: {
      id: 'unit_kelowna_404',
      tenantId: tenant.id,
      propertyId: kelownaVista.id,
      name: 'Lakeside 404',
      rentCents: 265000,
      slug: 'kelowna-lakeside-vista-404',
      bedrooms: 2,
      bathrooms: 2,
      squareFeet: 940,
      availableFrom: new Date('2026-08-20'),
      amenities: ['in-suite laundry', 'dishwasher', 'lake view balcony'],
      petPolicy: 'Pet friendly',
      parking: '1 stall included',
      utilities: 'Heat included',
    },
  });
  const unitCedar305 = await prisma.unit.create({
    data: {
      id: 'unit_cedar_305',
      tenantId: tenant.id,
      propertyId: cedarCourt.id,
      name: 'Apt 305',
      rentCents: 420000,
      slug: 'cedar-court-apt-305',
      bedrooms: 3,
      bathrooms: 2,
      squareFeet: 1400,
      availableFrom: new Date('2026-09-15'),
      amenities: ['in-suite laundry', 'dishwasher', 'balcony', 'storage locker'],
      petPolicy: 'Pet friendly',
      parking: '2 stalls included',
      utilities: 'Heat included',
    },
  });

  await prisma.listingPhoto.createMany({
    data: [
      {
        id: 'photo_cedar_101_living',
        tenantId: tenant.id,
        unitId: unit101.id,
        originalUrl: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267',
        enhancedUrl: 'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85',
        enhancementType: 'enhance',
        status: 'enhanced',
        autoenhanceOrderId: 'ae_demo_101_living',
        isPrimary: true,
      },
      {
        id: 'photo_cedar_101_kitchen',
        tenantId: tenant.id,
        unitId: unit101.id,
        originalUrl: 'https://images.unsplash.com/photo-1556912173-3bb406ef7e77?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_cedar_101_bedroom',
        tenantId: tenant.id,
        unitId: unit101.id,
        originalUrl: 'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_cedar_101_bathroom',
        tenantId: tenant.id,
        unitId: unit101.id,
        originalUrl: 'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_cedar_102_kitchen',
        tenantId: tenant.id,
        unitId: unit102.id,
        originalUrl: 'https://images.unsplash.com/photo-1556912172-45b7abe8b7e1',
        enhancedUrl: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136',
        enhancementType: 'object_removal',
        status: 'enhanced',
        autoenhanceOrderId: 'ae_demo_102_kitchen',
        isPrimary: true,
      },
      {
        id: 'photo_cedar_102_living',
        tenantId: tenant.id,
        unitId: unit102.id,
        originalUrl: 'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_cedar_102_bedroom',
        tenantId: tenant.id,
        unitId: unit102.id,
        originalUrl: 'https://images.unsplash.com/photo-1616486029423-aaa4789e8c9a?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_cedar_102_balcony',
        tenantId: tenant.id,
        unitId: unit102.id,
        originalUrl: 'https://images.unsplash.com/photo-1511818966892-d7d671e672a2?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_harbour_ph_view',
        tenantId: tenant.id,
        unitId: unitPH.id,
        originalUrl: 'https://images.unsplash.com/photo-1493809842364-78817add7ffb',
        enhancedUrl: null,
        enhancementType: 'virtual_staging',
        status: 'processing',
        autoenhanceOrderId: 'ae_demo_ph_view',
        isPrimary: true,
      },
      {
        id: 'photo_harbour_ph_living',
        tenantId: tenant.id,
        unitId: unitPH.id,
        originalUrl: 'https://images.unsplash.com/photo-1600607687644-c7171b42498f?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_harbour_ph_kitchen',
        tenantId: tenant.id,
        unitId: unitPH.id,
        originalUrl: 'https://images.unsplash.com/photo-1600210492493-0946911123ea?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_harbour_ph_bedroom',
        tenantId: tenant.id,
        unitId: unitPH.id,
        originalUrl: 'https://images.unsplash.com/photo-1616047006789-b7af3eecb8ba?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_burnaby_301_living',
        tenantId: tenant.id,
        unitId: unitBurnaby301.id,
        originalUrl: 'https://images.unsplash.com/photo-1493809842364-78817add7ffb',
        enhancedUrl: 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2',
        enhancementType: 'enhance',
        status: 'enhanced',
        autoenhanceOrderId: 'ae_demo_burnaby_301',
        isPrimary: true,
      },
      {
        id: 'photo_burnaby_301_kitchen',
        tenantId: tenant.id,
        unitId: unitBurnaby301.id,
        originalUrl: 'https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_burnaby_301_bedroom',
        tenantId: tenant.id,
        unitId: unitBurnaby301.id,
        originalUrl: 'https://images.unsplash.com/photo-1615874959474-d609969a20ed?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_burnaby_301_bathroom',
        tenantId: tenant.id,
        unitId: unitBurnaby301.id,
        originalUrl: 'https://images.unsplash.com/photo-1629079447777-1e605162dc8d?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_richmond_611_patio',
        tenantId: tenant.id,
        unitId: unitRichmond611.id,
        originalUrl: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688',
        enhancedUrl: null,
        enhancementType: 'virtual_staging',
        status: 'processing',
        autoenhanceOrderId: 'ae_demo_richmond_611',
        isPrimary: true,
      },
      {
        id: 'photo_richmond_611_living',
        tenantId: tenant.id,
        unitId: unitRichmond611.id,
        originalUrl: 'https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_richmond_611_kitchen',
        tenantId: tenant.id,
        unitId: unitRichmond611.id,
        originalUrl: 'https://images.unsplash.com/photo-1556912167-f556f1f39fdf?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_richmond_611_bedroom',
        tenantId: tenant.id,
        unitId: unitRichmond611.id,
        originalUrl: 'https://images.unsplash.com/photo-1616594039964-ae9021a400a0?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_northvan_202_exterior',
        tenantId: tenant.id,
        unitId: unitNorthVan202.id,
        originalUrl: 'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: true,
      },
      {
        id: 'photo_northvan_202_living',
        tenantId: tenant.id,
        unitId: unitNorthVan202.id,
        originalUrl: 'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_northvan_202_kitchen',
        tenantId: tenant.id,
        unitId: unitNorthVan202.id,
        originalUrl: 'https://images.unsplash.com/photo-1600585152915-d208bec867a1?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_northvan_202_bedroom',
        tenantId: tenant.id,
        unitId: unitNorthVan202.id,
        originalUrl: 'https://images.unsplash.com/photo-1615874959474-d609969a20ed?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_cedar_305_living',
        tenantId: tenant.id,
        unitId: unitCedar305.id,
        originalUrl: 'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: true,
      },
      {
        id: 'photo_cedar_305_kitchen',
        tenantId: tenant.id,
        unitId: unitCedar305.id,
        originalUrl: 'https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_cedar_305_bedroom',
        tenantId: tenant.id,
        unitId: unitCedar305.id,
        originalUrl: 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_cedar_305_bathroom',
        tenantId: tenant.id,
        unitId: unitCedar305.id,
        originalUrl: 'https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_surrey_204_living',
        tenantId: tenant.id,
        unitId: unitSurrey204.id,
        originalUrl: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: true,
      },
      {
        id: 'photo_surrey_204_kitchen',
        tenantId: tenant.id,
        unitId: unitSurrey204.id,
        originalUrl: 'https://images.unsplash.com/photo-1556912172-45b7abe8b7e1?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_surrey_204_bedroom',
        tenantId: tenant.id,
        unitId: unitSurrey204.id,
        originalUrl: 'https://images.unsplash.com/photo-1616594039964-ae9021a400a0?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_surrey_204_bathroom',
        tenantId: tenant.id,
        unitId: unitSurrey204.id,
        originalUrl: 'https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_surrey_305_living',
        tenantId: tenant.id,
        unitId: unitSurrey305.id,
        originalUrl: 'https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: true,
      },
      {
        id: 'photo_surrey_305_kitchen',
        tenantId: tenant.id,
        unitId: unitSurrey305.id,
        originalUrl: 'https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_surrey_305_bedroom',
        tenantId: tenant.id,
        unitId: unitSurrey305.id,
        originalUrl: 'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_surrey_305_bathroom',
        tenantId: tenant.id,
        unitId: unitSurrey305.id,
        originalUrl: 'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_kelowna_404_view',
        tenantId: tenant.id,
        unitId: unitKelowna404.id,
        originalUrl: 'https://images.unsplash.com/photo-1512917774080-9991f1c4c750',
        enhancedUrl: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c',
        enhancementType: 'enhance',
        status: 'enhanced',
        autoenhanceOrderId: 'ae_demo_kelowna_404',
        isPrimary: true,
      },
      {
        id: 'photo_kelowna_404_living',
        tenantId: tenant.id,
        unitId: unitKelowna404.id,
        originalUrl: 'https://images.unsplash.com/photo-1600585154526-990dced4db0d?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_kelowna_404_kitchen',
        tenantId: tenant.id,
        unitId: unitKelowna404.id,
        originalUrl: 'https://images.unsplash.com/photo-1565538810643-b5bdb714032a?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
      {
        id: 'photo_kelowna_404_bedroom',
        tenantId: tenant.id,
        unitId: unitKelowna404.id,
        originalUrl: 'https://images.unsplash.com/photo-1617098907762-2f6f37cd7b15?auto=format&fit=crop&w=1400&q=85',
        enhancedUrl: null,
        enhancementType: 'none',
        status: 'uploaded',
        isPrimary: false,
      },
    ],
  });

  const sarah = await prisma.tenantRecord.create({
    data: {
      id: 'tenant_record_sarah',
      tenantId: tenant.id,
      firstName: 'Sarah',
      lastName: 'Chen',
      email: 'sarah.chen@example.ca',
      phone: '+16045551234',
      idVerificationRef: 'idv_sarah_bc_dl',
    },
  });
  const daniel = await prisma.tenantRecord.create({
    data: {
      id: 'tenant_record_daniel',
      tenantId: tenant.id,
      firstName: 'Daniel',
      lastName: 'Morrison',
      email: 'daniel.morrison@example.ca',
      phone: '+16045554321',
    },
  });

  await prisma.lease.createMany({
    data: [
      {
        id: 'lease_sarah_cedar_101',
        tenantId: tenant.id,
        unitId: unit101.id,
        tenantRecordId: sarah.id,
        startDate: new Date('2026-03-01'),
        endDate: new Date('2027-02-28'),
        rentCents: 240000,
        depositCents: 120000,
        status: 'active',
        rtaDraftDocRef: 'rta_draft_sarah_2026_03',
        signedDocRef: 'signed_rta_sarah_2026_03',
        docusignEnvelopeId: 'env_demo_sarah_signed',
        docusignStatus: 'completed',
      },
      {
        id: 'lease_daniel_kits_203',
        tenantId: tenant.id,
        unitId: unitKits.id,
        tenantRecordId: daniel.id,
        startDate: new Date('2026-08-01'),
        endDate: new Date('2027-07-31'),
        rentCents: 295000,
        depositCents: 147500,
        status: 'draft',
        rtaDraftDocRef: 'rta_draft_daniel_2026_08',
        docusignEnvelopeId: 'env_demo_daniel_sent',
        docusignStatus: 'sent',
      },
    ],
  });

  await prisma.owner.createMany({
    data: [
      {
        id: 'owner_patterson',
        tenantId: tenant.id,
        firstName: 'Elizabeth',
        lastName: 'Patterson',
        email: 'e.patterson@example.ca',
        phone: '+16045550101',
      },
      {
        id: 'owner_nguyen',
        tenantId: tenant.id,
        firstName: 'Minh',
        lastName: 'Nguyen',
        email: 'm.nguyen@example.ca',
        phone: '+17785550102',
      },
    ],
  });

  // ============================================================
  // Leads (11) — spread across the full funnel and channels.
  // ============================================================
  const leadMaya = await prisma.lead.create({
    data: {
      id: 'lead_maya',
      tenantId: tenant.id,
      unitId: unit102.id,
      name: 'Maya Thompson',
      email: 'maya.thompson@example.ca',
      phone: '+16045551001',
      message: 'Looking for a July move-in near downtown, budget around $2,700.',
      source: 'whatsapp',
      preferredChannel: 'whatsapp',
      status: 'tour_scheduled',
      showmojoShowingId: 'sm_showing_maya',
      tourUrl: 'https://showmojo.example/demo/maya',
    },
  });
  const leadNoah = await prisma.lead.create({
    data: {
      id: 'lead_noah',
      tenantId: tenant.id,
      unitId: unitPH.id,
      name: 'Noah Singh',
      email: 'noah.singh@example.ca',
      phone: '+17785551002',
      message: 'Interested in the waterfront penthouse and parking availability.',
      source: 'unit_url',
      preferredChannel: 'web',
      status: 'new_',
    },
  });
  const leadPriya = await prisma.lead.create({
    data: {
      id: 'lead_priya',
      tenantId: tenant.id,
      unitId: unitKits.id,
      name: 'Priya Nair',
      email: 'priya.nair@example.ca',
      phone: '+16045551003',
      message: 'Needs a pet-friendly suite close to Kits Beach.',
      source: 'showmojo',
      preferredChannel: 'sms',
      status: 'qualified',
      showmojoShowingId: 'sm_showing_priya',
      tourUrl: 'https://showmojo.example/demo/priya',
    },
  });
  await prisma.lead.create({
    data: {
      id: 'lead_elena',
      tenantId: tenant.id,
      unitId: unit101.id,
      name: 'Elena Garcia',
      email: 'elena.garcia@example.ca',
      phone: '+16045551004',
      message: 'Converted after broker review. Preparing references.',
      source: 'manual',
      preferredChannel: 'email',
      status: 'converted',
    },
  });
  const leadAiden = await prisma.lead.create({
    data: {
      id: 'lead_aiden',
      tenantId: tenant.id,
      unitId: unitBurnaby301.id,
      name: 'Aiden Walker',
      email: 'aiden.walker@example.ca',
      phone: '+16045551005',
      message: 'Budget around $2,600. Moving in August near Burnaby, 2 people and a cat.',
      source: 'whatsapp',
      preferredChannel: 'whatsapp',
      status: 'tour_scheduled',
      operationalStatus: 'assigned',
      assignedUserId: pm.id,
    },
  });
  const leadSofia = await prisma.lead.create({
    data: {
      id: 'lead_sofia',
      tenantId: tenant.id,
      unitId: unitRichmond611.id,
      name: 'Sofia Rossi',
      email: 'sofia.rossi@example.ca',
      phone: '+16045551006',
      message: 'Family of 4 looking for a 3-bedroom in Richmond, pet-friendly.',
      source: 'sms',
      preferredChannel: 'sms',
      status: 'contacted',
    },
  });
  const leadMarcus = await prisma.lead.create({
    data: {
      id: 'lead_marcus',
      tenantId: tenant.id,
      unitId: unitKelowna404.id,
      name: 'Marcus Lee',
      email: 'marcus.lee@example.ca',
      phone: '+16045551007',
      message: 'Relocating to Kelowna, wants a 2-bed with lake view, flexible on dates.',
      source: 'telegram',
      preferredChannel: 'telegram',
      status: 'qualified',
    },
  });
  await prisma.lead.create({
    data: {
      id: 'lead_olivia',
      tenantId: tenant.id,
      unitId: unitSurrey204.id,
      name: 'Olivia Brown',
      email: 'olivia.brown@example.ca',
      phone: '+16045551008',
      message: 'Budget tight, needs something under $2,200 in Surrey.',
      source: 'web',
      preferredChannel: 'web',
      status: 'new_',
      operationalStatus: 'needs_review',
    },
  });
  const leadJamal = await prisma.lead.create({
    data: {
      id: 'lead_jamal',
      tenantId: tenant.id,
      unitId: unitNorthVan101.id,
      name: 'Jamal Ahmed',
      email: 'jamal.ahmed@example.ca',
      phone: '+16045551009',
      message: 'Looking in North Vancouver, $3,000 budget, has a medium dog.',
      source: 'whatsapp',
      preferredChannel: 'whatsapp',
      status: 'contacted',
    },
  });
  await prisma.lead.create({
    data: {
      id: 'lead_chloe',
      tenantId: tenant.id,
      unitId: unitCedar305.id,
      name: 'Chloe Dubois',
      email: 'chloe.dubois@example.ca',
      phone: '+16045551010',
      message: 'Wanted a 3-bedroom downtown but budget did not align.',
      source: 'showmojo',
      preferredChannel: 'email',
      status: 'lost',
    },
  });
  const leadRavi = await prisma.lead.create({
    data: {
      id: 'lead_ravi',
      tenantId: tenant.id,
      unitId: unitBurnaby410.id,
      name: 'Ravi Patel',
      email: 'ravi.patel@example.ca',
      phone: '+16045551011',
      message: 'Interested in a 2-bed loft in Burnaby Heights, move-in September.',
      source: 'unit_url',
      preferredChannel: 'sms',
      status: 'tour_scheduled',
    },
  });

  // ============================================================
  // Conversations (6) — each with messages + enriched slots in
  // different FSM states so the inbox feels alive.
  // ============================================================
  const conversationMaya = await prisma.chatConversation.create({
    data: {
      id: 'conv_maya_whatsapp',
      tenantId: tenant.id,
      externalId: 'whatsapp:+16045551001',
      channel: 'whatsapp',
      unitId: unit102.id,
      state: 'scheduling',
      leadId: leadMaya.id,
      updatedAt: new Date('2026-07-09T10:30:00-07:00'),
    },
  });
  const conversationNoah = await prisma.chatConversation.create({
    data: {
      id: 'conv_noah_web',
      tenantId: tenant.id,
      externalId: 'web_session_noah',
      channel: 'web',
      unitId: unitPH.id,
      state: 'collecting_budget',
      leadId: leadNoah.id,
      updatedAt: new Date('2026-07-09T11:05:00-07:00'),
    },
  });
  const conversationAiden = await prisma.chatConversation.create({
    data: {
      id: 'conv_aiden_whatsapp',
      tenantId: tenant.id,
      externalId: 'whatsapp:+16045551005',
      channel: 'whatsapp',
      unitId: unitBurnaby301.id,
      state: 'proposing_tour',
      leadId: leadAiden.id,
      updatedAt: new Date('2026-07-09T09:48:00-07:00'),
    },
  });
  const conversationSofia = await prisma.chatConversation.create({
    data: {
      id: 'conv_sofia_sms',
      tenantId: tenant.id,
      externalId: 'sms:+16045551006',
      channel: 'sms',
      unitId: unitRichmond611.id,
      state: 'collecting_movein',
      leadId: leadSofia.id,
      updatedAt: new Date('2026-07-09T08:22:00-07:00'),
    },
  });
  const conversationJamal = await prisma.chatConversation.create({
    data: {
      id: 'conv_jamal_whatsapp',
      tenantId: tenant.id,
      externalId: 'whatsapp:+16045551009',
      channel: 'whatsapp',
      unitId: unitNorthVan101.id,
      state: 'handoff',
      leadId: leadJamal.id,
      updatedAt: new Date('2026-07-09T14:15:00-07:00'),
    },
  });
  const conversationRavi = await prisma.chatConversation.create({
    data: {
      id: 'conv_ravi_sms',
      tenantId: tenant.id,
      externalId: 'sms:+16045551011',
      channel: 'sms',
      unitId: unitBurnaby410.id,
      state: 'scheduling',
      leadId: leadRavi.id,
      updatedAt: new Date('2026-07-09T12:40:00-07:00'),
    },
  });

  await prisma.chatMessage.createMany({
    data: [
      // Maya (scheduling)
      {
        id: 'msg_maya_1',
        conversationId: conversationMaya.id,
        role: 'user',
        content: 'Hi, is Cedar Court Apt 102 still available?',
        createdAt: new Date('2026-07-09T10:14:00-07:00'),
      },
      {
        id: 'msg_maya_2',
        conversationId: conversationMaya.id,
        role: 'assistant',
        content: 'Yes. Apt 102 is available for July 15. Your budget fits the listed rent.',
        createdAt: new Date('2026-07-09T10:14:20-07:00'),
      },
      {
        id: 'msg_maya_3',
        conversationId: conversationMaya.id,
        role: 'assistant',
        content: 'I can offer tours tomorrow at 10:30 AM or 3:00 PM. Which works best?',
        createdAt: new Date('2026-07-09T10:15:00-07:00'),
      },
      {
        id: 'msg_maya_4',
        conversationId: conversationMaya.id,
        role: 'user',
        content: 'Tomorrow at 3 works.',
        createdAt: new Date('2026-07-09T10:16:00-07:00'),
      },
      // Noah (collecting_budget)
      {
        id: 'msg_noah_1',
        conversationId: conversationNoah.id,
        role: 'user',
        content: 'Does the penthouse include parking?',
        createdAt: new Date('2026-07-09T11:01:00-07:00'),
      },
      {
        id: 'msg_noah_2',
        conversationId: conversationNoah.id,
        role: 'assistant',
        content: 'One parking stall is included. What monthly budget are you targeting?',
        createdAt: new Date('2026-07-09T11:01:25-07:00'),
      },
      // Aiden (proposing_tour) — full enriched profile example
      {
        id: 'msg_aiden_1',
        conversationId: conversationAiden.id,
        role: 'user',
        content: 'Hi, I am looking for a place in Burnaby for August.',
        createdAt: new Date('2026-07-09T09:40:00-07:00'),
      },
      {
        id: 'msg_aiden_2',
        conversationId: conversationAiden.id,
        role: 'assistant',
        content: 'Happy to help you find a home in Burnaby! What monthly budget should I keep in mind?',
        createdAt: new Date('2026-07-09T09:40:30-07:00'),
      },
      {
        id: 'msg_aiden_3',
        conversationId: conversationAiden.id,
        role: 'user',
        content: 'Around $2,600. 2 occupants and one cat.',
        createdAt: new Date('2026-07-09T09:41:00-07:00'),
      },
      {
        id: 'msg_aiden_4',
        conversationId: conversationAiden.id,
        role: 'assistant',
        content: 'Thanks! Based on your budget and your cat, Loft 301 in Burnaby Heights looks like a great fit ($2,550/month, 1 bed, cats allowed). Would you like to schedule a tour?',
        createdAt: new Date('2026-07-09T09:41:40-07:00'),
      },
      // Sofia (collecting_movein)
      {
        id: 'msg_sofia_1',
        conversationId: conversationSofia.id,
        role: 'user',
        content: 'We are a family of 4 looking for a 3-bedroom in Richmond, pet-friendly.',
        createdAt: new Date('2026-07-09T08:18:00-07:00'),
      },
      {
        id: 'msg_sofia_2',
        conversationId: conversationSofia.id,
        role: 'assistant',
        content: 'Got it. Tower 611 in Richmond Garden Towers is pet-friendly and has 3 bedrooms. When would you like to move in?',
        createdAt: new Date('2026-07-09T08:18:40-07:00'),
      },
      // Jamal (handoff)
      {
        id: 'msg_jamal_1',
        conversationId: conversationJamal.id,
        role: 'user',
        content: 'I have a medium dog. Can I see the lease terms before booking?',
        createdAt: new Date('2026-07-09T14:10:00-07:00'),
      },
      {
        id: 'msg_jamal_2',
        conversationId: conversationJamal.id,
        role: 'assistant',
        content: 'Of course. Lease terms and pet policies can vary, so I will connect you with a human leasing specialist who can share the full details.',
        createdAt: new Date('2026-07-09T14:10:45-07:00'),
      },
      // Ravi (scheduling)
      {
        id: 'msg_ravi_1',
        conversationId: conversationRavi.id,
        role: 'user',
        content: 'Interested in the Burnaby Heights Loft 410. Is September move-in possible?',
        createdAt: new Date('2026-07-09T12:35:00-07:00'),
      },
      {
        id: 'msg_ravi_2',
        conversationId: conversationRavi.id,
        role: 'assistant',
        content: 'Yes, Loft 410 is available from August 15 and works well for a September move-in. I can offer a tour Thursday at 11:00 AM or Friday at 4:00 PM.',
        createdAt: new Date('2026-07-09T12:35:40-07:00'),
      },
    ],
  });

  await prisma.conversationSlot.createMany({
    data: [
      { id: 'slot_maya_budget', conversationId: conversationMaya.id, key: 'budget', value: '2700 CAD' },
      { id: 'slot_maya_movein', conversationId: conversationMaya.id, key: 'move_in_date', value: '2026-07-15' },
      { id: 'slot_maya_occupants', conversationId: conversationMaya.id, key: 'occupants', value: '2' },
      { id: 'slot_noah_area', conversationId: conversationNoah.id, key: 'preferred_area', value: 'Victoria waterfront' },
      // Aiden — full enriched profile, the showcase example.
      { id: 'slot_aiden_budget', conversationId: conversationAiden.id, key: 'budget', value: '2600 CAD' },
      { id: 'slot_aiden_movein', conversationId: conversationAiden.id, key: 'move_in_date', value: 'August' },
      { id: 'slot_aiden_area', conversationId: conversationAiden.id, key: 'preferred_area', value: 'Burnaby' },
      { id: 'slot_aiden_occupants', conversationId: conversationAiden.id, key: 'occupants', value: '2' },
      { id: 'slot_aiden_pets', conversationId: conversationAiden.id, key: 'pets', value: 'cat' },
      { id: 'slot_aiden_rec', conversationId: conversationAiden.id, key: 'recommended_unit_id', value: unitBurnaby301.id },
      { id: 'slot_aiden_reason', conversationId: conversationAiden.id, key: 'match_reason', value: 'fits the $2,600 budget, matches the Burnaby area, supports cat needs' },
      // Sofia
      { id: 'slot_sofia_occupants', conversationId: conversationSofia.id, key: 'occupants', value: '4' },
      { id: 'slot_sofia_pets', conversationId: conversationSofia.id, key: 'pets', value: 'pet-friendly' },
      { id: 'slot_sofia_area', conversationId: conversationSofia.id, key: 'preferred_area', value: 'Richmond' },
      // Jamal
      { id: 'slot_jamal_budget', conversationId: conversationJamal.id, key: 'budget', value: '3000 CAD' },
      { id: 'slot_jamal_area', conversationId: conversationJamal.id, key: 'preferred_area', value: 'North Vancouver' },
      { id: 'slot_jamal_pets', conversationId: conversationJamal.id, key: 'pets', value: 'dog' },
      // Ravi
      { id: 'slot_ravi_budget', conversationId: conversationRavi.id, key: 'budget', value: '2750 CAD' },
      { id: 'slot_ravi_movein', conversationId: conversationRavi.id, key: 'move_in_date', value: 'September' },
      { id: 'slot_ravi_area', conversationId: conversationRavi.id, key: 'preferred_area', value: 'Burnaby' },
    ],
  });

  // ============================================================
  // Showings (7) — linked to leads across statuses.
  // ============================================================
  await prisma.showing.createMany({
    data: [
      {
        id: 'showing_maya',
        tenantId: tenant.id,
        leadId: leadMaya.id,
        unitId: unit102.id,
        showmojoId: 'sm_showing_maya',
        scheduledAt: new Date('2026-07-10T15:00:00-07:00'),
        durationMinutes: 30,
        brokerUserId: broker.id,
        status: 'scheduled',
        showmojoUrl: 'https://showmojo.example/demo/maya',
      },
      {
        id: 'showing_priya',
        tenantId: tenant.id,
        leadId: leadPriya.id,
        unitId: unitKits.id,
        showmojoId: 'sm_showing_priya',
        scheduledAt: new Date('2026-07-11T11:30:00-07:00'),
        durationMinutes: 30,
        brokerUserId: broker.id,
        status: 'confirmed',
        showmojoUrl: 'https://showmojo.example/demo/priya',
      },
      {
        id: 'showing_noah',
        tenantId: tenant.id,
        leadId: leadNoah.id,
        unitId: unitPH.id,
        showmojoId: 'sm_showing_noah',
        scheduledAt: new Date('2026-07-08T16:00:00-07:00'),
        durationMinutes: 45,
        brokerUserId: broker.id,
        status: 'completed',
        showmojoUrl: 'https://showmojo.example/demo/noah',
      },
      {
        id: 'showing_aiden',
        tenantId: tenant.id,
        leadId: leadAiden.id,
        unitId: unitBurnaby301.id,
        scheduledAt: new Date('2026-07-10T11:00:00-07:00'),
        durationMinutes: 30,
        brokerUserId: broker.id,
        status: 'scheduled',
      },
      {
        id: 'showing_ravi',
        tenantId: tenant.id,
        leadId: leadRavi.id,
        unitId: unitBurnaby410.id,
        scheduledAt: new Date('2026-07-11T16:00:00-07:00'),
        durationMinutes: 30,
        brokerUserId: broker.id,
        status: 'scheduled',
      },
      {
        id: 'showing_sofia',
        tenantId: tenant.id,
        leadId: leadSofia.id,
        unitId: unitRichmond611.id,
        scheduledAt: new Date('2026-07-09T10:00:00-07:00'),
        durationMinutes: 30,
        brokerUserId: broker.id,
        status: 'cancelled',
      },
      {
        id: 'showing_marcus',
        tenantId: tenant.id,
        leadId: leadMarcus.id,
        unitId: unitKelowna404.id,
        scheduledAt: new Date('2026-07-12T13:00:00-07:00'),
        durationMinutes: 45,
        brokerUserId: broker.id,
        status: 'confirmed',
      },
    ],
  });

  // ============================================================
  // ConversationEvent (new) — populates Recent activity and
  // Activity history so conversations feel lived-in. Event
  // payloads reference showingId to suppress duplicate derived
  // showing entries in the activity feed.
  // ============================================================
  await prisma.conversationEvent.createMany({
    data: [
      // Maya — staff reply + status change + scheduled tour.
      {
        id: 'event_maya_status',
        tenantId: tenant.id,
        conversationId: conversationMaya.id,
        leadId: leadMaya.id,
        actorUserId: pm.id,
        type: 'lead.status_changed',
        label: 'Lead status changed',
        detail: 'New to tour scheduled',
        tone: 'active',
        payload: { fromStatus: 'new_', toStatus: 'tour_scheduled' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T10:17:00-07:00'),
      },
      {
        id: 'event_maya_showing',
        tenantId: tenant.id,
        conversationId: conversationMaya.id,
        leadId: leadMaya.id,
        actorUserId: pm.id,
        type: 'showing.scheduled',
        label: 'Tour scheduled',
        detail: 'Jul 10, 3:00 PM',
        tone: 'active',
        payload: { showingId: 'showing_maya', scheduledAt: '2026-07-10T15:00:00-07:00' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T10:18:00-07:00'),
      },
      {
        id: 'event_maya_reply',
        tenantId: tenant.id,
        conversationId: conversationMaya.id,
        leadId: leadMaya.id,
        actorUserId: pm.id,
        type: 'staff.reply_sent',
        label: 'Staff replied',
        detail: 'Confirmed the 3:00 PM slot and shared the building entry details.',
        tone: 'neutral',
        payload: { message: 'Confirmed the 3:00 PM slot and shared the building entry details.' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T10:25:00-07:00'),
      },
      {
        id: 'event_maya_note',
        tenantId: tenant.id,
        conversationId: conversationMaya.id,
        leadId: leadMaya.id,
        actorUserId: pm.id,
        type: 'note.internal_added',
        label: 'Internal note added',
        detail: 'Prospect very responsive on WhatsApp. Strong fit for Apt 102.',
        tone: 'neutral',
        payload: { note: 'Prospect very responsive on WhatsApp. Strong fit for Apt 102.' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T10:26:00-07:00'),
      },
      // Aiden — unit recommendation + scheduling + assignment.
      {
        id: 'event_aiden_status',
        tenantId: tenant.id,
        conversationId: conversationAiden.id,
        leadId: leadAiden.id,
        actorUserId: pm.id,
        type: 'lead.status_changed',
        label: 'Lead status changed',
        detail: 'New to tour scheduled',
        tone: 'active',
        payload: { fromStatus: 'new_', toStatus: 'tour_scheduled' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T09:42:00-07:00'),
      },
      {
        id: 'event_aiden_showing',
        tenantId: tenant.id,
        conversationId: conversationAiden.id,
        leadId: leadAiden.id,
        actorUserId: pm.id,
        type: 'showing.scheduled',
        label: 'Tour scheduled',
        detail: 'Jul 10, 11:00 AM',
        tone: 'active',
        payload: { showingId: 'showing_aiden', scheduledAt: '2026-07-10T11:00:00-07:00' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T09:43:00-07:00'),
      },
      {
        id: 'event_aiden_note',
        tenantId: tenant.id,
        conversationId: conversationAiden.id,
        leadId: leadAiden.id,
        actorUserId: pm.id,
        type: 'note.internal_added',
        label: 'Internal note added',
        detail: 'Cat-friendly match. Assigned to Diana for follow-up.',
        tone: 'neutral',
        payload: { note: 'Cat-friendly match. Assigned to Diana for follow-up.' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T09:44:00-07:00'),
      },
      // Jamal — handoff requested.
      {
        id: 'event_jamal_handoff',
        tenantId: tenant.id,
        conversationId: conversationJamal.id,
        leadId: leadJamal.id,
        actorUserId: pm.id,
        type: 'handoff.requested',
        label: 'Human handoff requested',
        detail: 'Prospect asked for full lease and pet policy details.',
        tone: 'attention',
        payload: { reason: 'Prospect asked for full lease and pet policy details.' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T14:11:00-07:00'),
      },
      {
        id: 'event_jamal_note',
        tenantId: tenant.id,
        conversationId: conversationJamal.id,
        leadId: leadJamal.id,
        actorUserId: pm.id,
        type: 'note.internal_added',
        label: 'Internal note added',
        detail: 'Medium dog — verify breed restrictions before sending lease.',
        tone: 'neutral',
        payload: { note: 'Medium dog — verify breed restrictions before sending lease.' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T14:12:00-07:00'),
      },
      // Sofia — cancelled tour + status.
      {
        id: 'event_sofia_cancel',
        tenantId: tenant.id,
        conversationId: conversationSofia.id,
        leadId: leadSofia.id,
        actorUserId: pm.id,
        type: 'showing.cancelled',
        label: 'Tour cancelled',
        detail: 'Jul 9, 10:00 AM',
        tone: 'attention',
        payload: { showingId: 'showing_sofia', scheduledAt: '2026-07-09T10:00:00-07:00' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T09:30:00-07:00'),
      },
      {
        id: 'event_sofia_status',
        tenantId: tenant.id,
        conversationId: conversationSofia.id,
        leadId: leadSofia.id,
        actorUserId: pm.id,
        type: 'lead.status_changed',
        label: 'Lead status changed',
        detail: 'New to contacted',
        tone: 'active',
        payload: { fromStatus: 'new_', toStatus: 'contacted' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T08:20:00-07:00'),
      },
      // Ravi — scheduled + confirmed.
      {
        id: 'event_ravi_scheduled',
        tenantId: tenant.id,
        conversationId: conversationRavi.id,
        leadId: leadRavi.id,
        actorUserId: pm.id,
        type: 'showing.scheduled',
        label: 'Tour scheduled',
        detail: 'Jul 11, 4:00 PM',
        tone: 'active',
        payload: { showingId: 'showing_ravi', scheduledAt: '2026-07-11T16:00:00-07:00' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T12:38:00-07:00'),
      },
      {
        id: 'event_ravi_reply',
        tenantId: tenant.id,
        conversationId: conversationRavi.id,
        leadId: leadRavi.id,
        actorUserId: pm.id,
        type: 'staff.reply_sent',
        label: 'Staff replied',
        detail: 'Booked the Friday 4:00 PM slot. Sending confirmation by SMS.',
        tone: 'neutral',
        payload: { message: 'Booked the Friday 4:00 PM slot. Sending confirmation by SMS.' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T12:41:00-07:00'),
      },
      // Noah — minimal, just a status note.
      {
        id: 'event_noah_note',
        tenantId: tenant.id,
        conversationId: conversationNoah.id,
        leadId: leadNoah.id,
        actorUserId: pm.id,
        type: 'note.internal_added',
        label: 'Internal note added',
        detail: 'Waiting on budget confirmation before proposing the penthouse.',
        tone: 'neutral',
        payload: { note: 'Waiting on budget confirmation before proposing the penthouse.' } as Prisma.InputJsonValue,
        createdAt: new Date('2026-07-09T11:03:00-07:00'),
      },
    ],
  });

  const approval = await prisma.approvalRequest.create({
    data: {
      id: 'approval_bill_lift',
      tenantId: tenant.id,
      action: 'qbo.create_bill',
      proposedPayload: {
        vendorName: 'LiftTech Elevator Services',
        billDate: '2026-07-07',
        totalCents: 184250,
        category: 'maintenance',
      } as Prisma.InputJsonValue,
      confidenceScore: 0.73,
      confidenceReasons: ['vendor matched', 'amount requires review', 'unit allocation missing'],
      status: 'pending',
    },
  });

  await prisma.bill.createMany({
    data: [
      {
        id: 'bill_lifttech_review',
        tenantId: tenant.id,
        vendorName: 'LiftTech Elevator Services',
        billDate: new Date('2026-07-07'),
        dueDate: new Date('2026-07-21'),
        totalCents: 184250,
        currency: 'CAD',
        category: 'maintenance',
        unitId: null,
        ocrConfidence: 0.73,
        sourceDocRef: 'receipts/lifttech-elevator-july.pdf',
        approvalRequestId: approval.id,
        status: 'pending_review',
      },
      {
        id: 'bill_bc_hydro_synced',
        tenantId: tenant.id,
        vendorName: 'BC Hydro',
        billDate: new Date('2026-07-03'),
        dueDate: new Date('2026-07-17'),
        totalCents: 64280,
        currency: 'CAD',
        category: 'utilities',
        unitId: unit101.id,
        ocrConfidence: 0.94,
        sourceDocRef: 'receipts/bc-hydro-cedar-101.pdf',
        qboBillId: 'qbo_bill_demo_1001',
        qboSyncedAt: new Date('2026-07-03T16:20:00-07:00'),
        status: 'synced_to_qbo',
      },
      {
        id: 'bill_cleaning_rejected',
        tenantId: tenant.id,
        vendorName: 'SparkleWest Cleaning',
        billDate: new Date('2026-07-02'),
        dueDate: new Date('2026-07-16'),
        totalCents: 31200,
        currency: 'CAD',
        category: 'repairs',
        unitId: unit102.id,
        ocrConfidence: 0.51,
        sourceDocRef: 'receipts/sparklewest-duplicate.jpg',
        status: 'rejected',
      },
    ],
  });

  const rentDate = new Date('2026-07-01T09:00:00-07:00');
  await prisma.transaction.createMany({
    data: [
      {
        id: 'txn_buildium_sarah',
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'buildium',
        amountCents: 240000,
        reference: 'bldm_pay_001',
        unitId: unit101.id,
        occurredAt: rentDate,
      },
      {
        id: 'txn_bank_sarah',
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'bank',
        amountCents: 240000,
        reference: 'etr_2026_0701_88213',
        unitId: unit101.id,
        occurredAt: rentDate,
      },
      {
        id: 'txn_qbo_sarah',
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'qbo',
        amountCents: 240000,
        reference: 'qbo_je_001',
        unitId: unit101.id,
        occurredAt: rentDate,
      },
      {
        id: 'txn_buildium_cedar_102',
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'buildium',
        amountCents: 265000,
        reference: 'bldm_pay_002',
        unitId: unit102.id,
        occurredAt: rentDate,
      },
      {
        id: 'txn_bank_unmatched',
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'bank',
        amountCents: 185000,
        reference: 'etr_2026_0702_unknown',
        unitId: null,
        occurredAt: new Date('2026-07-02T13:12:00-07:00'),
      },
    ],
  });

  const batch = await prisma.reconciliationBatch.create({
    data: {
      id: 'recon_batch_july_demo',
      tenantId: tenant.id,
      runDate: new Date('2026-07-09T07:00:00-07:00'),
      status: 'partial',
      qboBalanceCents: 240000,
      bankBalanceCents: 425000,
      buildiumBalanceCents: 505000,
      balanced: false,
    },
  });

  await prisma.discrepancy.createMany({
    data: [
      {
        id: 'disc_missing_qbo_cedar_102',
        tenantId: tenant.id,
        reconciliationBatchId: batch.id,
        kind: 'missing_in_qbo',
        entryReference: 'bldm_pay_002',
        entryAmountCents: 265000,
        relatedReferences: [],
        resolved: false,
      },
      {
        id: 'disc_missing_buildium_unknown',
        tenantId: tenant.id,
        reconciliationBatchId: batch.id,
        kind: 'missing_in_buildium',
        entryReference: 'etr_2026_0702_unknown',
        entryAmountCents: 185000,
        relatedReferences: ['bank feed'],
        resolved: false,
      },
      {
        id: 'disc_resolved_hydro',
        tenantId: tenant.id,
        reconciliationBatchId: batch.id,
        kind: 'amount_mismatch',
        entryReference: 'qbo_bill_demo_1001',
        entryAmountCents: 64280,
        relatedReferences: ['bc_hydro_statement_2026_07'],
        resolved: true,
        resolvedByUserId: bookkeeper.id,
        resolvedAt: new Date('2026-07-09T12:15:00-07:00'),
      },
    ],
  });

  await addAudit({
    tenantId: tenant.id,
    actorId: 'showmojo_webhook',
    actorType: 'system',
    action: 'lead.created',
    entityType: 'lead',
    entityId: leadMaya.id,
    payload: { source: 'whatsapp', unitId: unit102.id },
    occurredAt: '2026-07-09T10:16:05.000-07:00',
  });
  await addAudit({
    tenantId: tenant.id,
    actorId: 'sentinel_ai',
    actorType: 'ai_agent',
    action: 'payment.review_required',
    entityType: 'transaction',
    entityId: 'txn_bank_unmatched',
    payload: {
      amountCents: 185000,
      decision: 'review',
      score: 0.62,
      reasons: ['sender not matched', 'no lease for amount', 'bank feed only'],
    },
    occurredAt: '2026-07-09T11:28:00.000-07:00',
  });
  await addAudit({
    tenantId: tenant.id,
    actorId: bookkeeper.id,
    actorType: 'user',
    action: 'bill.processed',
    entityType: 'bill',
    entityId: 'bill_lifttech_review',
    payload: { vendorName: 'LiftTech Elevator Services', decision: 'review', score: 0.73 },
    occurredAt: '2026-07-09T12:06:00.000-07:00',
  });
  await addAudit({
    tenantId: tenant.id,
    actorId: 'system_reconciliation',
    actorType: 'system',
    action: 'reconciliation.run',
    entityType: 'reconciliation_batch',
    entityId: batch.id,
    payload: { balanced: false, discrepancyCount: 3, reconciledCount: 1 },
    occurredAt: '2026-07-09T12:20:00.000-07:00',
  });
  await addAudit({
    tenantId: tenant.id,
    actorId: broker.id,
    actorType: 'user',
    action: 'showing.confirmed',
    entityType: 'showing',
    entityId: 'showing_priya',
    payload: { leadId: leadPriya.id, unitId: unitKits.id },
    occurredAt: '2026-07-09T13:10:00.000-07:00',
  });
  await addAudit({
    tenantId: tenant.id,
    actorId: pm.id,
    actorType: 'user',
    action: 'photo.enhancement_requested',
    entityType: 'listing_photo',
    entityId: 'photo_harbour_ph_view',
    payload: { enhancementType: 'virtual_staging', status: 'processing' },
    occurredAt: '2026-07-09T14:02:00.000-07:00',
  });

  console.log('Demo seed complete.');
  console.log('Login demo:');
  console.log('  Property Manager: pm@pacificridge.ca');
  console.log('  Bookkeeper:       books@pacificridge.ca');
  console.log('  Broker:           broker@pacificridge.ca');
  console.log(`  Password:         ${DEMO_PASSWORD}`);
}

async function addAudit(input: {
  tenantId: string;
  actorId: string;
  actorType: AuditActorType;
  action: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}) {
  const last = await prisma.auditEntry.findFirst({
    where: { tenantId: input.tenantId },
    orderBy: { createdAt: 'desc' },
    select: { hash: true },
  });

  const occurredAt = new Date(input.occurredAt).toISOString();
  const entry = buildAuditEntry({ ...input, occurredAt }, last?.hash);

  await prisma.auditEntry.create({
    data: {
      tenantId: entry.tenantId,
      actorId: entry.actorId,
      actorType: entry.actorType,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      payload: entry.payload as Prisma.InputJsonValue,
      occurredAt: new Date(entry.occurredAt),
      createdAt: new Date(entry.occurredAt),
      previousHash: entry.previousHash,
      hash: entry.hash,
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
