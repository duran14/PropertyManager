# Fase 3: Trust Accounting & Owner Statements

## Contexto y por qué esto existe

`docs/PRODUCT_ROADMAP.md` marca la Fase 3 como **Urgente** — se elevó desde
"Importante" tras la conversación con Jorge Capote, que la describió como
*"el pollo, arroz con pollo"* del negocio: recibir la renta y pagar los
bills es lo esencial de un property manager, por encima de Messenger o
screening.

El roadmap propone una tabla `property_ledger` con cinco tipos de asiento y
un algoritmo de liquidación mensual. Al explorar el repo antes de diseñar,
se encontraron **tres conflictos materiales** entre ese texto y lo que ya
existe. Este spec los resuelve explícitamente:

1. **El SQL del roadmap viola la convención de dinero del proyecto.**
   Propone columnas `NUMERIC`, pero el encabezado del schema establece:
   *"Dinero: SIEMPRE en centavos enteros (amountCents), nunca float"*.
   `Decimal` no aparece ni una vez en `schema.prisma`.

2. **`property_ledger` sería un sistema paralelo.** Los cinco tipos de
   asiento que propone ya existen como `TransactionType`: `rent_payment`,
   `fee`, `vendor_bill`, y — literalmente — `owner_distribution`. Las
   categorías `repairs`/`utilities`/`management_fee` ya existen en
   `AccountCategory`. El propio roadmap advierte que esto "debe
   reconciliarse con el modelo existente en vez de vivir como un sistema
   paralelo".

3. **Una frase del roadmap chocaría con ADR-005.** El ADR es tajante: el
   sistema *"NUNCA es custodio de fondos. Es exclusivamente un gestor de
   instrucciones"*. La frase del roadmap *"el balance de la subcuenta de la
   propiedad se reinicia en $0.00"* describe una subcuenta con saldo
   propio, es decir, custodia.

Además había un **bloqueador**: el modelo `Owner` estaba huérfano — nombre,
email, teléfono y nada más. Sin `Property.ownerId` no existe "el estado de
cuenta del dueño".

## Decisiones tomadas con el usuario (brainstorming del 2026-08-08)

- **Alcance completo**: vínculo dueño-propiedad + motor de cálculo +
  interfaz. Las piezas no sirven por separado.
- **Derivar, no acumular**: el estado de cuenta se calcula desde los
  `Transaction`/`Bill` existentes. Nada de `property_ledger`.
- **Un dueño por propiedad** (`Property.ownerId`). La copropiedad con
  porcentajes queda fuera; migrar a tabla intermedia después es acotado.
- **Cierre manual por el PM**, no job automático: emitir un estado de
  cuenta es un acto contable con consecuencias, y el patrón HITL ya es la
  regla del proyecto (los Bills también requieren aprobación humana).
- **Fondo de reserva acumulativo**: se retiene hasta alcanzar la meta, y
  luego se deja de retener. Es una retención única acumulativa, no un
  saldo que se repone si se gasta (ver "El cálculo" más abajo — corregido
  el 2026-08-08 tras el hallazgo de revisión final: la descripción
  original decía "si se gasta, se repone", pero eso es inalcanzable con
  el diseño elegido).
- **Gastos a nivel propiedad**: se agrega `Bill.propertyId` para poder
  registrar gastos de edificio (techo, jardinería, seguro) que no
  pertenecen a una unidad.

## Arquitectura general

El estado de cuenta **se calcula, no se acumula**. No existe saldo
persistido en ninguna parte: los números se derivan de lo que el Financial
Sentinel y el Puente Contable ya registran. Esto satisface ADR-005 y evita
el sistema paralelo.

Tres piezas:

1. **Vínculo y configuración** — `Property` gana `ownerId`,
   `managementFeePercentBps` y `reserveFundTargetCents`.
2. **Motor de cálculo** — función pura: recibe los movimientos ya cargados
   y la configuración, devuelve el desglose. Sin I/O, testeable
   exhaustivamente sin base de datos.
3. **Cierre y presentación** — el PM ve el cálculo en vivo (recalculable
   cuantas veces quiera) y al cerrar el mes se guarda una foto inmutable
   (`OwnerStatement`) más un `Transaction` de tipo `owner_distribution`
   como registro de la instrucción de pago.

