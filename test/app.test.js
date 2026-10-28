// -----------------------------------------------------------------------------
// The integration against the fake Gladys and the fake inexogy API: devices,
// values, the index and its guard, the pace, the refusal, the pauses, late
// answers and what /data keeps.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { ELEC, EMAIL, GAS, PASSWORD, account, createCloud, response } from './helpers/fakeCloud.js';
import { CONFIG, D, F, HOUR, INDEX, MINUTE, NOW, created, setup } from './helpers/app.js';

const statusOf = (s) => s.gladys.fake.connectionStatus;
const reads = (s) => s.cloud.count(/^\/public\/v1\/last_reading/);
const lists = (s) => s.cloud.count(/^\/public\/v1\/meters/);
const setEnergy = (s, kwh) => {
  s.cloud.data.readings[ELEC].values.energy = Math.round(kwh * 1e10);
};

test('first read: one device per meter in Discovery, no value before creation', async () => {
  const s = await setup();
  await s.start();
  const devices = s.gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.external_id),
    [D(ELEC), D(GAS)],
  );
  const types = devices[0].features.map((f) => `${f.category}/${f.type}/${f.unit ?? ''}`);
  assert.deepEqual(types, [
    'energy-sensor/power/watt',
    'energy-sensor/index/kilowatt-hour',
    'unknown/decimal/',
    'unknown/decimal/',
    'unknown/decimal/',
    'unknown/decimal/',
    'energy-sensor/voltage/volt',
    'energy-sensor/voltage/volt',
    'energy-sensor/voltage/volt',
  ]);
  assert.deepEqual(
    devices[1].features.map((f) => `${f.category}/${f.type}/${f.unit}`),
    ['volume-sensor/decimal/cubicmeter'],
  );
  assert.equal(devices[0].name, 'inexogy electricity 123456789');
  // The location (a postal address) is never read.
  assert.doesNotMatch(JSON.stringify(devices), /Beispielstr|Testhausen|56897/);
  assert.equal(statusOf(s).connected, true);
  assert.match(statusOf(s).message.en, /2 meter\(s\)/);
  assert.match(statusOf(s).message.en, /Discover/);
  assert.equal(s.gladys.fake.states.length, 0);
});

test('created devices: the values, scaled as pydiscovergy reads them', async () => {
  const s = await setup({ devices: created() });
  await s.start();
  assert.deepEqual(s.statesOf(F(ELEC, 'power')), [685]);
  assert.deepEqual(s.statesOf(F(ELEC, 'power_l1')), [348]);
  assert.deepEqual(s.statesOf(F(ELEC, 'voltage_l3')), [231]);
  assert.deepEqual(s.statesOf(INDEX), [17312.307]);
  assert.deepEqual(s.statesOf(F(ELEC, 'injection_index')), [1.15]);
  assert.deepEqual(s.statesOf(F(GAS, 'gas_index')), [17786.454]);
  assert.doesNotMatch(statusOf(s).message.en, /Discover/);
});

test('one read per interval; the meter list once an hour', async () => {
  const s = await setup({ devices: created() });
  await s.start();
  assert.equal(lists(s), 1);
  assert.equal(reads(s), 2);
  await s.wait(30_000);
  assert.equal(reads(s), 2, 'never sooner than the interval');
  await s.wait(30_000);
  assert.equal(reads(s), 4);
  assert.equal(lists(s), 1);
  await s.wait(HOUR);
  assert.equal(lists(s), 2);
});

test('a reconnection, a save of the form or the Discover tab never read sooner', async () => {
  const s = await setup({ devices: created() });
  await s.start();
  const discovered = s.gladys.fake.discoveredDevices;
  await s.start();
  await s.app.scan();
  await s.start(CONFIG);
  await s.wait(10_000);
  assert.equal(reads(s), 2);
  // Status and Discovery published again at each start.
  assert.deepEqual(s.gladys.fake.discoveredDevices, discovered);
  assert.equal(statusOf(s).connected, true);
});

test('a restart of the container never reads sooner: the attempt is kept in /data', async () => {
  const store = createMemoryStore();
  const cloud = createCloud();
  const s = await setup({ store, cloud });
  await s.start();
  await s.app.stop();
  assert.equal(store.data.lastAttemptAt, NOW);
  const again = await setup({ store, cloud, now: NOW + 20_000 });
  await again.start();
  assert.equal(cloud.count(/meters/), 1);
  await again.wait(40_000);
  assert.equal(cloud.count(/meters/), 2);
});

