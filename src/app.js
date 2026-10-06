'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { analyzeTicketText } = require('./dateExtraction');
const { CircuitBreaker, Semaphore, QueueTimeoutError, TtlCache, withTimeout } = require('./resilience');
const pdf = require('./pdf');
const { fixupsFor } = require('./venues');

// PDF mínimo válido (una página en blanco) para sondear el OCR cuando el circuito está abierto
const PROBE_PDF =
  'JVBERi0xLjAKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCAzIDNdPj5lbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyPDwvU2l6ZSA0L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMTkwCiUlRU9G';

const DEFAULTS = {
  ocrTimeoutMs: 80000, // corte duro de la llamada al OCR
  softTimeoutMs: 20000, // pasado este tiempo se responde con la capa de texto si ya tiene fecha
  textLayerTimeoutMs: 10000,
  maxConcurrent: 3,
  queueTimeoutMs: 90000,
  dedupTtlMs: 120000,
  maxPages: 3,
  breaker: { failureThreshold: 3, probeIntervalMs: 30000 },
  bodyLimit: '10mb',
};

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * @param {object} deps
 * @param {{ name: string, extractText(base64: string): Promise<string> }} deps.ocr
 * @param {string} deps.apiKey   clave que debe enviar el cliente en X-Api-Key
 * @param {(msg: string, meta?: object) => void} [deps.log]
 * @param {() => Date} [deps.now]
 */
function createApp({ ocr, apiKey, log = () => {}, now = () => new Date(), config = {} }) {
  if (!apiKey) throw new Error('apiKey es obligatoria');
  const defined = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
  const cfg = { ...DEFAULTS, ...defined, breaker: { ...DEFAULTS.breaker, ...defined.breaker } };

  const semaphore = new Semaphore({ max: cfg.maxConcurrent, queueTimeoutMs: cfg.queueTimeoutMs });
  const dedup = new TtlCache({ ttlMs: cfg.dedupTtlMs });
  const breaker = new CircuitBreaker({
    ...cfg.breaker,
    probe: () => withTimeout(ocr.extractText(PROBE_PDF), cfg.ocrTimeoutMs, 'OCR_TIMEOUT'),
    onStateChange: (state) => log(`circuit breaker ${state}`),
  });

  async function runOcr(base64) {
    try {
      const text = await withTimeout(ocr.extractText(base64), cfg.ocrTimeoutMs, 'OCR_TIMEOUT');
      breaker.recordSuccess();
      return text;
    } catch (err) {
      breaker.recordFailure();
      throw err;
    }
  }

  /**
   * OCR como fuente principal y capa de texto del PDF en paralelo como respaldo:
   *  - si el OCR tarda más de softTimeoutMs y la capa de texto ya tiene fecha → se responde con ella
   *  - si el OCR falla o no encuentra fecha → capa de texto
   */
  async function analyze(base64, recordId) {
    const analyzeOpts = (text) => analyzeTicketText(text, { now: now(), fixups: fixupsFor(text) });
    const fromTextLayer = pdf.textLayer(base64, { timeoutMs: cfg.textLayerTimeoutMs, maxPages: cfg.maxPages }).then(analyzeOpts);

    if (breaker.isOpen) {
      const tl = await fromTextLayer;
      if (tl.visitDate) return { ...tl, source: 'text-layer' };
      const err = new Error('OCR_UNAVAILABLE');
      err.status = 503;
      throw err;
    }

    const trimmed = await pdf.firstPages(base64, cfg.maxPages);
    const fromOcr = runOcr(trimmed.base64).then(analyzeOpts);
    fromOcr.catch(() => {}); // si se responde con la capa de texto, el OCR termina en segundo plano

    let soft;
    const softTimeout = new Promise((r) => (soft = setTimeout(() => r('SOFT_TIMEOUT'), cfg.softTimeoutMs)));
    try {
      const first = await Promise.race([fromOcr, softTimeout]);
      if (first === 'SOFT_TIMEOUT') {
        const tl = await fromTextLayer;
        if (tl.visitDate) {
          log('ocr lento, se usa la capa de texto', { recordId });
          return { ...tl, source: 'text-layer' };
        }
        const ocrResult = await fromOcr;
        return { ...ocrResult, source: ocr.name };
      }
      if (first.visitDate) return { ...first, source: ocr.name };
      const tl = await fromTextLayer;
      return tl.visitDate ? { ...tl, source: 'text-layer' } : { ...first, source: ocr.name };
    } catch (err) {
      const tl = await fromTextLayer;
      if (tl.visitDate) {
        log('ocr falló, se usa la capa de texto', { recordId, error: err.message });
        return { ...tl, source: 'text-layer' };
      }
      throw err;
    } finally {
      clearTimeout(soft);
    }
  }

  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (req, res) => {
    res.json({ ok: true, ocr: ocr.name, circuit: breaker.isOpen ? 'open' : 'closed', active: semaphore.active, queued: semaphore.waiting });
  });

  app.use('/analyze', (req, res, next) => {
    if (!safeEqual(req.get('x-api-key') || '', apiKey)) return res.status(401).json({ success: false, error: 'No autorizado' });
    next();
  });

  app.post('/analyze', express.json({ limit: cfg.bodyLimit }), async (req, res) => {
    const started = Date.now();
    const { recordId, fileBase64 } = req.body || {};

    if (typeof recordId !== 'string' || !/^[\w-]{1,64}$/.test(recordId)) {
      return res.status(400).json({ success: false, error: 'recordId no válido' });
    }
    if (typeof fileBase64 !== 'string' || !pdf.looksLikePdf(fileBase64)) {
      return res.status(400).json({ success: false, error: 'fileBase64 debe ser un PDF en base64' });
    }

    // Salesforce reintenta si corta la conexión: devolvemos el resultado ya calculado
    const cached = dedup.get(recordId);
    if (cached) {
      if (cached.result) return res.json(cached.result);
      return res.status(202).json({ success: true, recordId, pending: true });
    }
    dedup.set(recordId, {});

    let clientGone = false;
    res.on('close', () => (clientGone = !res.writableEnded));

    try {
      const parsed = await semaphore.run(() => analyze(fileBase64, recordId));
      const result = { success: true, recordId, visitDate: parsed.visitDate, dates: parsed.dates, source: parsed.source };
      dedup.update(recordId, { result });
      // Nunca se registra el texto del documento (datos personales): solo metadatos
      log('analizado', { recordId, ms: Date.now() - started, source: parsed.source, visitDate: parsed.visitDate, chars: parsed.text.length });
      if (!clientGone) res.json(result);
    } catch (err) {
      dedup.delete(recordId);
      log('error', { recordId, ms: Date.now() - started, error: err.message });
      if (clientGone || res.headersSent) return;
      if (err instanceof QueueTimeoutError) return res.status(503).json({ success: false, error: 'Servidor ocupado, reintenta en unos segundos' });
      if (err.status === 503 || breaker.isOpen) return res.status(503).json({ success: false, error: 'OCR no disponible temporalmente' });
      res.status(502).json({ success: false, error: 'No se pudo procesar el documento' });
    }
  });

  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'Documento demasiado grande' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'JSON no válido' });
    if (res.headersSent) return next(err);
    res.status(500).json({ success: false, error: 'Error interno' });
  });

  app.dispose = () => {
    breaker.dispose();
    dedup.dispose();
  };
  return app;
}

module.exports = { createApp, DEFAULTS };
