// -----------------------------------------------------------------------------
// A fake inexogy API: `fetch` answers the routes the client uses from a
// scripted account (HTTP Basic checked), records every call (never kept
// outside the test), and can hold the answers back (a slow cloud) until the
// test releases them. Every answer carries a Date header from `cloud.now`.
// -----------------------------------------------------------------------------

export const EMAIL = 'meter@example.test';
export const PASSWORD = 'pa:ss w0rd!';
export const ELEC = 'f8d610b7a8cc4e73939fa33b990ded54';
export const GAS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const json = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** The error of AbortSignal.timeout. */
export const timeoutError = () => new DOMException('The operation timed out.', 'TimeoutError');

/** A default account: an electricity meter (three phases, injection) and a gas meter. */
export function account() {
  return {
    email: EMAIL,
    password: PASSWORD,
    meters: [
      {
        meterId: ELEC,
        manufacturerId: 'ESY',
        serialNumber: '123456789',
        fullSerialNumber: '1ESY123456789',
        location: {
          street: 'Beispielstr.',
          streetNumber: '22',
          zip: '56897',
          city: 'Testhausen',
          country: 'DE',
        },
        type: 'EASYMETER',
        measurementType: 'ELECTRICITY',
        loadProfileType: 'SLP',
      },
      {
        meterId: GAS,
        serialNumber: '987654',
        fullSerialNumber: '7ELS987654',
        type: 'ELSTER',
        measurementType: 'GAS',
      },
    ],
    readings: {
      [ELEC]: {
        time: null,
        values: {
          power: 685190,
          power1: 348230,
          power2: 211630,
          power3: 125330,
          voltage1: 230100,
          voltage2: 229800,
          voltage3: 231000,
          energy: 173123071191000,
          energyOut: 11500000000,
        },
      },
      [GAS]: { time: null, values: { volume: 17786454 } },
    },
  };
}

/**
 * `cloud.override(path)` may return a Response, 'timeout' or undefined (the
 * account answers). A reading with `time: null` is dated `cloud.now()`.
 */
export function createCloud(data = account()) {
  const cloud = {
    data,
    calls: [],
    now: () => Date.now(),
    override: () => undefined,
    hold: false,
    held: [],
    release() {
      const held = cloud.held;
      cloud.held = [];
      for (const resolve of held) resolve();
    },
    count: (re) => cloud.calls.filter((c) => re.test(c.path)).length,
    async fetch(url, init = {}) {
      const parsed = new URL(url);
      const path = `${parsed.pathname}${parsed.search}`;
      const call = { host: parsed.host, method: init.method ?? 'GET', path, init };
      cloud.calls.push(call);
      if (cloud.hold) {
        await new Promise((resolve) => cloud.held.push(resolve));
      }
      const special = cloud.override(path, init);
      if (special === 'timeout') throw timeoutError();
      if (special) return special;
      return cloud.answer(parsed, init);
    },
    answer(parsed, init) {
      const d = cloud.data;
      const date = { date: new Date(cloud.now()).toUTCString() };
      const expected = `Basic ${Buffer.from(`${d.email}:${d.password}`).toString('base64')}`;
      if (init.headers?.authorization !== expected) {
        return json(401, 'Unauthorized', date);
      }
      if (parsed.pathname === '/public/v1/meters') {
        return json(200, d.meters, date);
      }
      if (parsed.pathname === '/public/v1/last_reading') {
        const reading = d.readings[parsed.searchParams.get('meterId')];
        if (reading === undefined) return json(404, 'no meter', date);
        if (reading === '') return new Response('', { status: 200, headers: date });
        return json(200, { time: reading.time ?? cloud.now(), values: reading.values }, date);
      }
      return json(404, 'nope', date);
    },
  };
  return cloud;
}

export const response = json;