test('the index: never 0, a jump held until two clicks, then exactly that value', async () => {
  const s = await setup({ devices: created(account(), { index: { value: 17312.307, at: NOW } }) });
  s.cloud.data.readings[ELEC].values.energy = 0;
  await s.start();
  assert.deepEqual(s.statesOf(INDEX), [], 'never 0');
  setEnergy(s, 22312.307);
  await s.wait(MINUTE);
  assert.deepEqual(s.statesOf(INDEX), [17312.307]);
  assert.match(statusOf(s).message.en, /held back.*17312\.307 -> 22312\.307 kWh/);
  for (let i = 0; i < 60; i += 1) await s.wait(MINUTE);
  assert.ok(
    s.statesOf(INDEX).every((v) => v === 17312.307),
    'never confirmed by time',
  );
  const first = await s.app.acceptHeldIndex();
  assert.match(first.en, /Nothing accepted yet/);
  await s.wait(MINUTE);
  assert.ok(s.statesOf(INDEX).every((v) => v === 17312.307));
  const second = await s.app.acceptHeldIndex();
  assert.match(second.en, /Accepted: inexogy electricity 123456789: 17312\.307 -> 22312\.307/);
  await s.wait(MINUTE);
  assert.equal(s.statesOf(INDEX).at(-1), 22312.307);
  assert.doesNotMatch(statusOf(s).message.en, /held back/);
});

test('a jump accepted, then the register back near the reference: held as a jump, two clicks take it', async () => {
  const s = await setup({ devices: created(account(), { index: { value: 17312.307, at: NOW } }) });
  setEnergy(s, 22312.307);
  await s.start();
  await s.app.acceptHeldIndex();
  await s.wait(MINUTE);
  const accepted = await s.app.acceptHeldIndex();
  assert.match(accepted.en, /Accepted: .*17312\.307 -> 22312\.307/);
  // The register comes back before the next read: never a drop, never published.
  setEnergy(s, 17312.4);
  await s.wait(MINUTE);
  assert.ok(s.statesOf(INDEX).every((v) => v === 17312.307));
  assert.match(statusOf(s).message.en, /held back.*17312\.307 -> 17312\.4 kWh/);
  assert.doesNotMatch(statusOf(s).message.en, /drop/);
  const first = await s.app.acceptHeldIndex();
  assert.match(first.en, /Nothing accepted yet/);
  await s.wait(MINUTE);
  const second = await s.app.acceptHeldIndex();
  assert.match(second.en, /Accepted: .*17312\.307 -> 17312\.4/);
  await s.wait(MINUTE);
  assert.equal(s.statesOf(INDEX).at(-1), 17312.4);
  assert.doesNotMatch(statusOf(s).message.en, /held back/);
});

test('a drop is held and never accepted; it ends when the register comes back', async () => {
  const s = await setup({ devices: created(account(), { index: { value: 17312.307, at: NOW } }) });
  setEnergy(s, 10);
  await s.start();
  assert.deepEqual(s.statesOf(INDEX), [17312.307]);
  assert.match(statusOf(s).message.en, /a drop: never accepted/);
  const answer = await s.app.acceptHeldIndex();
  assert.match(answer.en, /never accepted/);
  setEnergy(s, 17312.4);
  await s.wait(MINUTE);
  assert.equal(s.statesOf(INDEX).at(-1), 17312.4);
  assert.doesNotMatch(statusOf(s).message.en, /held back/);
});

test('a held index survives a restart; a save of the form accepts nothing', async () => {
  const store = createMemoryStore();
  const cloud = createCloud();
  cloud.data.readings[ELEC].values.energy = Math.round(22312.307 * 1e10);
  const devices = created(account(), { index: { value: 17312.307, at: NOW } });
  const s = await setup({ devices, store, cloud });
  await s.start();
  await s.start(CONFIG);
  await s.app.stop();
  assert.ok(store.data.indexes[INDEX].guard.held);
  const again = await setup({ devices, store, cloud, now: NOW + 10 * MINUTE });
  await again.start();
  await again.wait(MINUTE);
  assert.ok(again.statesOf(INDEX).every((v) => v === 17312.307));
  assert.match(statusOf(again).message.en, /held back/);
});

