'use strict';

/**
 * Extracción de la FECHA DE VISITA a partir del texto de una entrada (OCR o capa de texto del PDF).
 *
 * Una entrada suele contener varias fechas: de compra, de emisión, de caducidad, el periodo de
 * una exposición... y solo una es la de visita. El algoritmo:
 *
 *   1. Normaliza artefactos típicos del OCR (meses franceses partidos, acentos, apóstrofes).
 *   2. Extrae todas las fechas con su posición en el texto (numéricas, textuales, rangos "du X au Y").
 *   3. Descarta fechas de compra/emisión (filtro duro) y de caducidad (filtro blando).
 *   4. Descarta pares que forman un rango de evento ("25 de marzo - 20 de julio").
 *   5. Prefiere fechas recientes o futuras.
 *   6. Desempata por cercanía a palabras clave ("fecha de visita", "valid on", "date de visite"...).
 *
 * Todas las funciones son puras; `now` es inyectable para tests deterministas.
 */

const MONTHS = {
  // es
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, abr: 4, ago: 8, dic: 12,
  // en
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  // fr (sin acentos: el texto se normaliza antes)
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8,
  septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  // it
  gennaio: 1, febbraio: 2, aprile: 4, maggio: 5, giugno: 6, luglio: 7, settembre: 9, ottobre: 10, dicembre: 12,
};

const MONTH_ALTERNATION = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

// Etiquetas inequívocas de fecha de visita
const VISIT_KEYWORDS = [
  'fecha de visita', 'fecha visita', 'fecha de comienzo', 'fecha de inicio', 'fecha inicio',
  'fecha de entrada', 'fecha de acceso', 'fecha de uso', 'dia de visita',
  'valido el', 'valido para', 'valido desde',
  'visit date', 'date of visit', 'entry date', 'valid for', 'valid on', 'valid from', 'check-in', 'arrival',
  'date de visite', "date d'entree", 'valable le', 'valable pour',
  'data della visita', 'data di ingresso', 'valido il',
];

// Etiquetas genéricas: solo sirven para desempatar
const GENERIC_DATE_KEYWORDS = ['entrada:', 'entrada ', 'date:', 'fecha:', 'fecha ', 'date ', 'datum ', 'dia:', 'day:', 'data:'];

const PURCHASE_KEYWORDS = [
  'fecha de compra', 'fecha de emision', 'fecha de reserva', 'fecha de pedido',
  'purchase date', 'issued on', 'issue date', 'order date', 'booking date',
  "date d'achat", 'date dachat', "d'achat", 'achat :', 'achat:',
  'data di acquisto', 'acquisto:', 'compra:',
  // Fechas operativas: "a partir del 10 de marzo" nunca es la fecha de visita
  'a partir del', 'a partir de', 'starting from', 'a partir du',
];

