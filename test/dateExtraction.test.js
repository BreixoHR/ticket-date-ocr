const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeTicketText, parseDate, normalizeOcrText, orphanTensDigitFixup } = require('../src/dateExtraction');

// "Hoy" fijo para que los filtros de fechas plausibles/recientes sean deterministas
const now = new Date('2026-05-01T10:00:00Z');
const visit = (text, opts = {}) => analyzeTicketText(text, { now, ...opts }).visitDate;

test('parseDate: formatos numéricos y textuales → ISO', () => {
  assert.equal(parseDate('27/05/2026'), '2026-05-27');
  assert.equal(parseDate('7-5-26'), '2026-05-07');
  assert.equal(parseDate('2026-05-27'), '2026-05-27');
  assert.equal(parseDate('27 de mayo de 2026'), '2026-05-27');
  assert.equal(parseDate('27 Mai 2026'), '2026-05-27');
  assert.equal(parseDate('May 27, 2026'), '2026-05-27');
  assert.equal(parseDate('27 sept. 2026'), '2026-09-27');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('27 de nada de 2026'), null);
});

test('normalizeOcrText corrige errores típicos del OCR en francés', () => {
  assert.match(normalizeOcrText('18JUILLET 2026'), /18 JUILLET 2026/);
  assert.match(normalizeOcrText('11 J UILLET 2026'), /11 JUILLET 2026/);
  assert.match(normalizeOcrText('15 AOT 2026'), /15 AOUT 2026/);
  assert.match(normalizeOcrText('15 AOÛT 2026'), /15 AOUT 2026/);
  assert.match(normalizeOcrText('Date d’achat'), /Date d'achat/);
});

test('una sola fecha → esa fecha', () => {
  assert.equal(visit('ENTRADA GENERAL\n27/05/2026 10:30\nAdulto x2'), '2026-05-27');
});

test('descarta la fecha de compra (español)', () => {
  const text = `Fecha de compra: 14/04/2026
Localizador: ABC123
Fecha de visita: 27/05/2026
Hora: 10:30`;
  assert.equal(visit(text), '2026-05-27');
});

test('regresión v1: compra y visita en líneas consecutivas', () => {
  // La heurística original ("palabra de compra a <150 caracteres") descartaba también la de visita
  assert.equal(visit('Fecha de compra 10/04/2026\nFecha de visita 27/05/2026'), '2026-05-27');
  assert.equal(visit('Fecha de compra:\nFecha de visita: 27/05/2026\n10/04/2026'), '2026-05-27');
});

test('etiqueta detrás de la fecha ("FECHA (compra)")', () => {
  assert.equal(visit('28/04/2026 (fecha de compra)\n03/06/2026 10:00 Acceso'), '2026-06-03');
});

test("descarta la fecha d'achat aunque vaya después (francés)", () => {
  const text = `BILLET D'ENTREE
Samedi 18 JUILLET 2026 - 09h30
Commande n° 99812
Date d’achat : 02/05/2026`;
  assert.equal(visit(text), '2026-07-18');
});

test('OCR francés con el mes partido', () => {
  assert.equal(visit('VISITE GUIDEE\n11 J UILLET 2026\n14:00'), '2026-07-11');
  assert.equal(visit('ENTREE\n18JUILLET 2026'), '2026-07-18');
});

test('rango francés "du X au Y" → fecha de inicio', () => {
  assert.equal(visit('PASS 2 JOURS\nValable DU samedi 12 AU dimanche 13 JUILLET 2026'), '2026-07-12');
});

test('válido desde X hasta Y → X (la caducidad se descarta)', () => {
  assert.equal(visit('Abono anual\nVálido desde 17/06/2026 hasta 17/06/2027'), '2026-06-17');
});

test('una fecha precedida de "hasta" no se elimina si es la única candidata', () => {
  assert.equal(visit('Entrada válida hasta 30/05/2026'), '2026-05-30');
});

test('ignora el periodo de una exposición', () => {
  const text = `Exposición temporal
25 de marzo de 2026 - 20 de julio de 2026
Fecha de visita 03/06/2026`;
  assert.equal(visit(text), '2026-06-03');
});

test('"a partir del" (fecha operativa) no es la fecha de visita', () => {
  const text = 'Nuevo horario a partir del 10 de marzo de 2026\nDía: 22/05/2026';
  assert.equal(visit(text), '2026-05-22');
});

test('prefiere fechas recientes/futuras frente a antiguas', () => {
  const text = 'Tarifa vigente 01/01/2026\nEntrada 15/05/2026';
  assert.equal(visit(text), '2026-05-15');
});

test('desempata por cercanía a "valid on" (inglés)', () => {
  const text = `Order 4471 · 12/05/2026 ref
Some other date 20/05/2026
Valid on: 23/05/2026
Gate opens 09:00`;
  assert.equal(visit(text), '2026-05-23');
});

test('italiano: data di acquisto vs data della visita', () => {
  const text = 'Data di acquisto: 20/04/2026\nData della visita: 05/06/2026';
  assert.equal(visit(text), '2026-06-05');
});

test('fechas fuera de rango plausible se ignoran (ej. fecha de nacimiento)', () => {
  assert.equal(visit('Titular nacido el 12/03/1985\nEntrada 30/05/2026'), '2026-05-30');
});

test('sin fechas → null', () => {
  const r = analyzeTicketText('ENTRADA GENERAL\nAdulto x2', { now });
  assert.equal(r.visitDate, null);
  assert.deepEqual(r.dates, []);
});

test('fixup de decena huérfana: "2\\n7/05/2026" → 27/05/2026', () => {
  const text = 'MUSEO DEMO\nFecha: 2\n7/05/2026';
  assert.equal(visit(text), '2026-05-07', 'sin fixup el OCR da el día 7');
  assert.equal(visit(text, { fixups: [orphanTensDigitFixup] }), '2026-05-27');
});

test('fixup: si coexisten 7/05 y 27/05 se queda la completa', () => {
  const r = analyzeTicketText('Día 7/05/2026\nEntrada 27/05/2026', { now, fixups: [orphanTensDigitFixup] });
  assert.deepEqual(r.dates, ['2026-05-27']);
});
