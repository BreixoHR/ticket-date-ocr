const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { createApp } = require('../src/app');

const API_KEY = 'test-key';
const now = () => new Date('2026-05-01T10:00:00Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PDF digital real (con capa de texto) generado al vuelo
async function makePdf(lines, pages = 1) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([400, 300]);
    lines.forEach((line, i) => page.drawText(line, { x: 30, y: 260 - i * 20, size: 12, font }));
  }
  return Buffer.from(await doc.save()).toString('base64');
}

// OCR falso y controlable desde cada test
const ocr = { name: 'fake-ocr', delayMs: 0, text: '', fail: false, calls: 0 };
ocr.extractText = async () => {
  ocr.calls++;
  await sleep(ocr.delayMs);
  if (ocr.fail) throw new Error('OCR caído');
  return ocr.text;
};

let server;
let base;
let app;
const logs = [];

before(async () => {
  app = createApp({
    ocr,
    apiKey: API_KEY,
    now,
    log: (msg, meta) => logs.push(JSON.stringify({ msg, meta })),
    config: { softTimeoutMs: 100, ocrTimeoutMs: 400, breaker: { failureThreshold: 2, probeIntervalMs: 60000 } },
  });
  await new Promise((r) => (server = app.listen(0, '127.0.0.1', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  app.dispose();
  server.close();
});

function reset(overrides = {}) {
  Object.assign(ocr, { delayMs: 0, text: '', fail: false, calls: 0 }, overrides);
}

async function analyze(body, key = API_KEY) {
  const res = await fetch(`${base}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Api-Key': key } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('sin API key o con una incorrecta → 401', async () => {
  assert.equal((await analyze({}, null)).status, 401);
  assert.equal((await analyze({}, 'otra')).status, 401);
});

test('valida recordId y que el contenido sea un PDF', async () => {
  const pdf = await makePdf(['x']);
  assert.equal((await analyze({ recordId: '../etc', fileBase64: pdf })).status, 400);
  assert.equal((await analyze({ recordId: 'R1', fileBase64: Buffer.from('hola').toString('base64') })).status, 400);
});

test('OCR encuentra la fecha → source = OCR', async () => {
  reset({ text: 'Fecha de compra 10/04/2026\nFecha de visita 27/05/2026' });
  const { status, body } = await analyze({ recordId: 'R-ocr', fileBase64: await makePdf(['escaneado']) });
  assert.equal(status, 200);
  assert.equal(body.visitDate, '2026-05-27');
  assert.equal(body.source, 'fake-ocr');
  assert.deepEqual(body.dates, ['2026-04-10', '2026-05-27']);
});

test('OCR lento → responde con la capa de texto del PDF', async () => {
  reset({ delayMs: 300, text: 'Fecha de visita 01/06/2026' });
  const started = Date.now();
  const { body } = await analyze({ recordId: 'R-slow', fileBase64: await makePdf(['Fecha de visita: 02/06/2026']) });
  assert.equal(body.visitDate, '2026-06-02');
  assert.equal(body.source, 'text-layer');
  assert.ok(Date.now() - started < 300, 'no espera al OCR');
});

test('OCR sin fecha → capa de texto', async () => {
  reset({ text: 'texto ilegible' });
  const { body } = await analyze({ recordId: 'R-nodate', fileBase64: await makePdf(['Valid on 15/05/2026']) });
  assert.equal(body.visitDate, '2026-05-15');
  assert.equal(body.source, 'text-layer');
});

test('deduplicación: el mismo recordId no vuelve a llamar al OCR', async () => {
  reset({ text: 'Entrada 20/05/2026' });
  const pdf = await makePdf(['escaneado']);
  const first = await analyze({ recordId: 'R-dup', fileBase64: pdf });
  const second = await analyze({ recordId: 'R-dup', fileBase64: pdf });
  assert.deepEqual(second.body, first.body);
  assert.equal(ocr.calls, 1);
});

test('OCR caído: fallback a capa de texto; si no hay, error y circuito abierto → 503', async () => {
  reset({ fail: true });
  const withText = await analyze({ recordId: 'R-f1', fileBase64: await makePdf(['Entrada 21/05/2026']) });
  assert.equal(withText.body.source, 'text-layer');

  const scanned = await analyze({ recordId: 'R-f2', fileBase64: await makePdf([]) });
  assert.equal(scanned.status, 503, 'segundo fallo abre el circuito');

  const callsBefore = ocr.calls;
  const blocked = await analyze({ recordId: 'R-f3', fileBase64: await makePdf([]) });
  assert.equal(blocked.status, 503);
  assert.equal(ocr.calls, callsBefore, 'con el circuito abierto no se llama al OCR');

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.circuit, 'open');
});

test('los logs nunca contienen el texto del documento', () => {
  const all = logs.join('\n');
  assert.doesNotMatch(all, /Fecha de visita|Valid on|escaneado/);
  assert.match(all, /"chars":\d+/);
});
