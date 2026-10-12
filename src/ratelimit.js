// Limiteurs de débit en mémoire (seau à jetons), un seau par clé.

export class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.capacity  jetons disponibles d'un coup (rafale)
   * @param {number} opts.perMs     durée pour regagner `capacity` jetons
   * @param {() => number} [opts.now]
   */
  constructor({ capacity, perMs, now = Date.now }) {
    this.capacity = capacity;
    this.ratePerMs = capacity / perMs;
    this.now = now;
    this.buckets = new Map();
  }

  #refill(key) {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (t - bucket.at) * this.ratePerMs);
    bucket.at = t;
    this.buckets.set(key, bucket);
    return bucket;
  }

  /** Vrai si un jeton est disponible (sans le consommer). */
  check(key) {
    return this.#refill(key).tokens >= 1;
  }

  /** Consomme un jeton ; faux si le seau est vide. */
  take(key) {
    const bucket = this.#refill(key);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Oublie les seaux pleins (appelé périodiquement pour borner la mémoire). */
  sweep() {
    for (const key of this.buckets.keys()) {
      if (this.#refill(key).tokens >= this.capacity) this.buckets.delete(key);
    }
  }
}

/** Compteur de connexions simultanées par clé. */
export class ConnectionCounter {
  constructor(max) {
    this.max = max;
    this.counts = new Map();
  }

  acquire(key) {
    const n = this.counts.get(key) ?? 0;
    if (n >= this.max) return false;
    this.counts.set(key, n + 1);
    return true;
  }

  release(key) {
    const n = (this.counts.get(key) ?? 0) - 1;
    if (n > 0) this.counts.set(key, n);
    else this.counts.delete(key);
  }
}
