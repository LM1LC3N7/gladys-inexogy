// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, external id type, feature keys in src/devices.js) is
// forever: never rename one.
// -----------------------------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection', ACCEPT_HELD: 'accept_held_index' };

/**
 * External ids (forever): `ext:<selector>:meter:<meterId>`, the `meterId`
 * inexogy gives the meter (`/meters`). A meter without a usable id (missing,
 * or not 1 to 64 letters, digits, `_` or `-`) gets no device: it is counted
 * in the status, never guessed.
 */
export const DEVICE_TYPE = 'meter';
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The kinds of meter read (`measurementType` of /meters); any other is listed, not read. */
export const KINDS = { ELECTRICITY: 'ELECTRICITY', GAS: 'GAS', WATER: 'WATER' };

// --- The inexogy API (as the pydiscovergy library reads it) ---------------------------
export const API_HOST = 'api.inexogy.com';
export const API_BASE = `https://${API_HOST}/public/v1`;
/** pydiscovergy waits 10 s per request; so do we, the body included. */
export const HTTP_TIMEOUT = 10_000;
/** The meter list and a reading are a few KiB: more is not an answer. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Meters read at most per account. */
export const MAX_METERS = 10;
/** The longest text kept from an answer (a serial number, a type). */
export const MAX_TEXT = 64;
/** Values kept at most from one reading (the fields we know are far fewer). */
export const MAX_VALUES = 200;

// --- Schedule ------------------------------------------------------------------------
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** One read every `poll_minutes`: 1 by default, 1 at least, 60 at most. */
export const POLL_DEFAULT_MIN = 1;
export const POLL_MIN_MIN = 1;
export const POLL_MAX_MIN = 60;
/** The meter list is read again after this delay (a meter added or removed). */
export const METERS_INTERVAL = HOUR;
/** A failed read (network, odd answer): the next try doubles from the interval, up to this. */
export const RETRY_MAX = HOUR;
/** HTTP 429 or 5xx: a pause from 1 min to 6 h, kept in /data, for every request. */
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** The time of the last read is written in /data at most once per this delay. */
export const ATTEMPT_SAVE_EVERY = MINUTE;
/** Unchanged values are sent again after this delay (publishChangedStates heartbeat). */
export const STATE_HEARTBEAT = 10 * MINUTE;
/** The test button answers within this delay (the manifest gives it 30 s). */
export const TEST_ANSWER_WITHIN = 20 * SECOND;
/** The second click of "Accept the held index" must come within this delay of the first. */
export const ACCEPT_CONFIRM_WITHIN = 5 * MINUTE;
/**
 * A reading older than this, measured against the clock of inexogy (its
 * `Date` header), is stale: its power, voltages and phases are not sent.
 * Without a readable `Date`, a reading is never called stale.
 */
export const LIVE_STALE_AFTER = 15 * MINUTE;
/** States sent to Gladys at most per minute (the core refuses more: 300), all meters together. */
export const STATES_PER_MINUTE = 280;

// --- Values ----------------------------------------------------------------------------
/** Scales of the raw values (pydiscovergy / Home Assistant): mW, mV, 1e-10 kWh, 1e-3 m³. */
export const SCALE = { POWER: 1000, VOLTAGE: 1000, ENERGY: 10_000_000_000, VOLUME: 1000 };
/** A power above this (W) is a glitch: not published. */
export const POWER_MAX = 1_000_000;
/** A voltage above this (V) is a glitch: not published. */
export const VOLTAGE_MAX = 1000;
/** A counter above this (kWh or m³) is a glitch: never published. */
export const COUNTER_MAX = 1_000_000_000;

// --- Plausibility of the electricity index (the one Gladys bills) --------------------
/** A home never draws more than this on average between two reads (kW). */
export const INDEX_MAX_KW = 100;
/** kWh always accepted on top of INDEX_MAX_KW × hours (rounding, a late read). */
export const INDEX_SLACK_KWH = 0.5;
/** Index states kept in /data at most. */
export const MAX_KEPT_INDEXES = 256;
