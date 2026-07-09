/**
 * Seed con datos realistas de British Columbia.
 *
 * Crea:
 *  - 1 Tenant (demo PM company en Vancouver)
 *  - 3 usuarios (property_manager, bookkeeper, broker)
 *  - 2 propiedades con unidades
 *  - 1 lease activo con inquilino
 *  - Transacciones de muestra (buildium, bank, qbo) para reconciliación
 *
 * Password de todos: "Password123!" (solo dev).
 */
import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'Password123!';

async function main() {
  console.log('🌱 Iniciando seed con datos de demo de BC...\n');

  // --- Tenant ---
  const tenant = await prisma.tenant.upsert({
    where: { id: 'tenant_demo_pm' },
    update: {},
    create: {
      id: 'tenant_demo_pm',
      name: 'Pacific Ridge Property Management',
      province: 'BC',
    },
  });
  console.log(`  ✓ Tenant: ${tenant.name}`);

  // --- Usuarios (3 roles) ---
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const users = [
    { email: 'pm@pacificridge.ca', firstName: 'Diana', lastName: 'Reyes', role: UserRole.property_manager },
    { email: 'books@pacificridge.ca', firstName: 'Jorge', lastName: 'Liu', role: UserRole.bookkeeper },
    { email: 'broker@pacificridge.ca', firstName: 'Marcus', lastName: 'Beaulieu', role: UserRole.broker },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        passwordHash,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        tenantId: tenant.id,
      },
    });
  }
  console.log(`  ✓ ${users.length} usuarios creados (pm/books/broker)`);

  // --- Propiedades ---
  const cedarCourt = await prisma.property.upsert({
    where: { tenantId_address: { tenantId: tenant.id, address: '1200 Granville St' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'Cedar Court Apartments',
      address: '1200 Granville St',
      city: 'Vancouver',
      province: 'BC',
      postalCode: 'V6Z 1R9',
    },
  });
  const harbourView = await prisma.property.upsert({
    where: { tenantId_address: { tenantId: tenant.id, address: '789 Wharf St' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'Harbour View Suites',
      address: '789 Wharf St',
      city: 'Victoria',
      province: 'BC',
      postalCode: 'V8W 1T3',
    },
  });
  console.log(`  ✓ 2 propiedades: ${cedarCourt.name}, ${harbourView.name}`);

  // --- Unidades ---
  const unit101 = await prisma.unit.create({
    data: {
      tenantId: tenant.id,
      propertyId: cedarCourt.id,
      name: 'Apt 101',
      rentCents: 2_400_00,
      slug: 'cedar-court-apt-101',
    },
  });
  const unit102 = await prisma.unit.create({
    data: {
      tenantId: tenant.id,
      propertyId: cedarCourt.id,
      name: 'Apt 102',
      rentCents: 2_650_00,
      slug: 'cedar-court-apt-102',
    },
  });
  console.log(`  ✓ ${2} unidades en Cedar Court`);

  // --- Inquilino + Lease ---
  const sarah = await prisma.tenantRecord.create({
    data: {
      tenantId: tenant.id,
      firstName: 'Sarah',
      lastName: 'Chen',
      email: 'sarah.chen@example.ca',
      phone: '+16045551234',
    },
  });
  const lease = await prisma.lease.create({
    data: {
      tenantId: tenant.id,
      unitId: unit101.id,
      tenantRecordId: sarah.id,
      startDate: new Date('2026-03-01'),
      endDate: new Date('2027-02-28'),
      rentCents: 2_400_00,
      depositCents: 1_200_00,
      status: 'active',
    },
  });
  console.log(`  ✓ Lease activo: ${sarah.firstName} en ${unit101.name}`);

  // --- Transacciones (3 fuentes corroborando el mismo pago de renta) ---
  const rentDate = new Date('2026-07-01');
  await prisma.transaction.createMany({
    data: [
      {
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'buildium',
        amountCents: 2_400_00,
        reference: 'bldm_pay_001',
        unitId: unit101.id,
        occurredAt: rentDate,
      },
      {
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'bank',
        amountCents: -2_400_00, // salida del banco (depósito en trust)
        reference: 'etr_2026_0701_88213',
        unitId: unit101.id,
        occurredAt: rentDate,
      },
      {
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'qbo',
        amountCents: 2_400_00,
        reference: 'qbo_je_001',
        unitId: unit101.id,
        occurredAt: rentDate,
      },
      // Un pago que solo está en Buildium (debería generar discrepancia)
      {
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'buildium',
        amountCents: 2_650_00,
        reference: 'bldm_pay_002',
        unitId: unit102.id,
        occurredAt: rentDate,
      },
    ],
    skipDuplicates: true,
  });
  console.log(`  ✓ 4 transacciones (3 corroboradas + 1 sin contraparte para demostrar discrepancia)`);

  // --- Owner ---
  await prisma.owner.create({
    data: {
      tenantId: tenant.id,
      firstName: 'Elizabeth',
      lastName: 'Patterson',
      email: 'e.patterson@example.ca',
    },
  });
  console.log(`  ✓ 1 propietario`);

  console.log(`\n  🎉 Seed completo. Login demo:`);
  console.log(`     PM:        pm@pacificridge.ca`);
  console.log(`     Bookkeeper: books@pacificridge.ca`);
  console.log(`     Broker:    broker@pacificridge.ca`);
  console.log(`     Password:  ${DEMO_PASSWORD}\n`);
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
