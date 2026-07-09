Documento de Especificaciones Técnicas: "Financial Integrity Bridge" (MVP)1. Visión General

El objetivo es construir un sistema de gestión inmobiliaria para el mercado de British Columbia (BC) que no solo gestione leads, sino que actúe como un **puente automatizado entre la gestión operativa (Buildium) y la gestión contable (QuickBooks Online)**. El sistema debe reducir el tiempo de conciliación contable del bookkeeper de 20 horas a 2 horas mensuales mediante automatización con IA.2. Alcance Funcional (Módulos del MVP)Módulo A: Prospección y Conversión (Front-End)

* **Omnicanalidad:** Chatbot autónomo (WhatsApp/SMS) integrado vía Twilio.  
* **URLs por Unidad:** Cada propiedad debe generar dinámicamente una URL independiente para SEO y contexto inmediato de la IA.  
* **ShowMojo Integration:** Registro automático de visitas y leads mediante webhooks.

Módulo B: Motor de Automatización Inteligente (Backend)

* **Agente de Conciliación:** Lectura automática de e-Transfers bancarios (monitoreo de correos electrónicos bancarios).  
* **Confidence Scoring:** Motor de decisión para aprobar automáticamente pagos de alta certeza o requerir revisión humana (Handoff).

Módulo C: El Puente Contable (La pieza clave de Jorge)

* **QuickBooks Online (QBO) Integration:** Sincronización automática de facturas (*Bills*) desde Buildium hacia QBO.  
* **OCR de Recibos:** Agente capaz de leer facturas de proveedores (PDF/Imagen), extraer fecha, monto, proveedor y proponer la cuenta contable (e.g., *Repairs, Utilities, Maintenance*).  
* **Trust/Operating Reconciliation:** Log automatizado para auditoría de BC, garantizando que el reembolso de la cuenta *Operating* hacia la *Trust* esté respaldado por un documento legal (*Bill*).

Módulo D: Auditoría y Cumplimiento (BC Standards)

* **Dashboard de Discrepancias:** Interfaz para el Bookkeeper que compara Buildium vs. QBO y detecta "agujeros" (ej. pagos no registrados o transferencias sin respaldo).  
* **Audit Trail:** Registro inmutable de toda acción tomada por la IA en el movimiento de fondos.

3\. Especificaciones Técnicas y StackFlujo lógico de datos (The Bridge)

1. **Ingesta:** Recibo de correo (aviso de depósito bancario) \+ Webhook de Buildium.  
2. **Procesamiento:** El *Financial Sentinel* (Agente IA) compara el monto y el remitente.  
3. **Acción:**  
   * Si es Renta: Marca como pagado en Buildium y notifica al Broker.  
   * Si es Factura de Proveedor: Lee el recibo (OCR), clasifica la cuenta y crea el *Bill* en QBO.  
4. **Conciliación:** El sistema verifica diariamente: Balance en QBO \== Balance en Cuenta Bancaria \== Registro en Buildium.

Requerimientos de Integración

* **Pagos/Lectura:** Plaid (lectura de saldos), Stripe Connect (ejecución de pagos/reembolsos).  
* **Contabilidad:** QuickBooks Online API (Sincronización de *Bills* y *Journal Entries*).  
* **IA:** Gemini 3.5 Flash (Antigravity 2.0 harness) para el razonamiento de alta velocidad y bajo costo.

4\. Gobernanza y Seguridad (Reglas para el Equipo de Desarrollo)

* **Regla de Oro:** El sistema **nunca** debe ser custodio de fondos; solo debe ser un **gestor de instrucciones**.  
* **Human-in-the-loop (HITL):** Todo movimiento contable automático (e.g., transferencia Trust $\\to$ Operating) debe tener una configuración de "Umbral de Confianza". Si la IA no está 100% segura, debe requerir aprobación manual del Bookkeeper.  
* **Cumplimiento RTA (BC):** El sistema debe generar contratos basados estrictamente en los formatos legales de la Residential Tenancy Act de BC.

5\. Instrucciones para la Implementación (vía Antigravity / Claude Code)

Para el equipo técnico que implementará esto usando **Claude Fable 5 / Ultra Code**:

1. **Prioridad 0:** Configurar el *Financial Sentinel* para que realice el "matching" diario entre los movimientos de la cuenta *Operating* y las transacciones de Buildium.  
2. **Arquitectura:** Utilizar un modelo de *Event-Driven Architecture* para que los webhooks de Twilio y los avisos bancarios disparen los agentes de IA de forma inmediata.  
3. **Despliegue:** Iniciar con el modo *Mock* (simulación de datos) para validar la lógica contable antes de conectar APIs reales de bancos.