La distinción clave: antes de cerrar, todo es cálculo en vivo; después de
cerrar, el estado de cuenta es un documento histórico que no cambia aunque
los movimientos subyacentes se editen después.

## El cálculo

```
Ingresos         = Σ Transaction(type: rent_payment) de las unidades de la propiedad, en el periodo
Gastos           = Σ Bill(status: approved | synced_to_qbo) de la propiedad y de sus unidades, en el periodo
Comisión         = Ingresos × (managementFeePercentBps / 10000)
Disponible       = Ingresos − Gastos − Comisión
Faltante reserva = max(0, reserveFundTargetCents − reservaAcumulada)
Reserva retenida = max(0, min(Faltante reserva, Disponible))
Neto             = Disponible − Reserva retenida

Pago al dueño    = max(0, Neto)
Faltante         = max(0, −Neto)
```

`Neto` se parte en dos campos no negativos porque un monto negativo en
`ownerPayoutCents` sería un pago del dueño *hacia* el PM, que es una cosa
distinta y merece su propio campo. En cualquier mes, exactamente uno de los
dos es cero.

`reservaAcumulada` es la suma de `reserveWithheldCents` de TODOS los
`OwnerStatement` ya cerrados de esa propiedad (sin importar el orden en
que se cerraron los meses — no hay filtro por periodo, porque nada obliga
a cerrar los meses en secuencia). No se guarda como columna propia: se
deriva con un `SUM` en cada cálculo.

**Es una retención única acumulativa, no un fondo que se repone.** Una
vez que `reservaAcumulada` alcanza `reserveFundTargetCents`, el cálculo
dejará de retener para siempre, sin importar cuántos meses pasen después
ni si ese dinero se gastó del banco real. La versión anterior de este
spec decía "si se gasta, se repone" — eso describe un saldo de reserva
con estado (sube cuando se retiene, baja cuando se gasta), y este sistema
deliberadamente no tiene esa columna: `reservaAcumulada` se deriva de
`SUM(reserveWithheldCents)` sobre cierres inmutables, un valor que por
construcción solo puede crecer. Implementar la reposición real exigiría
rastrear un saldo de reserva gastable — el saldo persistido que ADR-005
evita — así que el usuario decidió corregir esta descripción en vez de
construir esa reposición. Si el negocio la necesita, queda como trabajo
futuro explícito y tendría que resolver primero cómo registrar "gasto de
la reserva" sin abrir una subcuenta con saldo propio.

### Qué fechas definen el periodo

- **Ingresos**: se filtra por `Transaction.occurredAt` (cuándo ocurrió el
  movimiento), no por `createdAt` — un pago registrado con retraso
  pertenece al mes en que se recibió.
- **Gastos**: se filtra por `Bill.billDate` (la fecha de la factura), no
  por cuándo se subió ni cuándo se aprobó. Un recibo de julio subido en
  agosto es un gasto de julio.

**El periodo es un intervalo semiabierto** `[periodStart, periodEnd)`:
`periodStart` es el primer instante del mes y `periodEnd` el primer
instante del mes siguiente. Se usa `< periodEnd`, nunca `<=`, para que un
movimiento exactamente en el límite no caiga en dos meses.

**Zona horaria: `America/Vancouver`** (el negocio opera en BC, y es la
misma zona que ya usa el job de reconciliación diaria). Los límites del mes
se calculan en esa zona y se guardan en UTC. Esto importa: un pago del 31
de julio a las 8pm hora de Vancouver es el 1 de agosto en UTC — calcularlo
en UTC lo pondría en el mes equivocado.

**Exactitud al centavo.** El objetivo del roadmap es liquidación exacta en
$0.00. `Money.multiply` usa `Math.round`, así que la comisión sola no
garantiza que las partes sumen exacto. Por eso **el pago al dueño se
calcula por resta, no por otro redondeo**: la invariante
`Ingresos − Gastos − Comisión − Reserva = Pago` se cumple al centavo por
construcción, no por suerte de redondeo.

