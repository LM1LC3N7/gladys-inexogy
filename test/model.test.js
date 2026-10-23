// -----------------------------------------------------------------------------
// The answers of inexogy read into plain values, and the devices built from
// them (pure).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  bringsNew,
  capabilitiesOf,
  electricityOf,
  mergeCapabilities,
  parseMeters,
  parseReading,
  volumeOf,
} from '../src/inexogy/model.js';
import {
  FEATURE,
  buildMeter,
  capabilitiesOfDevice,
  electricityCounters,
  ids,
  liveStates,
  volumeStates,
} from '../src/devices.js';
import { MAX_METERS } from '../src/constants.js';
import { account } from './helpers/fakeCloud.js';

const gladys = createFakeGladys({ selector: 'inexogy' });

test('the meters: id, kind, serial; never the location; bounded', () => {
  const { meters, skipped, truncated } = parseMeters(account().meters);
  assert.equal(skipped, 0);
  assert.equal(truncated, false);
  assert.deepEqual(meters[0], {
    id: 'f8d610b7a8cc4e73939fa33b990ded54',
    kind: 'ELECTRICITY',
    make: 'EASYMETER',
    serial: '123456789',
    fullSerial: '1ESY123456789',
  });
  const many = Array.from({ length: 30 }, (_, i) => ({
    meterId: `m${i}`,
    measurementType: 'GAS',
  }));
  const bounded = parseMeters([...many, { meterId: 'bad id' }, 7, { meterId: 'm1' }]);
  assert.equal(bounded.meters.length, MAX_METERS);
  assert.equal(bounded.truncated, true);
  assert.equal(parseMeters({}), undefined);
  assert.equal(parseMeters([{ meterId: 'x'.repeat(65) }]).skipped, 1);
});

test('a reading: finite numbers only, own keys, a null prototype', () => {
  const reading = parseReading(
    JSON.parse('{"time":5,"values":{"power":1,"x":"2","y":null,"__proto__":{"z":1}}}'),
  );
  assert.equal(reading.time, 5);
  assert.deepEqual(Object.keys(reading.values), ['power']);
  assert.equal(Object.getPrototypeOf(reading.values), null);
  assert.equal(parseReading({ time: 1 }), undefined);
  assert.equal(parseReading([]), undefined);
  assert.equal(parseReading({ values: {} }).time, undefined);
});

test('scales of Home Assistant: mW, mV, 1e-10 kWh, 1e-3 m³; alternative keys', () => {
  const e = electricityOf(
    parseReading({
      time: 1,
      values: {
        power: -1500000,
        phase1Power: 100000,
        phase2Voltage: 230500,
        energy: 12345670000000,
        energy1: 1e10,
        energyOut: 0,
      },
    }),
  );
  assert.equal(e.power, -1500);
  assert.deepEqual(e.phasePower, [100, undefined, undefined]);
  assert.deepEqual(e.voltage, [undefined, 230.5, undefined]);
  assert.equal(e.energy, 1234.567);
  assert.equal(e.energy1, 1);
  assert.equal(e.energyOut, 0);
  assert.equal(volumeOf(parseReading({ time: 1, values: { volume: 1234 } })), 1.234);
});

test('the index is the meter register only, never a sum of tariffs', () => {
  const e = electricityOf(parseReading({ time: 1, values: { energy1: 5e13, energy2: 5e13 } }));
  assert.equal(e.energy, undefined);
  assert.equal(capabilitiesOf('ELECTRICITY', { values: { energy1: 5e13 } }).consumption, false);
});

test('capabilities: counters count above 0 only; they only grow', () => {
  const caps = capabilitiesOf('ELECTRICITY', {
    values: { power: 0, energy: 1e13, energyOut: 0, voltage1: 1, voltage2: 1, power3: 2 },
  });
  assert.deepEqual(caps, {
    power: true,
    phases: 3,
    voltage: 2,
    consumption: true,
    tariffs: false,
    injection: false,
    volume: false,
  });
  const merged = mergeCapabilities(caps, { ...caps, injection: true, phases: 1 });
  assert.equal(merged.injection, true);
  assert.equal(merged.phases, 3);
  assert.equal(bringsNew(caps, { ...caps, phases: 1 }), false);
  assert.equal(bringsNew(caps, { ...caps, tariffs: true }), true);
  assert.equal(bringsNew(undefined, caps), true);
  assert.equal(capabilitiesOf('GAS', { values: { volume: 0 } }).volume, false);
  assert.equal(capabilitiesOf('HEAT', { values: { energy: 1 } }).consumption, false);
});

test('devices: units of the core, one index, gas out of the energy monitoring', () => {
  const [elec, gas] = parseMeters(account().meters).meters;
  const device = buildMeter(gladys, elec, {
    power: true,
    consumption: true,
    tariffs: true,
    injection: true,
    phases: 3,
    voltage: 3,
  });
  const indexes = device.features.filter((f) => f.type === 'index');
  assert.equal(indexes.length, 1);
  assert.equal(
    indexes[0].external_id,
    'ext:inexogy:meter:f8d610b7a8cc4e73939fa33b990ded54:consumption_index',
  );
  for (const f of device.features) {
    assert.equal(f.read_only, true);
    assert.notEqual(f.category, 'switch');
    if (f.category === 'unknown') assert.equal(f.unit, undefined);
  }
  assert.deepEqual(capabilitiesOfDevice(device), {
    power: true,
    phases: 3,
    voltage: 3,
    consumption: true,
    tariffs: true,
    injection: true,
    volume: false,
  });
  const g = buildMeter(gladys, gas, { volume: true });
  assert.deepEqual(
    g.features.map((f) => [f.category, f.type, f.unit]),
    [['volume-sensor', 'decimal', 'cubicmeter']],
  );
  assert.equal(buildMeter(gladys, gas, {}), undefined);
  assert.equal(buildMeter(gladys, { ...gas, kind: 'HEAT' }, { volume: true }), undefined);
});

test('states: never 0 nor absurd for a counter; glitches dropped', () => {
  const external = ids(gladys, 'm1');
  const e = {
    power: 2_000_000,
    phasePower: [-100, undefined, 5],
    voltage: [5000, 230.04, undefined],
    energy1: 0,
    energy2: 3,
    energyOut: Number.NaN,
  };
  assert.deepEqual(
    liveStates(external, e).map((s) => [s.device_feature_external_id.split(':').at(-1), s.state]),
    [
      ['power_l1', -100],
      ['power_l3', 5],
      ['voltage_l2', 230],
    ],
  );
  assert.deepEqual(
    electricityCounters(external, e, 0).map((s) => s.device_feature_external_id.split(':').at(-1)),
    [FEATURE.CONSUMPTION_T2],
  );
  assert.deepEqual(volumeStates(external, 'WATER', 0), []);
  assert.equal(volumeStates(external, 'WATER', 1.23456)[0].state, 1.235);
});
