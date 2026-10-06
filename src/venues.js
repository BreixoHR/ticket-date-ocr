'use strict';

const { orphanTensDigitFixup } = require('./dateExtraction');

/**
 * Correcciones específicas por plantilla de entrada.
 *
 * Algunas plantillas tienen tipografías o layouts con los que el OCR falla siempre igual
 * (p. ej. el día impreso en dos líneas). Se identifican por un texto característico de la
 * entrada y activan fixups concretos, sin contaminar el algoritmo general.
 *
 * Los patrones de las plantillas reales usadas en producción no se publican.
 */
const VENUE_RULES = [
  {
    name: 'demo-split-day',
    match: /museo\s+demo\s+de\s+la\s+ciudad/i,
    fixups: [orphanTensDigitFixup],
  },
];

function fixupsFor(text) {
  return VENUE_RULES.filter((r) => r.match.test(text)).flatMap((r) => r.fixups);
}

module.exports = { VENUE_RULES, fixupsFor };
