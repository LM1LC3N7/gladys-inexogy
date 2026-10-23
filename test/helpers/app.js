// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, the fake inexogy API and a virtual
// clock (the same for the wall clock and the monotonic one).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { InexogyApp } from '../../src/app.js';
import { buildMeter } from '../../src/devices.js';
import { InexogyClient } from '../../src/inexogy/client.js';
import { capabilitiesOf, parseMeters, parseReading } from '../../src/inexogy/model.js';
import { createMemoryStore } from '../../src/store.js';
import { ELEC, EMAIL, PASSWORD, account, createCloud } from './fakeCloud.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'inexogy';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const NOW = Date.parse('2026-10-22T10:05:00Z');
export const CONFIG = { email: EMAIL, password: PASSWORD };
export const F = (id, key) => `ext:${SELECTOR}:meter:${id}:${key}`;
export const D = (id) => `ext:${SELECTOR}:meter:${id}`;
export const INDEX = F(ELEC, 'consumption_index');

const fakeExternal = createFakeGladys({ selector: SELECTOR });

/**
 * The devices as the user created them from the account `data`. `index`:
 * `{ value, at }` Gladys holds for the consumption index.
 */
export function created(data = account(), { index } = {}) {
  const devices = [];
  for (const meter of parseMeters(data.meters).meters) {
    const raw = data.readings[meter.id];
    const reading = raw ? parseReading({ time: 1, values: raw.values }) : undefined;
    const device = buildMeter(fakeExternal, meter, capabilitiesOf(meter.kind, reading));
    if (device) devices.push(device);
  }
  if (index) {
    const feature = devices
      .flatMap((d) => d.features)
      .find((f) => f.external_id.endsWith(':consumption_index'));
    feature.last_value = index.value;
    feature.last_value_changed = new Date(index.at).toISOString();
  }
  return devices;
}

export async function setup({
  devices = [],
  store = createMemoryStore(),
  now = NOW,
  cloud = createCloud(),
  config = CONFIG,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const { clock, timers, advance } = createFakeClock(now);
  cloud.now = () => clock.now;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new InexogyApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.now,
    monotonic: () => clock.now,
    timers,
    store,
    clientFactory: (options) => new InexogyClient({ ...options, fetchImpl: cloud.fetch }),
  });
  const start = async (cfg = config) => {
    await app.start(cfg);
    await advance(0);
    await app.idle();
  };
  const wait = async (ms) => {
    await advance(ms);
    await app.idle();
  };
  /** The states published for a feature, in order. */
  const statesOf = (id) =>
    gladys.fake.states.filter((s) => s.device_feature_external_id === id).map((s) => s.state);
  return { app, gladys, clock, store, cloud, start, wait, advance, lines, statesOf };
}
