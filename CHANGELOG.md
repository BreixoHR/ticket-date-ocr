# Historial de versiones

## 2.0.0 · 2026-10-05: reescritura para publicación
- Módulos separados y testeables: extractor de fechas, resiliencia, PDF y proveedor de OCR.
- Asociación etiqueta → fecha en lugar de la heurística por distancia (corrige el caso "fecha de compra" en la línea anterior a "fecha de visita").
- API key obligatoria, logs sin el texto de las entradas, servicio escuchando solo en localhost detrás de TLS.
- Salesforce: Queueable con Named Credential en lugar de `@future` con el PDF como parámetro.
- 34 tests.

## Migración de infraestructura · 2026-10-02
- El servicio se traslada a una nueva máquina virtual (OCI-DOC-002).

## Integración en Salesforce · 2026-05-06 → 2026-05-19
| Fecha | Cambio |
|---|---|
| 2026-05-06 → 05-08 | Primera conexión desde Salesforce. Ajustes de estados y de la IP del servicio |
| 2026-05-11 | Timeout ampliado e identificador de reserva en la petición |
| 2026-05-13 | *PDF Files Updater* V1–V3: lectura del PDF adjunto y comprobación de la fecha |
| 2026-05-14 | Escritura de la fecha detectada en la reserva (con *rollback* a un estado estable y nueva escritura) |
| 2026-05-14 → 05-19 | Rangos de fechas (pases de varios días) y cuatro correcciones de rango |

## Servicio OCR · 2026-04-27 → 2026-05-14
| Versión | Fecha | Hito |
|---|---|---|
| V1 | 2026-04-27 | Prototipo local con OCI Document Understanding |
| V2 | 2026-04-29 | Servidor HTTP para llamarlo desde Salesforce |
| V3 | 2026-04-30 | Estable, con respuesta completa |
| V4 | 2026-04-30 | Estable; pendiente el pulido de formatos de fecha |
| V5 | 2026-05-05 | Comprobación de todas las páginas |
| V6 | 2026-05-12 | Pendiente el reintento |
| V7 | 2026-05-14 | Completa y estable. Clases de Salesforce V6 |
| Posteriores | | Circuit breaker, cola con semáforo, deduplicación y respaldo con la capa de texto del PDF |