const EXPIRY_KEYWORDS = ['hasta ', 'until ', "jusqu'au ", 'valid until', 'caduca'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Corrige artefactos frecuentes del OCR antes de buscar fechas. */
function normalizeOcrText(raw) {
  let text = String(raw || '')
    .replace(/[‘’ʼ´`ʻ]/g, "'")
    .replace(/[“”]/g, '"');
  text = stripAccents(text);
  // "AÛT" → el OCR a veces pierde la U: "AOT"
  text = text.replace(/\bAOT\b/gi, 'AOUT');
  // "18JUILLET 2026" → "18 JUILLET 2026" (día pegado al mes)
  text = text.replace(new RegExp(`\\b(\\d{1,2})(${MONTH_ALTERNATION})\\b`, 'gi'), '$1 $2');
  // "11 J UILLET" → "11 JUILLET" (el OCR separa la J inicial)
  text = text.replace(/\b(\d{1,2})\s*J\s+(uillet|uin|anvier)\b/gi, (_, d, rest) => `${d} J${rest}`);
  return text;
}

function monthToNumber(name) {
  const key = stripAccents(String(name).toLowerCase().replace(/\.$/, ''));
  if (MONTHS[key]) return MONTHS[key];
  // Prefijos ("sept.", "febr") — mínimo 3 letras para evitar falsos positivos
  if (key.length >= 3) {
    const hit = Object.keys(MONTHS).find((m) => m.startsWith(key));
    if (hit) return MONTHS[hit];
  }
  return null;
}

function expandYear(y) {
  const n = Number(y);
  return String(y).length === 2 ? 2000 + n : n;
}

function toIso(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  // Rechaza desbordes: 31/02 → 03/03
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Fecha suelta (numérica o textual, formato europeo) → ISO YYYY-MM-DD, o null. */
function parseDate(str) {
  const s = String(str || '').trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return toIso(expandYear(m[3]), m[2], m[1]);

  m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) return toIso(m[1], m[2], m[3]);

  m = s.match(/^(\d{1,2})\s+(?:de\s+)?([a-z]+)\.?\s+(?:de\s+)?(\d{2}|\d{4})$/i);
  if (m) {
    const month = monthToNumber(m[2]);
    return month ? toIso(expandYear(m[3]), month, m[1]) : null;
  }

  m = s.match(/^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{2}|\d{4})$/i);
  if (m) {
    const month = monthToNumber(m[1]);
    return month ? toIso(expandYear(m[3]), month, m[2]) : null;
  }
  return null;
}

function daysBetween(isoA, isoB) {
  return Math.round((Date.parse(isoA) - Date.parse(isoB)) / 86400000);
}

/** Una entrada razonable: desde hace 1 año hasta dentro de 5. */
function isPlausibleTicketDate(iso, now) {
  const today = now.toISOString().slice(0, 10);
  const diff = daysBetween(iso, today);
  return diff >= -366 && diff <= 5 * 366;
}

/**
 * Devuelve las fechas encontradas, ordenadas por posición y sin duplicados:
 * [{ iso, position, length }]
 */
function extractDates(text, { now = new Date(), fixups = [] } = {}) {
  const month = `(?:${MONTH_ALTERNATION})\\.?`;
  const patterns = [
    /\b(\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2}))\b/g,
    /\b(\d{4}[/-]\d{1,2}[/-]\d{1,2})\b/g,
    new RegExp(`\\b(\\d{1,2}\\s+(?:de\\s+)?${month}\\s+(?:de\\s+)?(?:\\d{4}|\\d{2}))\\b`, 'gi'),
    new RegExp(`\\b(${month}\\s+\\d{1,2},?\\s+(?:\\d{4}|\\d{2}))\\b`, 'gi'),
  ];

  let results = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const iso = parseDate(m[1]);
      if (iso && isPlausibleTicketDate(iso, now)) results.push({ iso, position: m.index, length: m[1].length });
    }
  }

  // Rango francés "DU [lundi] 12 AU [mardi] 14 JUILLET 2026" → el inicio (12)
  const weekday = '(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\\s+';
  const rangeRe = new RegExp(`\\bDU\\s+(?:${weekday})?(\\d{1,2})\\s+AU\\s+(?:${weekday})?\\d{1,2}\\s+(${MONTH_ALTERNATION})\\s+(\\d{4})\\b`, 'gi');
  for (const m of text.matchAll(rangeRe)) {
    const iso = parseDate(`${m[1]} ${m[2]} ${m[3]}`);
    if (iso && isPlausibleTicketDate(iso, now)) results.push({ iso, position: m.index, length: m[0].length });
  }

  for (const fix of fixups) results = fix(text, results, { now });

  results.sort((a, b) => a.position - b.position);
  const seen = new Set();
  return results.filter((d) => !seen.has(d.iso) && seen.add(d.iso));
}

/**
 * Fixup opcional para plantillas donde el OCR pierde el dígito de las decenas del día
 * ("2\n7/05/2026" se lee "7/05/2026"). Se activa por plantilla: ver config/venues.js.
 */
function orphanTensDigitFixup(text, results, { now }) {
  const fixed = results.map((r) => {
    const [y, mo, d] = r.iso.split('-').map(Number);
    if (d >= 10) return r;
    const orphan = text.slice(Math.max(0, r.position - 5), r.position).match(/(\d)\s*$/);
    if (!orphan) return r;
    const iso = toIso(y, mo, Number(orphan[1] + d));
    return iso && isPlausibleTicketDate(iso, now) ? { ...r, iso } : r;
  });
  // Si conviven "7/05" (incompleta) y "27/05" (completa), se elimina la incompleta
  return fixed.filter((r) => {
    const [y, mo, d] = r.iso.split('-').map(Number);
    if (d >= 10) return true;
    return !fixed.some((o) => {
      const [y2, mo2, d2] = o.iso.split('-').map(Number);
      return o !== r && y2 === y && mo2 === mo && d2 > d && d2 % 10 === d;
    });
  });
}

function findOccurrences(lower, keywords, type) {
  const out = [];
  for (const kw of keywords) {
    for (let idx = lower.indexOf(kw); idx !== -1; idx = lower.indexOf(kw, idx + 1)) {
      out.push({ type, start: idx, end: idx + kw.length });
    }
  }
  return out;
}

/**
 * Asocia cada etiqueta a la fecha a la que se refiere:
 *  - "Etiqueta: FECHA" (lo habitual): la primera fecha que la sigue, si está cerca y no hay otra
 *    etiqueta en medio;
 *  - "FECHA etiqueta": si no hay ninguna detrás, la fecha que la precede inmediatamente.
 * Devuelve Map(tipo → Set(fechas)).
 *
 * Sustituye a la heurística original ("hay una palabra de compra a <150 caracteres"), que con
 * "Fecha de compra X / Fecha de visita Y" descartaba también Y.
 */
function bindLabels(lower, dates, labelSets, { forward = 40, backward = 60 } = {}) {
  const labels = labelSets.flatMap(({ type, keywords }) => findOccurrences(lower, keywords, type)).sort((a, b) => a.start - b.start);
  const bound = new Map(labelSets.map(({ type }) => [type, new Set()]));

  const sameLine = (a, b) => !lower.slice(Math.min(a, b), Math.max(a, b)).includes('\n');

  for (const label of labels) {
    const nextLabel = labels.find((l) => l.start >= label.end);
    let next = dates.find((d) => d.position >= label.end && d.position - label.end <= forward);
    if (next && nextLabel && nextLabel.start < next.position) next = null; // la fecha es de otra etiqueta

    const allowBackward = labelSets.find((s) => s.type === label.type).backward !== false;
    const prev = allowBackward
      ? [...dates].reverse().find((d) => d.position + d.length <= label.start && label.start - (d.position + d.length) <= backward)
      : null;

    // Manda la fecha de la misma línea; si no hay, la siguiente; si no, la anterior
    const target =
      (next && sameLine(label.end, next.position) && next) ||
      (prev && sameLine(prev.position, label.start) && prev) ||
      next ||
      prev;
    if (target) bound.get(label.type).add(target);
  }
  return bound;
}

/** Elige la fecha de visita entre las candidatas. Devuelve ISO o null. */
function findVisitDate(text, dates, { now = new Date() } = {}) {
  if (dates.length === 0) return null;
  const lower = text.toLowerCase();

  const hasTimeSlot = lower.includes('time slot');
  const bound = bindLabels(lower, dates, [
    { type: 'purchase', keywords: PURCHASE_KEYWORDS.filter((k) => !(k === 'booking date' && hasTimeSlot)) },
    { type: 'expiry', keywords: EXPIRY_KEYWORDS, backward: false },
    { type: 'visit', keywords: VISIT_KEYWORDS },
    { type: 'generic', keywords: GENERIC_DATE_KEYWORDS },
  ]);
  const visit = bound.get('visit');

  // 1. Compra/emisión: fuera (salvo que la fecha tenga también etiqueta de visita)
  let candidates = dates.filter((d) => !bound.get('purchase').has(d) || visit.has(d));
  if (candidates.length === 0) candidates = dates;

  // 2. Caducidad ("hasta X"): filtro blando, solo si queda alguna otra
  const nonExpiry = candidates.filter((d) => !bound.get('expiry').has(d));
  if (nonExpiry.length > 0) candidates = nonExpiry;

  // 3. Rangos de evento: "25 de marzo de 2026 - 20 de julio de 2026"
  const inRange = new Set();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const [a, b] = [candidates[i], candidates[j]].sort((x, y) => x.position - y.position);
      const between = text.slice(a.position + a.length, b.position);
      if (/^\s*[-–]\s*$|^\s*al\s*$|^\s*to\s*$|^\s*au\s*$/i.test(between)) {
        inRange.add(a);
        inRange.add(b);
      }
    }
  }
  const nonRange = candidates.filter((d) => !inRange.has(d) || visit.has(d));
  if (nonRange.length > 0) candidates = nonRange;

  // 4. Preferir recientes/futuras (ventana de 30 días hacia atrás)
  const today = now.toISOString().slice(0, 10);
  const recent = candidates.filter((d) => daysBetween(d.iso, today) >= -30);
  if (recent.length > 0) candidates = recent;

  // 5. Prioridad: etiqueta de visita > única candidata > etiqueta genérica > primera
  const labelledVisit = candidates.find((d) => visit.has(d));
  if (labelledVisit) return labelledVisit.iso;
  if (candidates.length === 1) return candidates[0].iso;
  const labelledGeneric = candidates.find((d) => bound.get('generic').has(d));
  return (labelledGeneric || candidates[0]).iso;
}

/** Punto de entrada: texto → { text, dates[], visitDate } */
function analyzeTicketText(rawText, { now = new Date(), fixups = [] } = {}) {
  const text = normalizeOcrText(rawText);
  const dates = extractDates(text, { now, fixups });
  return { text, dates: dates.map((d) => d.iso), visitDate: findVisitDate(text, dates, { now }) };
}

module.exports = {
  analyzeTicketText,
  normalizeOcrText,
  parseDate,
  extractDates,
  findVisitDate,
  orphanTensDigitFixup,
};
