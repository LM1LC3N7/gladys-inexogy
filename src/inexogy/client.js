// -----------------------------------------------------------------------------
// The only network access: the official inexogy API
// (https://api.inexogy.com/public/v1), as the pydiscovergy library reads it
// with its default authentication (see THIRD_PARTY_NOTICES.md):
// - HTTP Basic with the e-mail and the password of the customer account;
// - GET /meters: the meters of the account;
// - GET /last_reading?meterId=<id>: the last reading of a meter.
// Read-only: nothing else is ever sent. Node's own fetch: no User-Agent of
// ours, no imitation of an app, no key of an app. The OAuth 1 flow of
// pydiscovergy (a consumer token asked under an application name) is not
// ported.
//
// Bounded: one request at a time, 10 s for the whole answer (the body
// included), 256 KiB at most read into one buffer allocated once, never a
// redirect followed (the password never goes elsewhere).
//
// Each answer comes with the time of inexogy (its `Date` header, when
// readable): a reading is called stale against that clock, never against the
// clock of Gladys.
//
// Errors carry our own codes, never a text of the cloud, a URL, the e-mail
// nor the password.
// -----------------------------------------------------------------------------

import { API_BASE, HTTP_TIMEOUT, ID_PATTERN, MAX_BODY_BYTES } from '../constants.js';
import { parseMeters, parseReading } from './model.js';

export class InexogyError extends Error {
  /**
   * @param {'timeout'|'unreachable'|'http'|'not_found'|'server'|'rate_limited'|'too_large'|
   *   'redirect'|'bad_answer'|'refused'|'forbidden'|'unauthorized'} code
   * `refused`: the meter list answered 401 or 403 (the account refused):
   * final, nothing more is sent with these credentials.
   */
  constructor(code, { status, retryAfter } = {}) {
    super(code);
    this.name = 'InexogyError';
    this.code = code;
    this.status = status;
    /** ms, from a Retry-After header (429, 503), when given. */
    this.retryAfter = retryAfter;
  }

  get final() {
    return this.code === 'refused';
  }
}

/** A network failure (while connecting or while reading the body), in our words. */
function networkError(err) {
  if (err instanceof InexogyError) {
    return err;
  }
  const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return new InexogyError(timeout ? 'timeout' : 'unreachable');
}

/**
 * The body, up to `limit` bytes, copied into a single buffer allocated once
 * (no list of chunks, no concatenation): a longer one is not an answer.
 */
export async function readBounded(response, limit) {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const buffer = new Uint8Array(limit);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (size + value.byteLength > limit) {
        throw new InexogyError('too_large');
      }
      buffer.set(value, size);
      size += value.byteLength;
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  return new TextDecoder('utf-8').decode(buffer.subarray(0, size));
}

/** The body of an answer we do not read: let go. */
const drop = async (response) => {
  try {
    await response.body?.cancel?.();
  } catch {
    // Nothing to do: the answer is refused anyway.
  }
};

/** An HTTP date header -> ms, undefined when absent or odd. */
function dateOf(response) {
  const raw = response.headers?.get?.('date');
  if (typeof raw !== 'string' || raw.length > 64) {
    return undefined;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : undefined;
}

/** Retry-After in seconds (or an HTTP date, against the Date of the answer) -> ms. */
function retryAfterOf(response) {
  const raw = response.headers?.get?.('retry-after');
  if (typeof raw !== 'string' || raw.length > 64) {
    return undefined;
  }
  if (/^\d{1,9}$/.test(raw.trim())) {
    return Number(raw.trim()) * 1000;
  }
  const at = Date.parse(raw);
  const now = dateOf(response);
  // A date without the clock of the cloud to compare: not used (the default pause applies).
  return Number.isFinite(at) && now !== undefined ? Math.max(0, at - now) : undefined;
}

/** JSON without the keys that could reach a prototype. */
export function parseJson(text) {
  try {
    return JSON.parse(text, (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value,
    );
  } catch {
    throw new InexogyError('bad_answer');
  }
}

export class InexogyClient {
  constructor({
    email,
    password,
    fetchImpl = (...args) => globalThis.fetch(...args),
    timeout = HTTP_TIMEOUT,
  }) {
    // Not enumerable: never in a JSON nor in an inspection of the client.
    Object.defineProperty(this, 'authorization', {
      value: `Basic ${Buffer.from(`${email}:${password}`, 'utf8').toString('base64')}`,
      enumerable: false,
    });
    this.fetch = fetchImpl;
    this.timeout = timeout;
    /** Requests one after the other, never two at once. */
    this.queue = Promise.resolve();
  }

  /**
   * One authenticated GET: `{ json, date }` for a 2xx answer (`json` null for
   * an empty body), an InexogyError otherwise.
   */
  get(path) {
    const run = async () => {
      try {
        const response = await this.fetch(`${API_BASE}${path}`, {
          method: 'GET',
          headers: { authorization: this.authorization, accept: 'application/json' },
          // A redirect is never followed: the password stays on this host.
          redirect: 'manual',
          // The whole answer, the body included, within the timeout.
          signal: AbortSignal.timeout(this.timeout),
        });
        const status = response.status;
        if (status === 429 || status >= 500) {
          await drop(response);
          throw new InexogyError(status === 429 ? 'rate_limited' : 'server', {
            status,
            retryAfter: retryAfterOf(response),
          });
        }
        if (status >= 300 && status < 400) {
          await drop(response);
          throw new InexogyError('redirect', { status });
        }
        if (status === 401 || status === 403) {
          await drop(response);
          throw new InexogyError(status === 401 ? 'unauthorized' : 'forbidden', { status });
        }
        if (status === 404) {
          await drop(response);
          throw new InexogyError('not_found', { status });
        }
        if (status < 200 || status >= 300) {
          await drop(response);
          throw new InexogyError('http', { status });
        }
        const text = await readBounded(response, MAX_BODY_BYTES);
        return { json: text.trim() === '' ? null : parseJson(text), date: dateOf(response) };
      } catch (err) {
        throw networkError(err);
      }
    };
    const job = this.queue.then(run, run);
    this.queue = job.catch(() => {});
    return job;
  }

  /**
   * The meters of the account: `{ meters, skipped, truncated }`. A 401 or a
   * 403 here is the account refused (`refused`, final).
   */
  async readMeters() {
    let answer;
    try {
      answer = await this.get('/meters');
    } catch (err) {
      if (err.code === 'unauthorized' || err.code === 'forbidden') {
        throw new InexogyError('refused', { status: err.status });
      }
      throw err;
    }
    const meters = parseMeters(answer.json);
    if (!meters) {
      throw new InexogyError('bad_answer');
    }
    return meters;
  }

  /**
   * The last reading of a meter: `{ reading, date }`, `reading` undefined
   * when inexogy has none (an empty answer). A 401 or 403 here concerns this
   * meter only (never the refusal of the account).
   */
  async readLastReading(meterId) {
    if (typeof meterId !== 'string' || !ID_PATTERN.test(meterId)) {
      throw new InexogyError('bad_answer');
    }
    const answer = await this.get(`/last_reading?meterId=${encodeURIComponent(meterId)}`);
    if (answer.json === null) {
      return { reading: undefined, date: answer.date };
    }
    const reading = parseReading(answer.json);
    if (!reading) {
      throw new InexogyError('bad_answer');
    }
    return { reading, date: answer.date };
  }
}
