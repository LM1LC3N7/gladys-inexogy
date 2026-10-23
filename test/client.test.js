// -----------------------------------------------------------------------------
// The client: HTTP Basic, the codes of the answers, bounded bodies, no
// redirect, no secret in an error.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InexogyClient, parseJson, readBounded } from '../src/inexogy/client.js';
import { ELEC, EMAIL, PASSWORD, createCloud, response } from './helpers/fakeCloud.js';

const client = (cloud) =>
  new InexogyClient({ email: EMAIL, password: PASSWORD, fetchImpl: cloud.fetch });

test('HTTP Basic with the e-mail and the password (a colon in the password kept)', async () => {
  const cloud = createCloud();
  const { meters } = await client(cloud).readMeters();
  assert.equal(meters.length, 2);
  const header = cloud.calls[0].init.headers.authorization;
  assert.equal(
    Buffer.from(header.replace('Basic ', ''), 'base64').toString(),
    `${EMAIL}:${PASSWORD}`,
  );
});

test('the password is never enumerable nor in an error', async () => {
  const c = client(createCloud());
  assert.ok(!JSON.stringify(c).includes('Basic'));
  const cloud = createCloud();
  cloud.data.password = 'x';
  const err = await client(cloud)
    .readMeters()
    .catch((e) => e);
  assert.equal(err.code, 'refused');
  assert.equal(err.status, 401);
  assert.ok(err.final);
  assert.ok(!String(err.message).includes(PASSWORD) && !String(err.stack).includes(PASSWORD));
});

test('a 403 on the meter list is a refusal; on a reading it is not', async () => {
  const cloud = createCloud();
  cloud.override = () => response(403, 'no');
  assert.equal(
    (
      await client(cloud)
        .readMeters()
        .catch((e) => e)
    ).code,
    'refused',
  );
  const err = await client(cloud)
    .readLastReading(ELEC)
    .catch((e) => e);
  assert.equal(err.code, 'forbidden');
  assert.ok(!err.final);
});

test('429 and 5xx carry Retry-After; a redirect is never followed', async () => {
  const cloud = createCloud();
  cloud.override = () => response(429, '', { 'retry-after': '120' });
  let err = await client(cloud)
    .readMeters()
    .catch((e) => e);
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.retryAfter, 120_000);
  cloud.override = () =>
    response(503, '', {
      'retry-after': 'Thu, 22 Oct 2026 10:10:00 GMT',
      date: 'Thu, 22 Oct 2026 10:05:00 GMT',
    });
  err = await client(cloud)
    .readMeters()
    .catch((e) => e);
  assert.equal(err.code, 'server');
  assert.equal(err.retryAfter, 5 * 60_000, 'against the clock of the cloud');
  cloud.override = () => new Response('', { status: 302, headers: { location: 'https://x' } });
  err = await client(cloud)
    .readMeters()
    .catch((e) => e);
  assert.equal(err.code, 'redirect');
  assert.equal(cloud.calls.at(-1).init.redirect, 'manual');
});

test('a body too large is refused; a non-JSON body is a bad answer', async () => {
  const cloud = createCloud();
  cloud.override = () => response(200, 'x'.repeat(300 * 1024));
  assert.equal(
    (
      await client(cloud)
        .readMeters()
        .catch((e) => e)
    ).code,
    'too_large',
  );
  cloud.override = () => response(200, '<html>');
  assert.equal(
    (
      await client(cloud)
        .readMeters()
        .catch((e) => e)
    ).code,
    'bad_answer',
  );
  cloud.override = () => response(200, { meters: [] });
  assert.equal(
    (
      await client(cloud)
        .readMeters()
        .catch((e) => e)
    ).code,
    'bad_answer',
  );
});

test('a timeout and a network error in our words', async () => {
  const cloud = createCloud();
  cloud.override = () => 'timeout';
  assert.equal(
    (
      await client(cloud)
        .readMeters()
        .catch((e) => e)
    ).code,
    'timeout',
  );
  const failing = new InexogyClient({
    email: EMAIL,
    password: PASSWORD,
    fetchImpl: async () => {
      throw new TypeError(`fetch failed ${PASSWORD}`);
    },
  });
  const err = await failing.readMeters().catch((e) => e);
  assert.equal(err.code, 'unreachable');
  assert.ok(!err.message.includes(PASSWORD));
});

test('a reading: its values and the Date of inexogy; an empty answer is no reading', async () => {
  const cloud = createCloud();
  cloud.now = () => Date.parse('2026-10-22T10:05:00Z');
  const { reading, date } = await client(cloud).readLastReading(ELEC);
  assert.equal(reading.values.power, 685190);
  assert.equal(date, Date.parse('2026-10-22T10:05:00Z'));
  cloud.data.readings[ELEC] = '';
  const empty = await client(cloud).readLastReading(ELEC);
  assert.equal(empty.reading, undefined);
  await assert.rejects(client(cloud).readLastReading('../meters'), { code: 'bad_answer' });
});

test('one request at a time', async () => {
  const cloud = createCloud();
  let running = 0;
  let most = 0;
  const inner = cloud.fetch;
  cloud.fetch = async (...args) => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return await inner(...args);
    } finally {
      running -= 1;
    }
  };
  const c = new InexogyClient({ email: EMAIL, password: PASSWORD, fetchImpl: cloud.fetch });
  await Promise.all([c.readMeters(), c.readLastReading(ELEC), c.readMeters()]);
  assert.equal(most, 1);
});

test('parseJson drops the keys that could reach a prototype', () => {
  const parsed = parseJson('{"__proto__":{"x":1},"constructor":2,"a":3}');
  assert.equal(parsed.a, 3);
  assert.equal({}.x, undefined);
  assert.ok(!Object.hasOwn(parsed, 'constructor'));
});

test('readBounded reads into one buffer, up to the limit', async () => {
  const text = await readBounded(new Response('héllo'), 16);
  assert.equal(text, 'héllo');
  await assert.rejects(readBounded(new Response('x'.repeat(17)), 16), { code: 'too_large' });
});