**Mes negativo.** Si `Disponible < 0` (gastos mayores al ingreso: techo
reparado, unidad vacía), el estado de cuenta se emite igual con
`ownerPayoutCents: 0` y el faltante en `shortfallCents`. No se retiene
reserva ese mes.

## Modelo de datos

### `Property` — tres campos nuevos

```prisma
ownerId                 String?
managementFeePercentBps Int     @default(1250)  // 12.5% en basis points
reserveFundTargetCents  Int     @default(0)     // 0 = sin fondo de reserva
owner                   Owner?  @relation(fields: [ownerId], references: [id])
```

La comisión va en **basis points enteros** (1250 = 12.5%), no decimal: es
la única forma de respetar la regla de "nunca float" y de que el porcentaje
sea exacto. `NUMERIC`/`Float` habría metido error de coma flotante justo
donde el objetivo es cuadrar al centavo.

`Owner` gana la back-relation `properties Property[]`.

### `Bill` — un campo nuevo

```prisma
propertyId String?
property   Property? @relation(fields: [propertyId], references: [id])
```

Los gastos de unidad siguen resolviéndose a su propiedad vía
`Unit.propertyId`; los de edificio se registran directo contra la
propiedad. (Nota: `Bill.unitId` hoy es un escalar sin relación declarada;
este spec no lo cambia — solo agrega `propertyId` con relación real.)

### `OwnerStatement` — modelo nuevo

```prisma
model OwnerStatement {
  id         String   @id @default(cuid())
  tenantId   String
  propertyId String
  ownerId    String

  periodStart DateTime  // primer instante del mes (America/Vancouver, guardado en UTC)
  periodEnd   DateTime  // primer instante del mes SIGUIENTE — límite exclusivo

  rentIncomeCents      Int
  expensesCents        Int
  managementFeeCents   Int
  reserveWithheldCents Int
  ownerPayoutCents     Int  // 0 si el mes cerró negativo
  shortfallCents       Int  // 0 salvo mes negativo

  // Copia de la configuración vigente al cerrar: si mañana cambia la
  // comisión de la propiedad, este documento histórico no debe cambiar.
  appliedFeePercentBps Int
  reserveTargetCents   Int

  closedByUserId String
  closedAt       DateTime @default(now())
  createdAt      DateTime @default(now())

  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  // Restrict, no Cascade: un estado de cuenta es un documento financiero
  // ya liquidado a un dueño. Borrar la propiedad no debe destruirlo en
  // silencio — que falle y obligue a decidir qué hacer con el historial.
  property Property @relation(fields: [propertyId], references: [id], onDelete: Restrict)
  owner    Owner    @relation(fields: [ownerId], references: [id])

  @@unique([propertyId, periodStart])
  @@index([tenantId, periodStart])
  @@map("owner_statements")
}
```

Sin campo `status`: si la fila existe, el mes está cerrado. La `@@unique`
hace que cerrar dos veces el mismo mes sea imposible **a nivel base de
datos**, no solo por lógica de aplicación — cubre el caso de dos peticiones
concurrentes.

## ADR-005 — dónde está la línea

**Lo que este diseño sí hace:** calcular, emitir un documento, y registrar
un `Transaction` de tipo `owner_distribution` (que ya existe en el enum)
como instrucción de pago.

**Lo que deliberadamente no hace:** ningún endpoint transfiere dinero, no
hay saldo de subcuenta que el sistema guarde y vacíe, y no se toca Stripe.
El "reinicio a $0.00" del roadmap se logra por construcción — no hay
balance persistido que reiniciar, porque cada estado de cuenta es el corte
de un periodo cerrado y el siguiente arranca del periodo siguiente.

Esto queda escrito como comentario en el servicio: el pago al dueño lo
ejecuta un humano fuera del sistema; aquí solo se registra qué se debe
pagar y por qué.

**ADR-004** (confidence veto) no aplica a este cálculo: no hay inferencia
de IA en el camino. Los `Transaction` y `Bill` que se suman ya pasaron por
sus propias compuertas HITL antes de llegar aquí — de hecho, por eso el
cálculo excluye los Bills no aprobados (ver casos límite).

## Rutas

