'use strict';

const { PDFDocument } = require('pdf-lib');
const { withTimeout } = require('./resilience');

let PDFParse = null;
try {
  ({ PDFParse } = require('pdf-parse'));
} catch {
  // Sin pdf-parse no hay fallback de capa de texto; el servicio sigue funcionando solo con OCR
}

/**
 * Recorta el PDF a sus primeras páginas antes de mandarlo al OCR: la fecha de visita está
 * siempre al principio y el OCR cobra y tarda por página.
 */
async function firstPages(base64Pdf, maxPages = 3) {
  try {
    const src = await PDFDocument.load(Buffer.from(base64Pdf, 'base64'), { ignoreEncryption: true });
    if (src.getPageCount() <= maxPages) return { base64: base64Pdf, pages: src.getPageCount(), trimmed: false };
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, [...Array(maxPages).keys()]);
    pages.forEach((p) => out.addPage(p));
    return { base64: Buffer.from(await out.save()).toString('base64'), pages: src.getPageCount(), trimmed: true };
  } catch {
    // PDF malformado o con estructura especial: el OCR suele poder con él igualmente
    return { base64: base64Pdf, pages: null, trimmed: false };
  }
}

/** Texto embebido del PDF (sin OCR). Cadena vacía si es escaneado, malformado o tarda demasiado. */
async function textLayer(base64Pdf, { timeoutMs = 10000, maxPages = 3 } = {}) {
  if (!PDFParse) return '';
  let parser;
  try {
    parser = new PDFParse({ data: Buffer.from(base64Pdf, 'base64') });
    const result = await withTimeout(parser.getText({ first: maxPages }), timeoutMs, 'TEXT_LAYER_TIMEOUT');
    return (result?.text || '').trim();
  } catch {
    return '';
  } finally {
    parser?.destroy().catch(() => {});
  }
}

function looksLikePdf(base64) {
  try {
    return Buffer.from(base64.slice(0, 12), 'base64').toString('latin1').startsWith('%PDF');
  } catch {
    return false;
  }
}

module.exports = { firstPages, textLayer, looksLikePdf };
