// -----------------------------------------------------------------------------
// The answers of the inexogy API, read into plain values. Pure.
//
// After pydiscovergy (`Meter`, `Reading`) and the Home Assistant integration
// that uses it (the field names and their scales), see
// THIRD_PARTY_NOTICES.md:
// - a meter: `meterId`, `measurementType` (ELECTRICITY, GAS, WATER...),
//   `type` (the make, e.g. EASYMETER), `serialNumber`, `fullSerialNumber`.
//   Its `location` (a postal address) is never read;
// - a reading: `time` (ms) and `values`, raw integers: power in mW, voltage
//   in mV, energy in 1e-10 kWh, volume in 1e-3 m³.
// A missing value is never read as 0. Only own keys are read, the arrays are
// walked once, the texts bounded.
// -----------------------------------------------------------------------------

import { ID_PATTERN, KINDS, MAX_METERS, MAX_TEXT, MAX_VALUES, SCALE } from '../constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** A short printable text, else undefined. */
export function textOf(value) {
  if (typeof value !== 'string' && !finite(value)) {
    return undefined;
  }
  const text = String(value).trim();
  return text.length > 0 && text.length <= MAX_TEXT && /^[\x20-\x7e]+$/.test(text)
    ? text
    : undefined;
}

/** A usable meter id, else undefined. */
export const idOf = (value) =>
  typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined;

/** One meter of /meters, or undefined without a usable id. */
export function parseMeter(raw) {
  if (!isObject(raw)) {
    return undefined;
  }
  const id = idOf(own(raw, 'meterId'));
  if (!id) {
    return undefined;
  }
  const kind = textOf(own(raw, 'measurementType'))?.toUpperCase();
  return {
    id,
    kind: kind ?? 'UNKNOWN',
    make: textOf(own(raw, 'type')),
    serial: textOf(own(raw, 'serialNumber')),
    fullSerial: textOf(own(raw, 'fullSerialNumber')),
  };
}

/**
 * The answer of /meters: `{ meters, skipped, truncated }`, or undefined when
 * it is not a list. At most MAX_METERS meters; one id once.
 */
export function parseMeters(json) {
  if (!Array.isArray(json)) {
    return undefined;
  }
  const meters = [];
  const seen = new Set();
  let skipped = 0;
  let truncated = false;
  for (const raw of json) {
    const meter = parseMeter(raw);
    if (!meter) {
      skipped += 1;
      continue;
    }
    if (seen.has(meter.id)) {
      continue;
    }
    if (meters.length >= MAX_METERS) {
      truncated = true;
      break;
    }
    seen.add(meter.id);
    meters.push(meter);
  }
  return { meters, skipped, truncated };
}

/**
 * A reading: `{ time, values }`, `time` in ms (undefined when not readable),
 * `values` the finite numbers only (a null-prototype object, at most
 * MAX_VALUES keys); undefined when it is not a reading.
 */
export function parseReading(json) {
  if (!isObject(json)) {
    return undefined;
  }
  const rawValues = own(json, 'values');
  if (!isObject(rawValues)) {
    return undefined;
  }
  const values = Object.create(null);
  let count = 0;
  for (const [key, value] of Object.entries(rawValues)) {
    if (count >= MAX_VALUES) {
      break;
    }
    if (finite(value) && /^[A-Za-z0-9]{1,40}$/.test(key)) {
      values[key] = value;
      count += 1;
    }
  }
  const time = own(json, 'time');
  return { time: finite(time) && time > 0 ? time : undefined, values };
}

const scaled = (values, key, scale) => (finite(values[key]) ? values[key] / scale : undefined);
/** The first of `keys` present (Home Assistant's alternative keys), scaled. */
const firstOf = (values, keys, scale) => {
  for (const key of keys) {
    if (finite(values[key])) {
      return values[key] / scale;
    }
  }
  return undefined;
};

/**
 * The values of a reading of an electricity meter, in W, V and kWh:
 * `{ power, phasePower: [3], voltage: [3], energy, energy1, energy2, energyOut }`.
 * `energy` is the meter's own total register, never a sum of the tariffs.
 */
export function electricityOf(reading) {
  const v = reading?.values ?? Object.create(null);
  return {
    power: scaled(v, 'power', SCALE.POWER),
    phasePower: [1, 2, 3].map((n) => firstOf(v, [`power${n}`, `phase${n}Power`], SCALE.POWER)),
    voltage: [1, 2, 3].map((n) => firstOf(v, [`voltage${n}`, `phase${n}Voltage`], SCALE.VOLTAGE)),
    energy: scaled(v, 'energy', SCALE.ENERGY),
    energy1: scaled(v, 'energy1', SCALE.ENERGY),
    energy2: scaled(v, 'energy2', SCALE.ENERGY),
    energyOut: scaled(v, 'energyOut', SCALE.ENERGY),
  };
}

/** The volume of a gas or water meter, in m³. */
export const volumeOf = (reading) =>
  scaled(reading?.values ?? Object.create(null), 'volume', SCALE.VOLUME);

/** What a meter shows it gives: nothing until a reading says so. */
export const NO_CAPABILITIES = Object.freeze({
  power: false,
  phases: 0,
  voltage: 0,
  consumption: false,
  tariffs: false,
  injection: false,
  volume: false,
});

const positive = (value) => finite(value) && value > 0;

/**
 * The capabilities a reading shows for a meter of `kind`. A counter counts
 * only once above 0 (a meter without injection answers `energyOut: 0`).
 */
export function capabilitiesOf(kind, reading) {
  if (!reading) {
    return { ...NO_CAPABILITIES };
  }
  if (kind === KINDS.ELECTRICITY) {
    const e = electricityOf(reading);
    const last = (list) => list.reduce((n, value, i) => (finite(value) ? i + 1 : n), 0);
    return {
      ...NO_CAPABILITIES,
      power: finite(e.power),
      phases: last(e.phasePower),
      voltage: last(e.voltage),
      consumption: positive(e.energy),
      tariffs: positive(e.energy1) || positive(e.energy2),
      injection: positive(e.energyOut),
    };
  }
  if (kind === KINDS.GAS || kind === KINDS.WATER) {
    return { ...NO_CAPABILITIES, volume: positive(volumeOf(reading)) };
  }
  return { ...NO_CAPABILITIES };
}

/** Both capabilities together: what one shows stays (never fewer features). */
export function mergeCapabilities(a, b) {
  if (!a) return b ? { ...NO_CAPABILITIES, ...b } : undefined;
  if (!b) return { ...NO_CAPABILITIES, ...a };
  return {
    power: Boolean(a.power || b.power),
    phases: Math.max(a.phases ?? 0, b.phases ?? 0),
    voltage: Math.max(a.voltage ?? 0, b.voltage ?? 0),
    consumption: Boolean(a.consumption || b.consumption),
    tariffs: Boolean(a.tariffs || b.tariffs),
    injection: Boolean(a.injection || b.injection),
    volume: Boolean(a.volume || b.volume),
  };
}

/** Whether `next` shows something `known` does not. */
export const bringsNew = (known, next) =>
  JSON.stringify(mergeCapabilities(known, next)) !==
  JSON.stringify(mergeCapabilities(known, undefined));
