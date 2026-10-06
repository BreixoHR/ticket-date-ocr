'use strict';

require('dotenv').config();
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT || 3008);
const HOST = process.env.HOST || '127.0.0.1';

function log(msg, meta) {
  console.log(`${new Date().toISOString()} ${msg}`, meta ? JSON.stringify(meta) : '');
}

function createOcr() {
  if (process.env.OCR_PROVIDER === 'none') {
    // Modo sin OCR: solo capa de texto del PDF (útil en local o para PDFs digitales)
    return { name: 'none', extractText: async () => '' };
  }
  const { createOciProvider } = require('./src/ocr/oci');
  return createOciProvider({
    compartmentId: process.env.OCI_COMPARTMENT_ID,
    configFile: process.env.OCI_CONFIG_FILE,
    profile: process.env.OCI_PROFILE,
    region: process.env.OCI_REGION,
  });
}

const app = createApp({
  ocr: createOcr(),
  apiKey: process.env.API_KEY,
  log,
  config: {
    softTimeoutMs: Number(process.env.OCR_SOFT_TIMEOUT_MS) || undefined,
    maxConcurrent: Number(process.env.MAX_CONCURRENT) || undefined,
  },
});

// Detrás de un proxy TLS (nginx/Caddy): el servicio solo escucha en local
app.listen(PORT, HOST, () => log(`ticket-date-ocr escuchando en http://${HOST}:${PORT}`));
