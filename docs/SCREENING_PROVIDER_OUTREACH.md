# Contacto para acceso de API — FrontLobby y Sterling

Plantillas para pedir documentación de API y, si aplica, credenciales de
sandbox. Rellena los campos entre `[corchetes]` con tus datos reales antes
de enviar — no tengo el nombre de tu negocio ni tu información de contacto,
así que dejé esto como plantilla en vez de inventar algo.

Mándalos por separado; no hay necesidad de mencionar al otro proveedor en
cada correo.

---

## FrontLobby — `support@frontlobby.com`

**Asunto:** API access request — tenant credit screening integration

```
Hello,

I manage [nombre de tu negocio], a property management company based in
[ciudad], BC, currently managing [número] rental units. We're building an
in-house system to handle our leasing workflow, and we'd like to integrate
FrontLobby's tenant credit screening directly into it rather than using
the web portal manually for each applicant.

Could you point me to:

1. API documentation (authentication, endpoints, and the exact applicant
   fields required — name, date of birth, current address, etc.)
2. Whether a sandbox/test environment is available before we go live
3. Pricing for API-based screening requests at our current portfolio size

We're a small operation today, so I understand full enterprise onboarding
may not apply to us yet — happy to start with self-serve API access if
that's available.

Thanks,
[tu nombre]
[tu negocio]
[tu teléfono o correo de contacto]
```

---

## Sterling (Sterling Backcheck / First Advantage) — vía su formulario de contacto en sterlingbackcheck.ca, o el contacto de ventas que te asignen

**Asunto:** API access request — CPIC-based criminal record check integration

```
Hello,

I manage [nombre de tu negocio], a property management company based in
[ciudad], BC. We're building an in-house leasing system and would like to
integrate Sterling's Canadian criminal record check (CPIC-sourced) directly
via API, for use during our tenant application process.

Could someone share:

1. Developer/API documentation — authentication method, request/response
   format, and applicant fields required (name, date of birth, address
   history, etc.)
2. Whether webhooks are available for result delivery, or if polling a
   status endpoint is the expected pattern
3. Whether a sandbox/test environment exists
4. Pricing per check at our volume ([número] units under management)

Thank you,
[tu nombre]
[tu negocio]
[tu teléfono o correo de contacto]
```

---

## Qué hacer con la respuesta

Cuando cualquiera de los dos responda con documentación real:
- Si dan acceso de API → se conecta como el adapter "nivel 1" ya diseñado,
  sin tocar el resto del sistema (job, storage, notificación, UI).
- Si dicen que no, o tardan mucho → seguimos con Playwright como el camino
  real, y el acceso de API queda como mejora futura si algún día lo dan.

No hace falta esperar su respuesta para nada de lo que sigue.
