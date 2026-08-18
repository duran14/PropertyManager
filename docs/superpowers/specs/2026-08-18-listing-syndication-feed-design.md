# Feed de sindicación de listados (Fase 4.1) — Diseño

## 1. Qué se construye y qué NO

**Se construye:** un feed público de listados por tenant, en el formato de
catálogo de bienes raíces de Meta, que cualquier portal de sindicación puede
consumir por URL.

**NO se construye — y es importante entender por qué:** publicar gratis en
Facebook Marketplace. El roadmap (Fase 4.1) mezcla dos productos distintos de
Meta:

- **Marketplace rentals** (lo que hoy la empresa de Jorge publica a mano)
  requiere el **Marketplace Partner Program**, un programa de aprobación
  restringida. No es self-serve y no hay API pública. Ninguna cantidad de
  código lo desbloquea.
- **El catálogo de bienes raíces** (`product_catalog/home_listings` de la
  Marketing API) sí es accesible, pero alimenta **anuncios pagados**
  (Advantage+ Catalog Ads), no listados gratuitos.

Este spec entrega el feed, que es el prerequisito común de ambos caminos y
también de RentLinx/ListHub (Fase 4.2): todos consumen un feed por URL. Cuando
exista una cuenta de destino, conectar es apuntar esa cuenta a la URL — sin
reescribir nada.

## 2. El problema de los campos obligatorios

La especificación de `home_listings` exige campos que el modelo de datos actual
no tiene. Mapeo verificado contra la referencia de la Graph API:

| Campo obligatorio | Origen | Estado |
|---|---|---|
| `home_listing_id` | `Unit.id` | ✅ |
| `name` | `Property.name` + `Unit.name` | ✅ |
| `price` | `Unit.rentCents / 100` | ✅ |
| `currency` | constante `CAD` | ✅ |
| `availability` | derivado (§4.2) | ✅ |
| `url` | `WEB_URL/listings/{slug}?tenant={id}` | ✅ |
| `images` | `ListingPhoto` | ✅ |
| `address.street_address` / `city` / `region` / `country` | `Property` | ✅ |
| **`year_built`** | — | ❌ **no existe** |
| **`address.latitude`** / **`longitude`** | — | ❌ **no existe** |

Los tres faltantes no son inventables: el año de construcción lo sabe el
property manager, y las coordenadas requieren geocodificar la dirección.

### Decisión: captura manual + omitir incompletos

`Property` gana tres columnas opcionales (`yearBuilt`, `latitude`,
`longitude`), editables desde el formulario de propiedades que ya existe. El
feed **omite** las unidades cuya propiedad no las tenga completas, y la UI
muestra cuántos listados quedaron fuera y qué les falta.

Alternativas descartadas:

- **Geocodificar automáticamente**: agrega una dependencia externa (Nominatim
  tiene política de uso estricta y límites; Google/Mapbox necesitan una API key
  que hoy no existe) a cambio de ahorrar dos campos por propiedad, que se
  capturan una sola vez en la vida de la propiedad. Se puede agregar después
  como autocompletado, sin tocar el feed.
- **Emitir el feed sin esos campos**: Meta rechaza las filas. Un feed que el
  destinatario rechaza no es un entregable, es trabajo que hay que rehacer.

**Por qué omitir en vez de emitir filas incompletas:** un feed parcial pero
válido se ingiere sin errores; uno completo pero inválido falla entero o por
filas, sin que nadie se entere hasta revisar el panel de Meta. Omitir hace el
problema visible del lado correcto — en nuestra UI, donde el PM puede
arreglarlo.

## 3. Arquitectura

Tres piezas con una frontera clara:

```
Unit[] + Property + ListingPhoto[]
        │
        ▼
buildListingFeed()          packages/core (puro, sin I/O)
        │  → { entries: ListingFeedEntry[], skipped: SkippedListing[] }
        ▼
serializeListingFeedCsv()   packages/core (puro)
        │  → string (CSV)
        ▼
GET /public/listing-feed    apps/api (I/O: query + respuesta)
```