test('refused credentials: final, kept in /data, no new try by itself', async () => {
  const store = createMemoryStore();
  const cloud = createCloud();
  cloud.data.password = 'other';
  const s = await setup({ store, cloud });
  await s.start();
  assert.equal(statusOf(s).connected, false);
  assert.match(statusOf(s).message.en, /refused the login \(HTTP 401\)/);
  await s.wait(6 * HOUR);
  assert.equal(cloud.calls.length, 1, 'never tried again by itself');
  // After a restart too.
  await s.app.stop();
  const again = await setup({ store, cloud, now: NOW + 7 * HOUR });
  await again.start();
  await again.wait(HOUR);
  assert.equal(cloud.calls.length, 1);
  assert.match(statusOf(again).message.en, /refused the login/);
  // The test button: one try (the interval has passed), still refused.
  const answer = await again.app.testConnection();
  assert.match(answer.en, /refused the login/);
  assert.equal(cloud.calls.length, 2);
  // The right password at inexogy: the next test works and the refusal is erased.
  cloud.data.password = PASSWORD;
  const soon = await again.app.testConnection();
  assert.match(soon.en, /One more try is possible in/);
  await again.advance(MINUTE);
  const ok = await again.app.testConnection();
  assert.match(ok.en, /Read now: 2 meter\(s\)/);
  assert.equal(store.data.refused, null);
  await again.wait(MINUTE);
  assert.ok(cloud.count(/last_reading/) >= 4, 'reads go on');
});

test('other credentials saved: a new try, never sooner than the interval', async () => {
  const cloud = createCloud();
  const s = await setup({ cloud, config: { ...CONFIG, password: 'wrong' } });
  await s.start();
  assert.equal(cloud.calls.length, 1);
  await s.start(CONFIG);
  assert.equal(cloud.calls.length, 1);
  await s.wait(MINUTE);
  assert.equal(statusOf(s).connected, true);
  assert.ok(cloud.count(/last_reading/) >= 2);
});

test('/data never holds the password, the e-mail nor an address', async () => {
  const store = createMemoryStore();
  const cloud = createCloud();
  cloud.data.password = 'other';
  const s = await setup({ store, cloud, devices: created() });
  await s.start();
  const text = JSON.stringify(store.data);
  for (const secret of [PASSWORD, EMAIL, 'Beispielstr', 'Testhausen', '123456789']) {
    assert.ok(!text.includes(secret), secret);
  }
  for (const line of s.lines) {
    assert.ok(!line.includes(PASSWORD) && !line.includes(EMAIL), line);
  }
});

test('429: a pause kept in /data, Retry-After bounded, no request meanwhile', async () => {
  const store = createMemoryStore();
  const cloud = createCloud();
  cloud.override = (path) =>
    path.startsWith('/public/v1/meters')
      ? response(429, 'slow down', { 'retry-after': '999999' })
      : undefined;
  const s = await setup({ store, cloud });
  await s.start();
  assert.match(statusOf(s).message.en, /asks to wait \(too many requests\).*6 h/);
  assert.equal(store.data.pause.until, NOW + 6 * HOUR);
  cloud.override = () => undefined;
  await s.wait(5 * HOUR);
  assert.equal(cloud.calls.length, 1);
  // A restart keeps it.
  await s.app.stop();
  const again = await setup({ store, cloud, now: NOW + 5 * HOUR });
  await again.start();
  assert.equal(cloud.calls.length, 1);
  assert.match(await again.app.testConnection().then((t) => t.en), /asks to wait/);
  await again.wait(HOUR + MINUTE);
  assert.ok(cloud.calls.length > 1);
  assert.equal(statusOf(again).connected, true);
});