| Ruta | Auth | Qué hace |
|---|---|---|
| `GET /properties/:id/statement-preview?period=YYYY-MM` | Sí | Calcula el desglose en vivo, sin persistir nada |
| `POST /properties/:id/statements` | Sí (`property_manager`) | Cierra el mes: valida, persiste el `OwnerStatement` y el `Transaction` de distribución |
| `GET /properties/:id/statements` | Sí | Lista los estados de cuenta cerrados de la propiedad |

Siguiendo la convención ya establecida en Fase 2A: los errores esperados se
devuelven como **resultado discriminado** (`{ ok: false, status, error }`)
y la ruta los mapea — el error handler global de `app.ts` convierte
cualquier `throw` en 500, así que lanzar haría imposibles los 409/404.

## Manejo de errores y casos límite

| Caso | Comportamiento |
|---|---|
| Propiedad sin dueño asignado | No se puede cerrar; 409 explicando que falta asignar dueño |
| Mes ya cerrado | 409; la `@@unique` lo garantiza incluso ante peticiones concurrentes |
| Mes sin movimientos | Se puede cerrar igual, todo en cero — deja constancia de que el mes se revisó |
| Balance negativo | Se emite con `ownerPayoutCents: 0` y el faltante en `shortfallCents`; sin retener reserva |
| Bills no aprobados | Se excluyen: solo cuentan `approved` y `synced_to_qbo`. Un gasto pendiente de revisión humana no puede afectar lo que se le paga al dueño |
| Reserva ya alcanzada | No se retiene nada más ese mes |
| Cambia la comisión tras cerrar | El estado de cuenta guardado no cambia (por eso se copia la configuración aplicada) |
| Periodo con formato inválido | 400 |
| Propiedad de otro tenant | 404, sin distinguir de inexistente |
| Cerrar un mes que aún no termina | 409 — no se puede cerrar un periodo en curso; solo meses ya concluidos |

## Plan de pruebas

**Motor de cálculo (función pura, sin base de datos):**
- Comisión con montos que caen en medio centavo.
- Reserva en sus estados: acumulando, ya alcanzada, y el caso general de
  retener solo el faltante hasta la meta dado un `reserveAlreadyWithheldCents`
  parcial (la función pura no distingue por qué ese valor es parcial —
  en producción solo puede serlo porque la meta aún no se alcanzó, nunca
  porque la reserva se gastó y hay que reponerla).
- Mes negativo, mes en cero.
- **La invariante central**: las partes siempre suman exacto al ingreso, en
  todos los casos anteriores.

**Integración (Prisma real, mismo patrón del resto del repo):**
- Solo entran movimientos de esa propiedad y ese periodo (no se cuelan de
  otra propiedad, otro tenant, ni otro mes).
- Los Bills no aprobados se excluyen.
- Gastos de unidad y de propiedad se suman ambos.
- El cierre es idempotente: el segundo intento da 409 sin crear una
  segunda fila.
- Un estado de cuenta cerrado no cambia al editar movimientos posteriores.
- `reservaAcumulada` se calcula sobre los cierres previos.

**Frontend:** sin tests unitarios (el repo no tiene para el frontend);
verificación por typecheck y revisión manual.

## Fuera de alcance (explícitamente)

- **Ejecutar el pago al dueño.** Prohibido por ADR-005. Solo se registra la
  instrucción.
- **Copropiedad con porcentajes.** Un dueño por propiedad en esta fase.
- **Portal del dueño.** El `ExternalUserType = ['tenant','owner']` existe en
  el core pero sin usarse; darle acceso al dueño es otra fase.
- **Exportar el estado de cuenta a PDF.** Se muestra en pantalla; la
  generación de PDF queda para después.
- **Enviar el estado de cuenta por email al dueño.** Fuera de alcance aquí.
- **Asientos contables (Journal Entries) a QuickBooks.** ADR-005 los
  permite como borrador, pero no se construyen en esta fase.
- **Reconciliar el estado de cuenta contra el `ReconciliationBatch`
  existente.** Son mecanismos distintos: la reconciliación corrobora el
  mismo evento entre sistemas; el estado de cuenta agrega por propiedad.
  Cruzarlos es trabajo futuro.
