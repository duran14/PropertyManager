# Fotos ficticias para propiedades de demostración

## Objetivo

Hacer que las recomendaciones del bot de demostración incluyan imágenes, empezando por `Burnaby Heights Lofts — Loft 410`.

## Alcance

- Generar tres imágenes fotorealistas ficticias: fachada, sala/cocina y dormitorio.
- Guardarlas como activos del proyecto, bajo una carpeta pública del frontend.
- Referenciarlas desde el seed mediante registros `ListingPhoto` para `unit_burnaby_410`.
- Mantener las URLs deterministas y locales; en desarrollo, el adaptador de Telegram las descargará desde la web local y las subirá como archivos a Telegram.

## Fuera de alcance

- No usar fotografías reales de inmuebles.
- No añadir imágenes a las demás propiedades en esta iteración.
- No modificar la lógica de selección ni de mensajería del bot.

## Flujo

1. El seed crea la unidad y sus tres `ListingPhoto` con URLs públicas locales.
2. `getAvailableUnits` toma la primera foto como `photoUrl`.
3. Al recomendar la unidad, el bot envía el texto y luego la foto principal por Telegram.
4. Para una ruta local `/demo-listings/...`, el adaptador obtiene el archivo desde `WEB_URL` y llama a `sendPhoto` mediante `multipart/form-data`; para URLs externas conserva el envío de URL existente.

## Validación

- Prueba de seed que confirme las tres fotos asociadas a Loft 410.
- Prueba del plan de entrega que confirme que la recomendación lleva una URL de foto.
- Prueba del adaptador de Telegram que confirme la subida multipart de una ruta local.
- Ejecución del seed y comprobación de que las URLs responden desde la app web.
