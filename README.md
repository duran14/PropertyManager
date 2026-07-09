# 🏠 Property Manager — Financial Integrity Bridge

SaaS multi-tenant de Property Management para **British Columbia, Canadá**.
Puente automatizado entre Buildium (gestión operativa) y QuickBooks Online
(contabilidad) con IA, diseñado para reducir la conciliación contable de
~20 horas a ~2 horas mensuales.

## Estado del MVP

| Módulo | Descripción | Estado |
|---|---|---|
| **A — Prospección** | URLs por unidad, chatbot WhatsApp/SMS (GLM), ShowMojo, captura de leads | ✅ |
| **B — Financial Sentinel** | Procesamiento de e-Transfers, matching, job diario (BullMQ) | ✅ |
| **C — Puente Contable** | OCR de recibos → Bills → QBO, reconciliación Trust↔Operating, HITL | ✅ |
| **D — Auditoría** | Audit trail inmutable (hash chaining), borradores RTA-BC, dashboard | ✅ |

## Stack técnico

- **Monorepo**: pnpm workspaces (apps + packages)
- **Frontend**: React 18 + Vite + TypeScript + Tailwind + TanStack Query + lucide-react
- **Backend**: Node.js + Express + TypeScript
- **Base de datos**: PostgreSQL 17 + Prisma ORM
- **Colas/Eventos**: Redis 7 + BullMQ
- **IA**: GLM-5.2 (razonamiento) + GLM-OCR (recibos) vía Z.ai
- **Multi-tenant**: aislamiento por `tenantId` + RBAC (3 roles)

## Estructura del repositorio

```
property-manager/
├── apps/
│   ├── api/                 # Backend Express + Prisma + BullMQ
│   └── web/                 # Frontend React + Vite
├── packages/
│   ├── core/                # Lógica de dominio (money, confidence, audit, reconciliation)
│   ├── adapters/            # Contracts e implementaciones mock/reales
│   └── config/              # Env schema (Zod), ESLint compartido
├── docs/
│   ├── COMPLIANCE.md        # PIPEDA, FINTRAC, RESA-BC
│   └── adr/                 # Architecture Decision Records
└── docker-compose.yml       # Postgres + Redis local
```

## Puesta en marcha (desarrollo)

### Prerequisitos
- Node.js 20+
- Docker (para Postgres y Redis)

### Instalación

```bash
# Clonar e instalar dependencias
pnpm install

# Copiar variables de entorno y rellenar secretos
cp .env.example .env
# Generar secretos: node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"

# Levantar Postgres + Redis
pnpm db:up

# Aplicar migración y seed (datos de demo de BC)
pnpm db:migrate
pnpm db:seed
```

### Ejecutar

```bash
# Dos terminales:
pnpm --filter @property-manager/api dev    # API en :4000
pnpm --filter @property-manager/web dev    # Web en :5173
```

Abrir http://localhost:5173

### Cuentas de demo

| Rol | Email | Password |
|---|---|---|
| Property Manager | `pm@pacificridge.ca` | `Password123!` |
| Bookkeeper | `books@pacificridge.ca` | `Password123!` |
| Broker | `broker@pacificridge.ca` | `Password123!` |

## Integraciones

Todas las integraciones están detrás de **adapters** (ports & adapters). Sin
credenciales configuradas, caen automáticamente a modo **mock** con datos
realistas de BC. Para conectar APIs reales, añadir credenciales al `.env`:

| Integración | Variables de entorno |
|---|---|
| Buildium | `BUILDIUM_CLIENT_ID`, `BUILDIUM_CLIENT_SECRET` |
| QuickBooks Online | `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` |
| Twilio (WhatsApp/SMS) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` |
| Plaid (saldos bancarios) | `PLAID_CLIENT_ID`, `PLAID_SECRET` |
| GLM (Z.ai) | `ZAI_API_KEY` |

## Reglas de gobierno

1. **Regla de Oro**: el sistema nunca es custodio de fondos; solo gestor de instrucciones.
2. **Human-in-the-Loop**: toda acción contable con confianza < umbral requiere aprobación humana.
3. **Audit Trail inmutable**: append-only con hash chaining (tamper-evident).
4. **Cumplimiento RTA-BC**: los contratos generados son borradores no vinculantes hasta firma del Broker.

Ver [docs/COMPLIANCE.md](./docs/COMPLIANCE.md) para el detalle legal.

## Testing

```bash
pnpm test          # todos los tests
pnpm --filter @property-manager/core test   # lógica de dominio
```

## Próximos pasos (post-MVP)

- RLS (Row-Level Security) policies en Postgres
- Adapters reales para Buildium, QBO, Twilio, Plaid
- Data residency en ca-central-1 (PIPEDA)
- Portal de inquilinos y propietarios
- Escalar a otras provincias (excluyendo Quebec)

## Licencia

UNLICENSED — Propietario.
