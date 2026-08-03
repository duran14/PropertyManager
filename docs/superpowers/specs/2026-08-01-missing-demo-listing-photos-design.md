# Galerías faltantes del feed de demostración

## Objetivo

Garantizar que todas las unidades activas del feed tengan imágenes, completando las cuatro galerías vacías sin reemplazar fotos existentes.

## Alcance

- Generar tres fotos ficticias, fotorealistas y sin marcas para cada unidad: `unit_kelowna_303`, `unit_kits_203`, `unit_northvan_101` y `unit_richmond_502`.
- Guardar los 12 activos en `apps/web/public/demo-listings/`.
- Añadir tres `ListingPhoto` por unidad al seed y cargarlas de forma idempotente en la base de datos demo actual.
- Mantener todas las fotos existentes de Unsplash y las tres fotos de Loft 410 sin cambios.

## Galerías

- Kelowna Lakeside Vista — Lakeside 303: exterior, salón/cocina y dormitorio.
- Kits Point Walkups — Suite 203: exterior, salón/cocina y dormitorio.
- North Van Bluffs Estates — Estates 101: exterior, salón/cocina y dormitorio.
- Richmond Garden Towers — Tower 502: exterior, salón/cocina y dormitorio.

## Flujo

1. El seed registra rutas públicas locales y la primera imagen de cada unidad como principal.
2. El bot toma la foto principal para la recomendación; el adaptador la sube como archivo a Telegram en desarrollo.
3. Las galerías quedan disponibles en las fichas web mediante las mismas rutas locales.

## Validación

- Una prueba de seed verifica exactamente tres registros para cada una de las cuatro unidades.
- Una consulta a la base actual confirma que toda unidad activa tiene al menos tres fotos.
- Las 12 URLs locales responden desde Vite.