test('a 5xx on one meter: the other meter goes on; on every meter: a pause', async () => {
  const cloud = createCloud();
  cloud.override = (path) => (path.includes(`meterId=${GAS}`) ? response(503, 'busy') : undefined);
  const s = await setup({ cloud, devices: created() });
  await s.start();
  assert.deepEqual(s.statesOf(INDEX), [17312.307]);
  assert.deepEqual(s.statesOf(F(GAS, 'gas_index')), []);
  assert.match(statusOf(s).message.en, /1 meter\(s\) not read this time/);
  cloud.override = (path) => (path.includes('last_reading') ? response(500, 'down') : undefined);
  await s.wait(MINUTE);
  assert.match(statusOf(s).message.en, /asks to wait \(error of the cloud 500\)/);
});

test('a password changed at inexogy: the next read asks the list, then stops', async () => {
  const cloud = createCloud();
  const s = await setup({ cloud, devices: created() });
  await s.start();
  assert.equal(lists(s), 1);
  cloud.data.password = 'changed';
  await s.wait(MINUTE);
  assert.equal(lists(s), 1);
  await s.wait(MINUTE);
  assert.equal(lists(s), 2, 'the meter list at once, not an hour later');
  assert.match(statusOf(s).message.en, /refused the login/);
  const calls = cloud.calls.length;
  await s.wait(2 * HOUR);
  assert.equal(cloud.calls.length, calls);
});

test('review 1, I1: a device created again right after a restart starts afresh', async () => {
  const store = createMemoryStore();
  const devices = created(account(), { index: { value: 17312.307, at: NOW } });
  const s = await setup({ devices, store });
  await s.start();
  setEnergy(s, 5);
  await s.wait(MINUTE);
  assert.ok(store.data.indexes[INDEX].guard.held, 'the drop is held');
  await s.gladys.fake.deviceDeleted(s.gladys.devices.find((d) => d.external_id === D(ELEC)));
  await s.app.stop();
  // A restart; the user creates the meter again before the first read.
  const fresh = created();
  const again = await setup({
    devices: fresh.filter((d) => d.external_id !== D(ELEC)),
    store,
    cloud: s.cloud,
    now: NOW + MINUTE + 1000,
  });
  setEnergy(again, 5);
  again.gladys.onDeviceCreated((d) => again.app.onDeviceCreated(d));
  await again.app.start(CONFIG);
  await again.gladys.fake.deviceCreated(fresh.find((d) => d.external_id === D(ELEC)));
  assert.equal(store.data.indexes?.[INDEX], undefined, 'the old guard is erased');
  await again.wait(2 * MINUTE);
  assert.deepEqual(again.statesOf(INDEX), [5]);
  assert.doesNotMatch(statusOf(again).message.en, /held back/);
});

test('review 1, I1: a device of another integration or a bad id is ignored', async () => {
  const s = await setup();
  await s.start();
  assert.equal(s.app.isMeterId(D(ELEC)), true);
  assert.equal(s.app.isMeterId('ext:other:meter:abc'), false);
  assert.equal(s.app.isMeterId(`${D('a')}/../x`), false);
  assert.equal(s.app.isMeterId(undefined), false);
});

test('review 1, M1: readings refused while the list answers: spaced, "access refused"', async () => {
  const cloud = createCloud();
  cloud.override = (path) => (path.includes('last_reading') ? response(403, 'no') : undefined);
  const s = await setup({ cloud, devices: created() });
  await s.start();
  for (let i = 0; i < 30; i += 1) await s.wait(MINUTE);
  // The list asked once more after the first refusal, then never before the hour.
  assert.equal(lists(s), 2);
  // 2 meters, refused at 1, 2, 4, 8, 16 min intervals: far fewer than 2 a minute.
  assert.ok(reads(s) <= 12, `${reads(s)} refused readings in 30 min`);
  assert.match(statusOf(s).message.en, /Access refused to 2 meter\(s\)/);
  assert.equal(statusOf(s).connected, true);
  cloud.override = () => undefined;
  await s.wait(HOUR);
  assert.doesNotMatch(statusOf(s).message.en, /Access refused/);
});

test('review 1, M3: a wall clock set back never makes a pause longer than 6 h', async () => {
  const cloud = createCloud();
  cloud.override = () => response(429, 'slow down', { 'retry-after': '21600' });
  const s = await setup({ cloud });
  await s.start();
  cloud.override = () => undefined;
  s.app.now = () => s.clock.now - 24 * HOUR;
  assert.ok(s.app.pauseLeft() <= 6 * HOUR);
  await s.app.updateStatus();
  assert.match(statusOf(s).message.en, /6 h/);
  await s.wait(6 * HOUR + MINUTE);
  assert.ok(cloud.calls.length > 1);
});

