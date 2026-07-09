# Cumplimiento Legal — Property Manager (MVP)

> ⚠️ **AVISO IMPORTANTE**: Este documento es una guía técnica de implementación,
> NO asesoría legal. Los Property Managers deben consultar a un abogado colegiado
> en British Columbia antes de operar el sistema en producción.

## Marco regulatorio aplicable

El sistema opera en **British Columbia, Canadá** y está sujeto a tres marcos:

### 1. PIPEDA (Personal Information Protection and Electronic Documents Act)

Ley federal canadiense de protección de datos personales.

**Requisitos implementados:**
- **Consentimiento**: los leads deben aceptar el procesamiento de sus datos
  (formulario de contacto y chatbot deben incluir checkbox/aviso de consentimiento).
- **Cifrado en reposo**: las credenciales de integración se cifran con AES-256-GCM
  (`apps/api/src/config/crypto.ts`).
- **Cifrado en tránsito**: HTTPS obligatorio en producción (Helmet + TLS).
- **Minimización**: solo se capturan los datos necesarios (nombre, contacto, mensaje).
- **Retención**: los leads tienen `createdAt` para aplicar políticas de retención.
- **Acceso**: RBAC limita qué roles ven qué datos (los inquilinos no ven datos
  de otros inquilinos).

**Pendiente (pre-producción):**
- [ ] Política de privacidad pública en la URL de cada unidad.
- [ ] Data residency: alojar la BD en una región canadiense (AWS ca-central-1).
- [ ] Procedimiento de eliminación de datos a solicitud del titular (PIPEDA s. 8).
- [ ] Registro de breach notification (PIPEDA s. 10.1).

### 2. FINTRAC (Financial Transactions and Reports Analysis Centre of Canada)

Ley anti-lavado de dinero. Los Property Managers son "reporting entities" cuando
reciben $\geq$ $10,000 CAD en efectivo.

**Requisitos implementados:**
- **Captura de ID**: el modelo `TenantRecord.idVerificationRef` guarda la referencia
  al documento de identificación del inquilino.
- **Validación humana**: el sistema **NUNCA** valida la identidad automáticamente.
  La validación la realiza un humano (staff del PM) — el sistema solo captura.
- **Audit trail**: toda transacción queda en el registro inmutable (hash chaining).

**Pendiente (pre-producción):**
- [ ] Workflow de identificación de cliente (KYC) completo.
- [ ] Reporte de transacciones sospechosas (LCTR/STR) — fuera del MVP.
- [ ] Política de "know your client" documentada.

### 3. RESA-BC (Real Estate Services Act de British Columbia)

Regula la prestación de servicios inmobiliarios. El Property Manager debe tener
licencia de Managing Broker activa.

**Requisitos implementados:**
- **Rol de Broker**: el sistema distingue `broker` (Managing Broker) con permisos
  especiales (firmar contratos RTA, aprobar movimientos contables).
- **Borradores RTA**: el sistema genera **BORRADORES** de contrato conforme a la
  Residential Tenancy Act, pero **NO son vinculantes** hasta firma del Broker.
  Esto evita incurrir en práctica legal no autorizada.
- **Audit trail**: registro de quién hizo qué y cuándo (trazabilidad para auditoría
  del BC Financial Services Authority).

**Pendiente (pre-producción):**
- [ ] Validación de número de licencia del Broker al configurar el tenant.
- [ ] Términos de servicio que establezcan que el PM es responsable del cumplimiento.
- [ ] Cláusulas estándar RTA completas (no solo los campos del borrador).

## Regla de Oro (Gobernanza)

> **El sistema NUNCA es custodio de fondos. Solo es un gestor de instrucciones.**

Esto significa:
- El sistema **no** ejecuta movimientos de dinero directamente.
- Stripe Connect (si se activa) queda fuera del alcance del MVP.
- El Financial Sentinel **marca** leases como pagados en Buildium y **crea** Bills
  en QBO, pero no transfiere dinero.
- Las cuentas Trust y Operating se reconcilian, no se operan.

## Riesgos documentados (sin asesor legal)

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Generar contratos que constituyan práctica legal | Media | Alto | Solo borradores; firma del Broker obligatoria |
| Lavado de dinero no detectado | Baja | Crítico | FINTRAC: captura ID + validación humana |
| Brecha de datos personales (PIPEDA) | Baja | Alto | Cifrado AES-256 + TLS + RBAC |
| Error de conciliación contable | Media | Medio | HITL con umbral de confianza configurable |
| Pérdida de audit trail | Baja | Alto | Hash chaining + backup de BD |

## Próximos pasos legales (recomendados)

1. Contratar un abogado especializado en derecho inmobiliario de BC.
2. Revisar los borradores RTA contra los formularios oficiales del gobierno de BC.
3. Registrar la política de privacidad ante el Privacy Commissioner of Canada.
4. Definir el seguro de responsabilidad profesional (E&O insurance).
