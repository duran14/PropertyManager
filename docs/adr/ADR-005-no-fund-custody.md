# ADR-005: Regla de Oro — nunca custodio de fondos

**Estado**: Aceptado
**Fecha**: 2026-07-08

## Contexto

El sistema gestiona propiedades en BC donde se mueven fondos entre cuentas Trust
(depósitos de seguridad) y Operating (operaciones). La tentación natural es que
el sistema ejecute transferencias automáticamente.

## Decisión

El sistema **NUNCA** es custodio de fondos. Es exclusivamente un **gestor de
instrucciones**:
- Marca leases como pagados en Buildium (registro contable, no movimiento de dinero).
- Crea Bills en QBO (instrucción contable).
- Genera borradores de Journal Entries.
- Stripe Connect existe como contract pero NO se usa activamente en el MVP.

## Consecuencias

**Positivas:**
- Reducción drástica del riesgo regulatorio (no somos una institución financiera).
- Menor superficie de ataque (un breach no expone fondos).
- Simplicidad: no necesitamos licencias de procesamiento de pagos.

**Negativas:**
- Los Property Managers aún deben mover dinero manualmente (en el MVP).
- Stripe Connect queda preparado para una fase futura con custodia opt-in.

## Implementación

- `StripeAdapter` está definido pero sin uso activo.
- Ningún endpoint transfiere fondos.
- El Financial Sentinel solo actualiza estados (Buildium mark_paid, QBO create_bill).
