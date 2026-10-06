#!/usr/bin/env node
'use strict';

/**
 * Prueba local sin servidor ni OCR:
 *   node scripts/analyze.js entrada.pdf      → usa la capa de texto del PDF
 *   node scripts/analyze.js --text "..."     → analiza un texto directamente
 */
const fs = require('node:fs');
const { analyzeTicketText } = require('../src/dateExtraction');
const { textLayer } = require('../src/pdf');
const { fixupsFor } = require('../src/venues');

async function main() {
  const [arg, value] = process.argv.slice(2);
  if (!arg) {
    console.error('Uso: node scripts/analyze.js <fichero.pdf> | --text "<texto>"');
    process.exit(1);
  }
  const text = arg === '--text' ? value : await textLayer(fs.readFileSync(arg).toString('base64'));
  if (!text) {
    console.error('El PDF no tiene capa de texto (¿escaneado?): hace falta OCR.');
    process.exit(2);
  }
  const { visitDate, dates } = analyzeTicketText(text, { fixups: fixupsFor(text) });
  console.log(JSON.stringify({ visitDate, dates }, null, 2));
}

main();
