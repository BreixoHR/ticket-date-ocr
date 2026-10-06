const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CircuitBreaker, Semaphore, QueueTimeoutError, TtlCache, withTimeout } = require('../src/resilience');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('CircuitBreaker abre tras N fallos y se cierra cuando el sondeo tiene éxito', async () => {
  let probeOk = false;
  const states = [];
  const cb = new CircuitBreaker({
    failureThreshold: 2,
    probeIntervalMs: 20,
    probe: async () => {
      if (!probeOk) throw new Error('caído');
    },
    onStateChange: (s) => states.push(s),
  });

  cb.recordFailure();
  assert.equal(cb.isOpen, false);
  cb.recordFailure();
  assert.equal(cb.isOpen, true);

  await sleep(50); // sondeos fallidos: sigue abierto
  assert.equal(cb.isOpen, true);

  probeOk = true;
  await sleep(50);
  assert.equal(cb.isOpen, false);
  assert.deepEqual(states, ['open', 'closed']);
  cb.dispose();
});

test('CircuitBreaker: un éxito reinicia el contador de fallos', () => {
  const cb = new CircuitBreaker({ failureThreshold: 2 });
  cb.recordFailure();
  cb.recordSuccess();
  cb.recordFailure();
  assert.equal(cb.isOpen, false);
});

test('Semaphore limita la concurrencia y respeta el orden FIFO', async () => {
  const sem = new Semaphore({ max: 2, queueTimeoutMs: 1000 });
  let running = 0;
  let peak = 0;
  const order = [];
  const job = (id) =>
    sem.run(async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(15);
      order.push(id);
      running--;
    });

  await Promise.all([1, 2, 3, 4, 5].map(job));
  assert.equal(peak, 2);
  assert.deepEqual(order.slice(2), [3, 4, 5]);
  assert.equal(sem.active, 0);
});

test('Semaphore: la espera en cola caduca y no deja huecos ocupados', async () => {
  const sem = new Semaphore({ max: 1, queueTimeoutMs: 20 });
  await sem.acquire();
  await assert.rejects(sem.acquire(), QueueTimeoutError);
  assert.equal(sem.waiting, 0);
  sem.release();
  assert.equal(sem.active, 0);
  await sem.acquire(); // vuelve a estar disponible
  sem.release();
});

test('TtlCache caduca entradas', async () => {
  const c = new TtlCache({ ttlMs: 20 });
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  await sleep(30);
  assert.equal(c.get('a'), undefined);
  c.dispose();
});

test('withTimeout', async () => {
  assert.equal(await withTimeout(Promise.resolve(1), 50), 1);
  await assert.rejects(withTimeout(sleep(100), 10, 'LENTO'), /LENTO/);
});
