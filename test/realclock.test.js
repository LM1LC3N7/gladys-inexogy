// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local HTTP server playing the inexogy API: the reads really start, at 0,
// the interval and twice the interval, with a bounded number of timers. The
// time is sped up 100 times (a minute of the interval is 600 ms) but it is the
// real clock: it moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { InexogyApp } from '../src/app.js';
import { API_BASE, POLL_DEFAULT_MIN } from '../src/constants.js';
import { InexogyClient } from '../src/inexogy/client.js';
import { createMemoryStore } from '../src/store.js';
import { ELEC, EMAIL, PASSWORD, account } from './helpers/fakeCloud.js';

const SPEED = 100;
const POLL_INTERVAL = POLL_DEFAULT_MIN * 60_000;

test('real clock: reads at 0, the interval and twice the interval; timers bounded', async () => {
  const data = account();
  /** The reads of the electricity meter (the meter list is read hourly, apart). */
  const reads = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1`);
    let body;
    if (url.pathname === '/public/v1/meters') body = data.meters;
    if (url.pathname === '/public/v1/last_reading') {
      const id = url.searchParams.get('meterId');
      if (id === ELEC) reads.push(performance.now() * SPEED);
      body = { time: Date.now(), values: data.readings[id].values };
    }
    const date = new Date().toUTCString();
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json', date });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / SPEED);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const config = { email: EMAIL, password: PASSWORD };
  // The client reaches the local server instead of the inexogy API.
  const fetchImpl = (url, init) =>
    fetch(String(url).replace(API_BASE, `http://127.0.0.1:${port}/public/v1`), init);
  const gladys = createFakeGladys({ selector: 'inexogy', config });
  await gladys.connect();
  const quiet = () => {};
  const app = new InexogyApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => Date.now() * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: createMemoryStore(),
    clientFactory: (options) => new InexogyClient({ ...options, fetchImpl }),
  });
  const started = performance.now() * SPEED;
  try {
    await app.start(config);
    // Counted from the first read (a cold start of fetch takes a few ms).
    const deadline = started + POLL_INTERVAL;
    while (reads.length === 0 && performance.now() * SPEED < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const until = (reads[0] ?? started) + 2.5 * POLL_INTERVAL;
    while (performance.now() * SPEED < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await app.stop();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const at = reads.map((t) => Math.round(t - started));
  assert.equal(reads.length, 3, `reads at ${at}`);
  assert.ok(reads[0] - started < POLL_INTERVAL / 2, `the first read at once: ${at}`);
  for (let i = 1; i < reads.length; i += 1) {
    const gap = reads[i] - reads[i - 1];
    // Seen by the server: the latency of the request before (a cold fetch
    // takes a few real ms, times SPEED) may shorten the gap seen here.
    assert.ok(gap >= 0.9 * POLL_INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap < 1.5 * POLL_INTERVAL, `on time: ${at}`);
  }
  assert.ok(timersSet <= 10, `${timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