test('a network failure: retries doubled from the interval', async () => {
  const cloud = createCloud();
  cloud.override = () => 'timeout';
  const s = await setup({ cloud });
  await s.start();
  assert.match(statusOf(s).message.en, /could not be read \(no answer\): new try in 1 min/);
  await s.wait(MINUTE);
  assert.match(statusOf(s).message.en, /new try in 2 min/);
  assert.equal(cloud.calls.length, 2);
});

test('a stale reading (inexogy clock): no power, the counters still', async () => {
  const cloud = createCloud();
  cloud.data.readings[ELEC].time = NOW - HOUR;
  const s = await setup({ cloud, devices: created() });
  await s.start();
  assert.deepEqual(s.statesOf(F(ELEC, 'power')), []);
  assert.deepEqual(s.statesOf(F(ELEC, 'voltage_l1')), []);
  assert.deepEqual(s.statesOf(INDEX), [17312.307]);
  assert.match(statusOf(s).message.en, /more than 15 minutes old/);
});

test('without a Date header, a reading is never called stale', async () => {
  const cloud = createCloud();
  cloud.data.readings[ELEC].time = NOW - HOUR;
  cloud.override = (path) =>
    path.includes(`meterId=${ELEC}`)
      ? new Response(JSON.stringify(cloud.data.readings[ELEC]), { status: 200 })
      : undefined;
  const s = await setup({ cloud, devices: created() });
  await s.start();
  assert.deepEqual(s.statesOf(F(ELEC, 'power')), [685]);
});

test('a late answer of a former account publishes nothing and sets no status', async () => {
  const cloud = createCloud();
  const s = await setup({ cloud, devices: created() });
  cloud.hold = true;
  const first = s.app.start(CONFIG);
  await s.advance(0);
  await first;
  // The user saves another account while the read waits.
  await s.app.start({ email: 'other@example.test', password: 'x' });
  const statuses = s.gladys.fake.connectionStatus;
  cloud.hold = false;
  cloud.release();
  await s.app.idle();
  assert.deepEqual(s.gladys.fake.states, []);
  assert.deepEqual(s.gladys.fake.connectionStatus, statuses);
});

test('a created device never loses a feature in Discovery', async () => {
  const devices = created();
  const cloud = createCloud();
  delete cloud.data.readings[ELEC].values.energyOut;
  delete cloud.data.readings[ELEC].values.power3;
  const s = await setup({ cloud, devices });
  await s.start();
  const elec = s.gladys.fake.discoveredDevices.find((d) => d.external_id === D(ELEC));
  const keys = elec.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(keys.includes('injection_index'));
  assert.ok(keys.includes('power_l3'));
});

test('an unsupported meter is listed in the status, not read', async () => {
  const cloud = createCloud();
  cloud.data.meters.push({ meterId: 'heat1', measurementType: 'HEAT', serialNumber: '1' });
  cloud.data.meters.push({ measurementType: 'ELECTRICITY' });
  const s = await setup({ cloud });
  await s.start();
  assert.equal(cloud.count(/meterId=heat1/), 0);
  assert.match(statusOf(s).message.en, /1 meter\(s\) of a kind/);
  assert.match(statusOf(s).message.en, /1 meter\(s\) without a usable identifier/);
});

test('incomplete form: a status, no request', async () => {
  const cloud = createCloud();
  const s = await setup({ cloud, config: { email: EMAIL } });
  await s.start();
  assert.equal(statusOf(s).connected, false);
  assert.match(statusOf(s).message.en, /Enter the e-mail/);
  assert.equal(cloud.calls.length, 0);
});

test('every request goes to api.inexogy.com in HTTPS, GET only, no User-Agent of ours', async () => {
  const cloud = createCloud();
  const s = await setup({ cloud, devices: created() });
  await s.start();
  for (const call of cloud.calls) {
    assert.equal(call.host, 'api.inexogy.com');
    assert.equal(call.method, 'GET');
    assert.equal(call.init.redirect, 'manual');
    assert.ok(!Object.keys(call.init.headers).some((h) => /user-agent/i.test(h)));
  }
});
