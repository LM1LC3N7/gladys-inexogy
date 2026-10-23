// -----------------------------------------------------------------------------
// The Gladys devices of an inexogy account (one per meter) and their states.
// Pure.
//
// External ids (forever): `ext:<selector>:meter:<meterId>` (src/constants.js);
// feature keys (forever): FEATURE below.
//
// Energy rules of the Gladys core (server/utils/constants.js and the
// energy-monitoring service), as in gladys-p1-monitor and gladys-youless:
// - `consumption_index` is the ONLY energy-sensor / index feature: the
//   meter's own total register (`energy`), checked by the guard
//   (src/guard.js), never 0; the core derives the consumption and its cost
//   from its deltas, by itself. Never a sum of the tariffs, never the
//   injection, never a daily total;
// - the tariff registers (`energy1`, `energy2`) and the injection
//   (`energyOut`) are plain sensors, kWh in the name: as indexes they would
//   be counted a second time, or billed;
// - gas and water are NEVER in the energy monitoring (the core would price
//   them at the electricity tariff, and publishEnergyConsumption is never
//   called): volume sensors in m³;
// - `power` is the only energy-sensor / power feature (the energy contracts
//   read the first one for the peaks), signed as inexogy gives it; the
//   power of each phase is a plain sensor;
// - units: only the ones the core lists for the category
//   (DEVICE_FEATURE_UNITS_BY_CATEGORY): W, V, kWh for energy-sensor, m³ for
//   volume-sensor, none for unknown (the unit is then in the name).
// Read-only: no feature is ever writable, no switch.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { COUNTER_MAX, DEVICE_TYPE, KINDS, POWER_MAX, VOLTAGE_MAX } from './constants.js';
import { NO_CAPABILITIES } from './inexogy/model.js';

/** Feature keys (forever). */
export const FEATURE = {
  POWER: 'power',
  CONSUMPTION_INDEX: 'consumption_index',
  CONSUMPTION_T1: 'consumption_t1',
  CONSUMPTION_T2: 'consumption_t2',
  INJECTION_INDEX: 'injection_index',
  GAS: 'gas_index',
  WATER: 'water_index',
  phasePower: (n) => `power_l${n}`,
  phaseVoltage: (n) => `voltage_l${n}`,
};

/** The external ids of a meter. */
export const ids = (gladys, meterId) => gladys.externalIds(DEVICE_TYPE, meterId);