La separación entre *construir entradas* y *serializar* no es especulativa: el
spec ya sabe que hay al menos dos consumidores con formatos distintos (Meta
CSV hoy, RentLinx/ListHub en Fase 4.2). Construir las entradas una vez y
serializar por formato evita duplicar la lógica de negocio (qué se omite, cómo
se deriva `availability`) cuando llegue el segundo formato.

## 4. Detalles de diseño

### 4.1 Qué unidades entran

Una unidad entra al feed si cumple **todas**:
- `Unit.isActive === true` (mismo criterio que la vitrina pública ya existente
  en `GET /public/units`).
- Su `Property` tiene `yearBuilt`, `latitude` y `longitude` no nulos.
- Tiene al menos una `ListingPhoto` (Meta exige `images` no vacío).

Cualquier unidad activa que falle los dos últimos criterios va a `skipped` con
la razón, para que la UI la reporte. Una unidad inactiva simplemente no es
candidata y no se reporta como omitida — no está a la venta.

### 4.2 `availability`

Meta espera un valor de un conjunto cerrado. Derivación:
- `available_now` — sin `availableFrom`, o `availableFrom <= hoy`.
- `available_soon` — `availableFrom > hoy`.

No se emite `rented` ni equivalente: una unidad rentada se marca
`isActive = false` y sale del feed por completo, que es el comportamiento que
el roadmap pide en 4.2 ("al marcar una propiedad como RENTED, enviar señal
DELETE/UNPUBLISH"). Sacarla del feed *es* la señal de unpublish en un modelo
pull.

### 4.3 Formato del CSV

Columnas con los nombres de campo de la Graph API, aplanando objetos con
notación de punto (`address.city`) y listas con notación indexada
(`image[0].url`) — la convención documentada de Meta para feeds CSV de
catálogo.

Se emiten hasta **10 imágenes** por listado (`image[0]`..`image[9]`),
ordenadas con la principal primero, igual que hace `GET /public/units`.

> **Pendiente de validar en la primera carga real:** el nombre exacto de las
> columnas aplanadas de `address` no se pudo confirmar contra la documentación
> oficial (las páginas de referencia de home listings no estaban accesibles al
> escribir este spec). Debe verificarse con el validador de feeds de Meta la
> primera vez que se conecte una cuenta real. Mismo criterio que se usó con
> FrontLobby en Fase 2.2, donde los valores exactos de una columna quedaron
> anotados para confirmar en la primera corrida real. El resto del diseño no
> depende de ese detalle: cambiar un nombre de columna es tocar el
> serializador, no la lógica.

### 4.4 La ruta pública

`GET /public/listing-feed?tenant={tenantId}` → `text/csv`.

**Sobre el acceso:** la ruta es pública y sin token, igual que
`GET /public/units?tenant=` que ya existe y expone exactamente los mismos
datos. Agregarle un token sería teatro de seguridad: los listados de renta son
públicos por definición — su propósito es que los vea todo el mundo — y quien
consume el feed (el crawler de Meta) no puede mandar headers personalizados.

Lo que sí aplica: la ruta **solo** expone unidades activas del tenant pedido, y
ningún dato de solicitantes, dueños ni contabilidad. El aislamiento por tenant
se mantiene en la query.

### 4.5 Visibilidad para el PM

En la pantalla de propiedades, un aviso cuando haya listados omitidos: cuántos
son y qué campo les falta, con enlace a la propiedad correspondiente. Sin eso,
la omisión es silenciosa y el PM cree que está sindicando más de lo que
sindica — exactamente el modo de falla que este diseño buscaba evitar.

## 5. Fuera de alcance

- **Geocodificación automática** de `latitude`/`longitude` (§2). Se captura a
  mano; el autocompletado es una mejora posterior que no cambia el feed.
- **Fase 4.2** (RentLinx / ListHub / sincronizador de estado): necesita cuentas
  de terceros que no existen. El feed que entrega este spec es su prerequisito.
- **Conectar la cuenta de Meta**: requiere Business Manager y catálogo creados
  por el usuario. Este spec deja la URL lista para apuntarla.
- **Formato XML/RSS**: se emite solo CSV. Agregar otro formato es un
  serializador nuevo sobre las mismas entradas, cuando haya un consumidor real
  que lo pida.
- **Programación de refresco**: Meta y los portales hacen *pull* según su
  propio calendario. No se construye ningún job de push.
