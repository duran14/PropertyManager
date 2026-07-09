# ADR-004: Confidence scoring con veto multiplicativo

**Estado**: Aceptado
**Fecha**: 2026-07-08

## Contexto

El Financial Sentinel decide si auto-aprobar acciones contables (sin humano) o
enviarlas a revisión (HITL). El primer diseño usaba un score puramente aditivo:
cada factor (monto, fecha, remitente) aportaba su peso. El problema: si todos los
factores verificables estaban en 1, el score siempre superaba 0.95 incluso si el
OCR tenía confianza baja. El sistema auto-aprobaba facturas mal extraídas.

## Decisión

El `customWeight` (confianza del OCR/GLM) actúa como **techo multiplicativo**:
si el modelo dice estar 50% seguro, el score final no puede superar 0.5 sin
importar que el monto coincida.

```
score = min(scoreAditivo, customWeight)
```

## Consecuencias

**Positivas:**
- La IA no puede auto-aprobar si no está segura de su propia extracción.
- Favorece HITL (conservador) — correcto para contabilidad.
- Transparente: el bookkeeper ve por qué se pidió revisión (`reasons`).

**Negativas:**
- Más trabajo manual para el bookkeeper (más revisiones HITL).
- El umbral (0.85) puede calibrarse por tenant si resulta demasiado conservador.