const feature = (external, key, name, category, type, extra = {}) => ({
  name,
  external_id: external.feature(key),
  category,
  type,
  min: 0,
  max: COUNTER_MAX,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

/** A value shown, never summed nor billed: no energy category, no unit (it is in the name). */
const plain = (external, key, name, extra = {}) =>
  feature(external, key, name, C.UNKNOWN, T.SENSOR.DECIMAL, extra);

const KIND_NAME = {
  [KINDS.ELECTRICITY]: 'electricity',
  [KINDS.GAS]: 'gas',
  [KINDS.WATER]: 'water',
};

/** The device name: never the location of the meter (a postal address). */
export function nameOf(meter) {
  const label = KIND_NAME[meter.kind] ?? 'meter';
  return `inexogy ${label} ${meter.serial ?? meter.fullSerial ?? meter.id}`;
}

/**
 * The device of a meter, with the features its capabilities show
 * (src/inexogy/model.js capabilitiesOf). The features are fixed when the
 * user creates it. Undefined when the meter shows nothing we can publish.
 */
export function buildMeter(gladys, meter, capabilities) {
  const external = ids(gladys, meter.id);
  const caps = { ...NO_CAPABILITIES, ...capabilities };
  const features = [];
  if (meter.kind === KINDS.ELECTRICITY) {
    if (caps.power) {
      features.push(
        feature(
          external,
          FEATURE.POWER,
          'Power (as inexogy gives it)',
          C.ENERGY_SENSOR,
          T.ENERGY_SENSOR.POWER,
          { unit: U.WATT, min: -POWER_MAX, max: POWER_MAX },
        ),
      );
    }
    if (caps.consumption) {
      features.push(
        feature(
          external,
          FEATURE.CONSUMPTION_INDEX,
          'Consumption index',
          C.ENERGY_SENSOR,
          T.ENERGY_SENSOR.INDEX,
          { unit: U.KILOWATT_HOUR },
        ),
      );
    }
    if (caps.tariffs) {
      features.push(
        plain(external, FEATURE.CONSUMPTION_T1, 'Consumption index, tariff 1 (kWh)'),
        plain(external, FEATURE.CONSUMPTION_T2, 'Consumption index, tariff 2 (kWh)'),
      );
    }
    if (caps.injection) {
      features.push(plain(external, FEATURE.INJECTION_INDEX, 'Injection index (kWh)'));
    }
    for (let n = 1; n <= Math.min(3, caps.phases); n += 1) {
      // Live values: no history unless the user turns it on.
      features.push(
        plain(external, FEATURE.phasePower(n), `Power L${n} (W, as inexogy gives it)`, {
          min: -POWER_MAX,
          max: POWER_MAX,
          keep_history: false,
        }),
      );
    }
    for (let n = 1; n <= Math.min(3, caps.voltage); n += 1) {
      features.push(
        feature(
          external,
          FEATURE.phaseVoltage(n),
          `Voltage L${n}`,
          C.ENERGY_SENSOR,
          T.ENERGY_SENSOR.VOLTAGE,
          { unit: U.VOLT, max: VOLTAGE_MAX, keep_history: false },
        ),
      );
    }
  } else if ((meter.kind === KINDS.GAS || meter.kind === KINDS.WATER) && caps.volume) {
    const gas = meter.kind === KINDS.GAS;
    features.push(
      feature(
        external,
        gas ? FEATURE.GAS : FEATURE.WATER,
        gas ? 'Gas index' : 'Water index',
        C.VOLUME_SENSOR,
        T.VOLUME_SENSOR.DECIMAL,
        { unit: U.CUBIC_METER },
      ),
    );
  }
  if (features.length === 0) {
    return undefined;
  }
  return {
    name: nameOf(meter),
    external_id: external.device,
    features,
    params: [
      { name: 'meter_id', value: meter.id },
      { name: 'kind', value: meter.kind },
      ...(meter.fullSerial ? [{ name: 'serial', value: meter.fullSerial }] : []),
      ...(meter.make ? [{ name: 'make', value: meter.make }] : []),
    ],
  };
}

/**
 * The capabilities a CREATED device carries (its features): the device
 * published again never has fewer features than the one the user created.
 */
export function capabilitiesOfDevice(device) {
  const keys = new Set(
    (device?.features ?? []).map((f) =>
      String(f?.external_id ?? '')
        .split(':')
        .at(-1),
    ),
  );
  if (keys.size === 0) {
    return undefined;
  }
  const last = (key) => [1, 2, 3].reduce((n, i) => (keys.has(key(i)) ? i : n), 0);
  return {
    power: keys.has(FEATURE.POWER),
    phases: last(FEATURE.phasePower),
    voltage: last(FEATURE.phaseVoltage),
    consumption: keys.has(FEATURE.CONSUMPTION_INDEX),
    tariffs: keys.has(FEATURE.CONSUMPTION_T1) || keys.has(FEATURE.CONSUMPTION_T2),
    injection: keys.has(FEATURE.INJECTION_INDEX),
    volume: keys.has(FEATURE.GAS) || keys.has(FEATURE.WATER),
  };
}

/** What a feature declaration holds (a created feature also carries Gladys' own fields). */
const DECLARED = [
  'id',
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'energy_parent_id',
];

/**
 * A device republished in Discovery never loses a feature of the device the
 * user created (the core would mark it `structure_changed`, and "Update"
 * would delete that feature and its history): the features of the created
 * device that the new build lacks are kept as they are (gladys-hypontech).
 */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => f?.external_id && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return kept.length === 0 ? built : { ...built, features: [...built.features, ...kept] };
}

export const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const state = (external, key, value, digits) =>
  isNumber(value)
    ? [{ device_feature_external_id: external.feature(key), state: round(value, digits) }]
    : [];

/** A value within [min, max], else undefined (a glitch, not sent). */
export const within = (value, max, min = 0) =>
  isNumber(value) && value >= min && value <= max ? value : undefined;

/** A counter: never 0 (nor below), never absurd. */
const counter = (external, key, value) =>
  isNumber(value) && value > 0 && value <= COUNTER_MAX ? state(external, key, value, 3) : [];

/** The live values of an electricity meter: power, phases, voltages. */
export function liveStates(external, e) {
  return [
    ...state(external, FEATURE.POWER, within(e.power, POWER_MAX, -POWER_MAX), 0),
    ...e.phasePower.flatMap((p, i) =>
      state(external, FEATURE.phasePower(i + 1), within(p, POWER_MAX, -POWER_MAX), 0),
    ),
    ...e.voltage.flatMap((v, i) =>
      state(external, FEATURE.phaseVoltage(i + 1), within(v, VOLTAGE_MAX), 1),
    ),
  ];
}

/**
 * The counters of an electricity meter. `consumptionIndex`: the value the
 * IndexGuard let through (undefined: not sent this time).
 */
export function electricityCounters(external, e, consumptionIndex) {
  return [
    ...counter(external, FEATURE.CONSUMPTION_INDEX, consumptionIndex),
    ...counter(external, FEATURE.CONSUMPTION_T1, e.energy1),
    ...counter(external, FEATURE.CONSUMPTION_T2, e.energy2),
    ...counter(external, FEATURE.INJECTION_INDEX, e.energyOut),
  ];
}

/** The index of a gas or water meter (m³), never 0. */
export const volumeStates = (external, kind, volume) =>
  counter(external, kind === KINDS.GAS ? FEATURE.GAS : FEATURE.WATER, volume);
