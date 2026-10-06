'use strict';

/**
 * Primitivas de resiliencia, sin dependencias. Nacieron de incidentes reales en producción:
 *  - OCI caído → cada petición esperaba 80 s y Salesforce agotaba sus callouts → CircuitBreaker.
 *  - Ráfagas de subidas (cargas masivas de entradas) saturaban la RAM del servidor → Semaphore.
 *  - Salesforce reintenta el mismo documento si corta la conexión → TtlCache para deduplicar.
 */

/** Circuit breaker con recuperación por sondeo en segundo plano. */
class CircuitBreaker {
  constructor({ failureThreshold = 3, probeIntervalMs = 30000, probe, onStateChange = () => {} } = {}) {
    this.failureThreshold = failureThreshold;
    this.probeIntervalMs = probeIntervalMs;
    this.probe = probe;
    this.onStateChange = onStateChange;
    this.failures = 0;
    this.open = false;
    this.probeTimer = null;
  }

  get isOpen() {
    return this.open;
  }

  recordSuccess() {
    const wasOpen = this.open;
    this.failures = 0;
    this.open = false;
    clearTimeout(this.probeTimer);
    this.probeTimer = null;
    if (wasOpen) this.onStateChange('closed');
  }

  recordFailure() {
    this.failures++;
    if (!this.open && this.failures >= this.failureThreshold) {
      this.open = true;
      this.onStateChange('open');
      this.scheduleProbe();
    }
  }

  scheduleProbe() {
    if (this.probeTimer || !this.probe) return;
    this.probeTimer = setTimeout(async () => {
      this.probeTimer = null;
      if (!this.open) return;
      try {
        await this.probe();
        this.recordSuccess();
      } catch {
        this.scheduleProbe();
      }
    }, this.probeIntervalMs);
    this.probeTimer.unref?.();
  }

  dispose() {
    clearTimeout(this.probeTimer);
    this.probeTimer = null;
  }
}

class QueueTimeoutError extends Error {
  constructor() {
    super('QUEUE_TIMEOUT');
    this.name = 'QueueTimeoutError';
  }
}

/** Semáforo con cola FIFO y tiempo máximo de espera. */
class Semaphore {
  constructor({ max = 3, queueTimeoutMs = 90000 } = {}) {
    this.max = max;
    this.queueTimeoutMs = queueTimeoutMs;
    this.active = 0;
    this.queue = [];
  }

  get waiting() {
    return this.queue.length;
  }

  acquire() {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve };
      waiter.timer = setTimeout(() => {
        this.queue.splice(this.queue.indexOf(waiter), 1);
        reject(new QueueTimeoutError());
      }, this.queueTimeoutMs);
      this.queue.push(waiter);
    });
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      // El hueco pasa directamente al siguiente: `active` no cambia
      clearTimeout(next.timer);
      next.resolve();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Map con caducidad por entrada. */
class TtlCache {
  constructor({ ttlMs = 120000 } = {}) {
    this.ttlMs = ttlMs;
    this.map = new Map();
    this.sweeper = setInterval(() => this.sweep(), ttlMs);
    this.sweeper.unref?.();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.map.set(key, { value, ts: Date.now() });
  }

  update(key, value) {
    const entry = this.map.get(key);
    if (entry) entry.value = value;
  }

  delete(key) {
    this.map.delete(key);
  }

  sweep() {
    const now = Date.now();
    for (const [k, e] of this.map) if (now - e.ts > this.ttlMs) this.map.delete(k);
  }

  dispose() {
    clearInterval(this.sweeper);
  }
}

/** Rechaza si la promesa no termina a tiempo (y limpia el temporizador). */
function withTimeout(promise, ms, message = 'TIMEOUT') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { CircuitBreaker, Semaphore, QueueTimeoutError, TtlCache, withTimeout };
