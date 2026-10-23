// -----------------------------------------------------------------------------
// The integration itself: the inexogy account read every `poll_minutes` (1 by
// default), one device per meter, the consumption index checked by its guard,
// the pauses and the refusal kept in /data, the test and accept buttons.
// index.js only wires the SDK handlers to it. Read-only: nothing is ever sent
// to inexogy but GETs.
//
// The pace is global and kept across restarts: never two reads less than an
// interval apart, whatever asks (a reconnection, a save of the form, the test
// button, the Discover tab, a device created, a restart of the container: the
// time of the last read is kept in /data, written BEFORE the read).
//
// A read belongs to its session (the client of one account): when the
// account changes, a late answer of the old one publishes nothing and sets no
// status (checked after every await). One read at a time: a new account waits
// for the end of the old read.
//
// Credentials refused by inexogy (401 or 403 on the meter list): final, kept
// in /data as a salted fingerprint, no new try by itself; other credentials
// saved, or the test button (one try, never sooner than the interval), and the
// refusal is erased only by an answer that accepts them.
//
// The created devices are read from `gladys.devices`, which the SDK keeps up
// to date: never a copy of our own.
//
// Two clocks: `now` (wall clock) dates the index and what /data keeps;
// `monotonic` paces the reads, so that a wall clock set back never stops them.
// The age of a reading is measured on the clock of inexogy (its Date header).
// After gladys-hypontech (approved), with the guard of gladys-p1-monitor.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { isComplete, normalizeConfig } from './config.js';
import {
  ACCEPT_CONFIRM_WITHIN,
  ATTEMPT_SAVE_EVERY,
  INDEX_MAX_KW,
  INDEX_SLACK_KWH,
  ID_PATTERN,
  KINDS,
  LIVE_STALE_AFTER,
  MAX_KEPT_INDEXES,
  METERS_INTERVAL,
  PAUSE_MAX,
  PAUSE_MIN,
  RETRY_MAX,
  STATE_HEARTBEAT,
  STATES_PER_MINUTE,
  TEST_ANSWER_WITHIN,
} from './constants.js';
import {
  FEATURE,
  buildMeter,
  capabilitiesOfDevice,
  electricityCounters,
  ids,
  keepCreatedFeatures,
  liveStates,
  nameOf,
  round,
  volumeStates,
} from './devices.js';
import { IndexGuard } from './guard.js';
import { T } from './i18n.js';
import { InexogyClient, InexogyError } from './inexogy/client.js';
import { capabilitiesOf, electricityOf, mergeCapabilities, volumeOf } from './inexogy/model.js';
import { createFileStore, credentialsHash } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };
const MINUTE = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;
const SUPPORTED = new Set(Object.values(KINDS));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The index Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** A pause read back from /data: `{ until, count, code, status }`, its end capped from now. */
function validPause(pause, now) {
  if (
    !isObject(pause) ||
    !finite(pause.until) ||
    !Number.isInteger(pause.count) ||
    pause.count < 1 ||
    (pause.code !== 'rate_limited' && pause.code !== 'server')
  ) {
    return undefined;
  }
  return {
    until: Math.min(pause.until, now + PAUSE_MAX),
    count: Math.min(pause.count, 32),
    code: pause.code,
    status: Number.isInteger(pause.status) ? pause.status : null,
  };
}

/** The refusal read back from /data: `{ hash, at, status }`. */
const validRefused = (refused, now) =>
  isObject(refused) && typeof refused.hash === 'string' && HEX64.test(refused.hash)
    ? {
        hash: refused.hash,
        at: finite(refused.at) ? Math.min(refused.at, now) : now,
        status: Number.isInteger(refused.status) ? refused.status : null,
      }
    : undefined;

/** The index states kept in /data: plain objects under string keys only. */
function keptIndexes(indexes) {
  if (!isObject(indexes)) {
    return {};
  }
  const kept = {};
  for (const [key, value] of Object.entries(indexes)) {
    if (key !== '__proto__' && key.length <= 200 && isObject(value)) {
      kept[key] = value;
    }
  }
  return kept;
}

/** The consumption register of a reading as an index: above 0, 3 decimals, else undefined. */
const indexOf = (energy) => (finite(energy) && energy > 0 ? round(energy, 3) : undefined);

export class InexogyApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'inexogy' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    clientFactory = (options) => new InexogyClient(options),
    store = createFileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.clientFactory = clientFactory;
    /** /data: salt, pace, pause, refusal, index guards. */
    this.store = store;
    this.savedKey = undefined;
    this.config = normalizeConfig();
    /** `{ client }` of the current account; replaced (never reused) when the account changes. */
    this.session = undefined;
    this.running = false;
    this.timer = undefined;
    this.busy = undefined;
    this.loopRun = Promise.resolve();
    this.lifecycle = Promise.resolve();
    this.lastStatus = undefined;

    const kept = store.load();
    const at = now();
    this.salt =
      typeof kept.salt === 'string' && HEX64.test(kept.salt)
        ? kept.salt
        : randomBytes(32).toString('hex');
    this.pause = validPause(kept.pause, at);
    this.refused = validRefused(kept.refused, at);
    // The last read before a restart: the next one never comes sooner than
    // the interval (a date in the future, a clock set back, is brought to now).
    this.lastAttemptAt = finite(kept.lastAttemptAt) ? Math.min(kept.lastAttemptAt, at) : undefined;
    this.savedAttemptAt = this.lastAttemptAt;
    /** Monotonic time of the last read started. */
    this.lastReadAt =
      this.lastAttemptAt === undefined ? undefined : monotonic() - (at - this.lastAttemptAt);
    /** By index feature external id: IndexGuard and its label. */
    this.guards = new Map();
    this.labels = new Map();
    /** States sent to Gladys: `[{ at (monotonic), count }]`, the last minute. */
    this.sent = [];
    this.pendingAccept = undefined;
    this.resetReads();
  }

  /** What belongs to one account: forgotten when it changes. */
  resetReads() {
    /** The last read: `{ at (monotonic), kind: 'ok' | 'error', count?, err? }`. */
    this.outcome = undefined;
    /** The meter list: `{ meters, skipped, truncated }`, and when (monotonic) it was read. */
    this.meterList = undefined;
    this.meterListAt = undefined;
    /** The last read: `{ entries: [{ meter, reading, date, failed, stale }] }`. */
    this.data = undefined;
    /** By meter id: what its readings showed, only grows. */
    this.caps = new Map();
    /** By meter id: a reading refused (401/403), `{ count, nextAt (monotonic) }`. */
    this.denied = new Map();
    /** The meter list was asked again after every reading was refused (once per streak). */
    this.listRechecked = false;
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    this.notes = freshNotes();
    this.discoveredKey = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  stop() {
    return this.serialize(() => this.doStop());
  }

  /** Resolves once every queued start/stop and the read running are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.loopRun;
    await this.busy;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async doStart(raw) {
    this.doStop();
    const config = normalizeConfig(raw);
    const first = this.session === undefined;
    const changed =
      first || config.email !== this.config.email || config.password !== this.config.password;
    this.config = config;
    if (changed) {
      const session = {};
      session.client = isComplete(config)
        ? this.clientFactory({ email: config.email, password: config.password })
        : undefined;
      this.session = session;
      if (!first) {
        // Another account: its own story. The pace stays (never two reads
        // less than an interval apart), and so does a pause of the cloud.
        this.resetReads();
      }
    }
    this.pendingAccept = undefined;
    this.running = true;
    // The core keeps the connection status, the Discovery list and the last
    // values in memory: a restarted Gladys has lost them, so they are always
    // sent again (the values at the next read).
    this.lastStatus = undefined;
    this.discoveredKey = undefined;
    this.gladys.forgetPublishedStates?.();
    if (!this.session.client) {
      await this.setStatus(false, T.incomplete);
      return;
    }
    await this.discover();
    await this.updateStatus();
    this.schedule();
  }

  doStop() {
    this.running = false;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  // --- Pace ------------------------------------------------------------------

  interval() {
    return this.config.pollMinutes * MINUTE;
  }

  /** The credentials of the configuration are the ones inexogy refused. */
  isRefused() {
    return Boolean(
      this.refused &&
      this.session?.client &&
      this.refused.hash === credentialsHash(this.salt, this.config),
    );
  }

  /** The monotonic time from which the next read may start (pace, retries, pause). */
  dueAt() {
    const mono = this.monotonic();
    let due = this.lastReadAt === undefined ? mono : this.lastReadAt + this.interval();
    if (this.nextTryAt !== undefined) {
      due = Math.max(due, this.nextTryAt);
    }
    const now = this.now();
    if (this.pause && now < this.pause.until) {
      due = Math.max(due, mono + this.pauseLeft(now));
    }
    return due;
  }

  /**
   * The time left in the pause, never above PAUSE_MAX at each use (review 1,
   * M3): a wall clock set back never makes it longer.
   */
  pauseLeft(now = this.now()) {
    if (!this.pause) {
      return 0;
    }
    if (this.pause.until - now > PAUSE_MAX) {
      this.pause = { ...this.pause, until: now + PAUSE_MAX };
    }
    return Math.max(0, this.pause.until - now);
  }

  /** One timer: the next read when it is due; none while the credentials are refused. */
  schedule() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.running || !this.session?.client || this.isRefused()) {
      return;
    }
    const wait = Math.max(0, this.dueAt() - this.monotonic());
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.loopRun = this.loop();
      return this.loopRun;
    }, wait);
  }

  async loop() {
    const session = this.session;
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(`inexogy: unexpected error (${err?.name ?? 'Error'})`);
    }
    if (session === this.session && this.running) {
      this.schedule();
    }
  }

  /**
   * One read when it is due; a read running is never doubled. A read of a
   * former account is let finish (it publishes nothing), then this one runs.
   */
  tick(options) {
    if (this.busy) {
      if (this.busySession === this.session) {
        return this.busy;
      }
      return this.busy.then(() => this.tick(options));
    }
    this.busySession = this.session;
    this.busy = this.read(options).finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  /** `retryRefused`: the test button's one try with refused credentials. */
  async read({ retryRefused = false } = {}) {
    const session = this.session;
    const client = session?.client;
    if (!client || !this.running) {
      return;
    }
    const refused = this.isRefused();
    if (refused && !retryRefused) {
      return;
    }
    const mono = this.monotonic();
    if (mono < this.dueAt()) {
      return;
    }
    /** Another account (or a stop) during an await: this read gives up, silently. */
    const gone = () => session !== this.session || !this.running;
    this.lastReadAt = mono;
    // Kept BEFORE the requests: a restart during them never reads again sooner.
    await this.saveAttempt(this.now());
    if (gone()) return;
    // The meter list: at the first read, every METERS_INTERVAL, and for the
    // one try of refused credentials (the refusal comes from it).
    if (refused || !this.meterList || mono - this.meterListAt >= METERS_INTERVAL) {
      let list;
      try {
        list = await client.readMeters();
      } catch (err) {
        if (gone()) return;
        await this.failed(err, mono, gone);
        return;
      }
      if (gone()) return;
      this.meterList = list;
      this.meterListAt = mono;
      await this.accepted(session);
      if (gone()) return;
    }
    const entries = [];
    let unsupported = 0;
    let stopped;
    let serverErrors = 0;
    let authErrors = 0;
    let attempted = 0;
    let lastServer;
    for (const meter of this.meterList.meters) {
      if (!SUPPORTED.has(meter.kind)) {
        unsupported += 1;
        continue;
      }
      const entry = { meter, reading: undefined, date: undefined, failed: false, stale: false };
      entries.push(entry);
      if (stopped) {
        // The account is limited: no more requests in this read.
        entry.failed = true;
        continue;
      }
      const denied = this.denied.get(meter.id);
      if (denied && mono < denied.nextAt) {
        // Access refused to this meter: asked again later, spaced (review 1, M1).
        entry.failed = true;
        entry.denied = true;
        continue;
      }
      attempted += 1;
      try {
        const { reading, date } = await client.readLastReading(meter.id);
        entry.reading = reading;
        entry.date = date;
        this.denied.delete(meter.id);
      } catch (err) {
        if (gone()) return;
        entry.failed = true;
        this.logger.warn(
          `inexogy reading of a meter unavailable (${err?.code ?? 'error'}${Number.isInteger(err?.status) ? ` ${err.status}` : ''})`,
        );
        if (err?.code === 'rate_limited') {
          stopped = err;
        } else if (err?.code === 'server') {
          serverErrors += 1;
          lastServer = err;
        } else if (err?.code === 'unauthorized' || err?.code === 'forbidden') {
          authErrors += 1;
          entry.denied = true;
          // Spaced: the interval, doubled at each refusal, up to 1 h.
          const count = Math.min((denied?.count ?? 0) + 1, 32);
          this.denied.set(meter.id, {
            count,
            nextAt: mono + Math.min(this.interval() * 2 ** (count - 1), RETRY_MAX),
          });
        }
      }
      if (gone()) return;
    }
    if (!stopped && entries.length > 0 && serverErrors === entries.length) {
      // Every meter answered 5xx: the cloud is down, a pause for all.
      stopped = lastServer;
    }
    if (attempted > 0 && authErrors === attempted && !this.listRechecked) {
      // Every meter read refused (a password changed at inexogy since the
      // list was read): the meter list is asked ONCE at the next read, where
      // a refusal is final. If it still answers, the readings stay spaced.
      this.meterListAt = Number.NEGATIVE_INFINITY;
      this.listRechecked = true;
    } else if (attempted > authErrors) {
      this.listRechecked = false;
    }
    await this.succeeded(entries, { unsupported }, mono, gone, stopped);
  }

  async saveAttempt(now) {
    this.lastAttemptAt = now;
    if (
      this.savedAttemptAt === undefined ||
      now < this.savedAttemptAt ||
      now - this.savedAttemptAt >= ATTEMPT_SAVE_EVERY
    ) {
      this.savedAttemptAt = now;
      await this.saveState();
    }
  }

  /**
   * inexogy accepted the credentials of the current account: the refusal (of
   * these credentials or of former ones) is erased at once: /data never keeps
   * the fingerprint of a refused password after a success.
   */
  async accepted(session) {
    if (session !== this.session || !this.refused) {
      return;
    }
    this.refused = undefined;
    await this.saveState();
  }

  // --- Outcomes ----------------------------------------------------------------

  async succeeded(entries, { unsupported }, mono, gone, stopped) {
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    if (stopped) {
      // The meter list answered, a reading asked to wait: published, then paused.
      this.setPause(stopped);
    } else {
      this.pause = undefined;
    }
    let stale = 0;
    let empty = 0;
    for (const entry of entries) {
      const { meter, reading, date } = entry;
      // Stale only against the clock of inexogy; without it, never.
      entry.stale =
        reading?.time !== undefined && date !== undefined && date - reading.time > LIVE_STALE_AFTER;
      if (entry.stale && meter.kind === KINDS.ELECTRICITY) stale += 1;
      if (reading) {
        this.caps.set(
          meter.id,
          mergeCapabilities(this.caps.get(meter.id), capabilitiesOf(meter.kind, reading)),
        );
      }
    }
    this.data = { entries };
    for (const entry of entries) {
      if (!this.buildOf(entry.meter)) empty += 1;
    }
    this.notes = {
      ...freshNotes(),
      failing: entries.filter((e) => e.failed && !e.denied).length,
      denied: entries.filter((e) => e.denied).length,
      truncated: this.meterList.truncated,
      skipped: this.meterList.skipped,
      unsupported: unsupported + empty,
      stale,
    };
    this.outcome = { at: mono, kind: 'ok', count: this.meterList.meters.length };
    await this.discover();
    if (gone()) return;
    await this.publishAll(gone);
    if (gone()) return;
    await this.saveState();
    if (gone()) return;
    await this.updateStatus();
  }

  setPause(err) {
    const count = (this.pause?.count ?? 0) + 1;
    const asked = finite(err.retryAfter) ? err.retryAfter : PAUSE_MIN * 2 ** (count - 1);
    const wait = Math.min(Math.max(asked, PAUSE_MIN), PAUSE_MAX);
    this.pause = {
      until: this.now() + wait,
      count: Math.min(count, 32),
      code: err.code,
      status: Number.isInteger(err.status) ? err.status : null,
    };
  }

  async failed(err, mono, gone) {
    const code = err?.code ?? 'error';
    // Our own words only (InexogyError codes): never a text of the cloud.
    this.logger.warn(
      `inexogy read failed: ${code}${Number.isInteger(err?.status) ? ` ${err.status}` : ''}`,
    );
    this.outcome = { at: mono, kind: 'error', err };
    if (err instanceof InexogyError && err.final) {
      // Refused credentials: final, kept in /data, no new try by itself.
      this.refused = {
        hash: credentialsHash(this.salt, this.config),
        at: this.now(),
        status: Number.isInteger(err.status) ? err.status : null,
      };
      this.failures = 0;
      this.nextTryAt = undefined;
      this.lastError = undefined;
      await this.saveState();
      if (gone()) return;
      await this.updateStatus();
      return;
    }
    if (code === 'rate_limited' || code === 'server') {
      this.setPause(err);
      await this.saveState();
      if (gone()) return;
      await this.updateStatus();
      return;
    }
    // Network, odd answer: retries doubled from the interval.
    const wait = Math.min(this.interval() * 2 ** this.failures, RETRY_MAX);
    this.failures += 1;
    this.lastError = err;
    this.nextTryAt = mono + wait;
    await this.updateStatus();
  }

  // --- Status ------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async updateStatus() {
    const [connected, message] = this.currentStatus();
    await this.setStatus(connected, message);
  }

  /** The status from what is known now: never a read. */
  currentStatus() {
    if (!this.session?.client) {
      return [false, T.incomplete];
    }
    if (this.isRefused()) {
      return [false, T.refused(this.refused.status)];
    }
    const held = this.heldItems();
    const notes = held.length > 0 ? [T.notes.held(held)] : [];
    const now = this.now();
    if (this.pause && now < this.pause.until) {
      return [false, T.paused(this.pause, this.pauseLeft(now), notes)];
    }
    if (this.lastError && this.failures > 0) {
      const wait = Math.max(0, (this.nextTryAt ?? 0) - this.monotonic());
      return [false, T.unreachable(this.lastError, wait, notes)];
    }
    if (!this.data || !this.meterList) {
      return [true, T.waiting(Math.max(0, this.dueAt() - this.monotonic()))];
    }
    if (this.meterList.meters.length === 0 && this.meterList.skipped === 0) {
      return [true, T.noMeter];
    }
    const extra = [];
    if (this.createdDevices().length === 0) extra.push(T.notes.noDevice);
    if (this.notes.denied > 0) extra.push(T.notes.denied(this.notes.denied));
    if (this.notes.failing > 0) extra.push(T.notes.failing(this.notes.failing));
    if (this.notes.truncated) extra.push(T.notes.truncated);
    if (this.notes.skipped > 0) extra.push(T.notes.skipped(this.notes.skipped));
    if (this.notes.unsupported > 0) extra.push(T.notes.unsupported(this.notes.unsupported));
    if (this.notes.stale > 0) extra.push(T.notes.stale(this.notes.stale));
    if (this.notes.budget) extra.push(T.notes.budget);
    return [true, T.ok(this.meterList.meters.length, [...extra, ...notes])];
  }

  // --- /data -------------------------------------------------------------------------

  /** The feature external ids of every created device. */
  createdFeatureIds() {
    const set = new Set();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        if (typeof feature?.external_id === 'string') set.add(feature.external_id);
      }
    }
    return set;
  }

  /**
   * Keeps the salt, the pace, the pause, the refusal and the guards in /data
   * when they changed. Never the state of an index of a created device nor a
   * value held is dropped: only the entries of features no device has.
   */
  async saveState() {
    const indexes = {};
    for (const [id, guard] of this.guards) {
      indexes[id] = { guard: guard.state() };
    }
    const kept = keptIndexes(this.store.load().indexes);
    const created = this.createdFeatureIds();
    for (const [id, entry] of Object.entries(kept)) {
      if (id in indexes) continue;
      if (created.has(id) || isObject(entry.guard?.held)) {
        indexes[id] = entry;
      }
    }
    const entries = Object.entries(indexes);
    if (entries.length > MAX_KEPT_INDEXES) {
      this.logger.warn(`inexogy: ${entries.length} index states, more than expected`);
    }
    const state = {
      salt: this.salt,
      pause: this.pause ?? null,
      refused: this.refused ?? null,
      lastAttemptAt: this.lastAttemptAt ?? null,
      indexes,
    };
    const key = JSON.stringify(state);
    if (key === this.savedKey) {
      return;
    }
    try {
      await this.store.save(state);
      this.savedKey = key;
    } catch (err) {
      this.logger.warn(`Saving the inexogy state in /data failed (${err?.code ?? 'error'})`);
    }
  }

  // --- Devices -----------------------------------------------------------------------

  createdOf(externalId) {
    return (this.gladys.devices ?? []).find((d) => d.external_id === externalId);
  }

  /** The device of a meter from what its readings showed and what its created device carries. */
  buildOf(meter) {
    const created = this.createdOf(ids(this.gladys, meter.id).device);
    const caps = mergeCapabilities(this.caps.get(meter.id), capabilitiesOfDevice(created));
    const built = buildMeter(this.gladys, meter, caps);
    return built ? keepCreatedFeatures(built, created) : undefined;
  }

  /** The devices of the meter list, each with the features of its created device kept. */
  devices() {
    if (!this.meterList) {
      return [];
    }
    return this.meterList.meters
      .filter((m) => SUPPORTED.has(m.kind))
      .map((m) => this.buildOf(m))
      .filter(Boolean);
  }

  /** The created devices of the meter list. */
  createdDevices() {
    return this.devices()
      .map((d) => this.createdOf(d.external_id))
      .filter(Boolean);
  }

  /** Publishes the Discovery list when it changed (always after a start). */
  async discover() {
    if (!this.meterList || !this.session?.client) {
      return;
    }
    const devices = this.devices();
    const key = JSON.stringify(devices);
    if (key === this.discoveredKey) {
      return;
    }
    this.discoveredKey = key;
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.discoveredKey = undefined;
      this.logger.warn(`Publishing the inexogy devices failed: ${err.message}`);
    });
  }

  /** The Discover tab asks: the known devices, never a read (the next one comes at its time). */
  async scan() {
    this.discoveredKey = undefined;
    await this.discover();
  }

  /** Whether `id` is the external id of a meter of this integration (`ext:<selector>:meter:<id>`). */
  isMeterId(id) {
    if (typeof id !== 'string') {
      return false;
    }
    const probe = ids(this.gladys, 'x').device;
    const prefix = probe.slice(0, -1);
    return id.startsWith(prefix) && ID_PATTERN.test(id.slice(prefix.length));
  }

  async onDeviceCreated(device) {
    const id = device?.external_id;
    // Any meter id of this integration, from its form alone: the meter list
    // may not be read yet after a restart (review 1, I1).
    if (!this.isMeterId(id)) {
      return;
    }
    // A new device: no reference of its index yet (nor a state kept in /data
    // for a deleted device of the same id). Its values come at the next read.
    const indexId = `${id}:${FEATURE.CONSUMPTION_INDEX}`;
    this.guards.delete(indexId);
    this.pendingAccept = undefined;
    const kept = this.store.load();
    const indexes = keptIndexes(kept.indexes);
    delete indexes[indexId];
    await this.store
      .save({ ...kept, indexes })
      .catch((err) =>
        this.logger.warn(`Clearing the inexogy index state failed (${err?.code ?? 'error'})`),
      );
    this.savedKey = undefined;
    this.discoveredKey = undefined;
    await this.updateStatus();
  }

  async onDeviceUpdated(device) {
    if (this.devices().some((d) => d.external_id === device?.external_id)) {
      this.discoveredKey = undefined;
      await this.updateStatus();
    }
  }

  // --- Values ------------------------------------------------------------------------

  /** The guard of the index feature of a created device, from Gladys and /data. */
  guardOf(created, id) {
    if (!this.guards.has(id)) {
      const saved = keptIndexes(this.store.load().indexes)[id];
      this.guards.set(
        id,
        new IndexGuard(lastValueOf(created, id), saved?.guard, this.now(), {
          maxKw: INDEX_MAX_KW,
          slackKwh: INDEX_SLACK_KWH,
        }),
      );
    }
    return this.guards.get(id);
  }

  /**
   * The value of the consumption index to send, through its guard: the
   * register when plausible, the last accepted one while a value is held,
   * else undefined.
   */
  indexFor(created, external, energy, label) {
    const id = external.feature(FEATURE.CONSUMPTION_INDEX);
    if (!(created.features ?? []).some((f) => f.external_id === id)) {
      return undefined;
    }
    const guard = this.guardOf(created, id);
    this.labels.set(id, label);
    const value = indexOf(energy);
    if (value === undefined) {
      return guard.held ? guard.last?.value : undefined;
    }
    const plausible = guard.accept(value, this.now());
    if (!plausible && guard.held) {
      this.logger.warn(
        `inexogy consumption index ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back`,
      );
    }
    // While a value is held, the last accepted one is sent again (no delta for the core).
    return plausible ? value : guard.held ? guard.last?.value : undefined;
  }

  /** Every state of the last read, the index through its guard. */
  async publishAll(gone) {
    const states = [];
    for (const entry of this.data.entries) {
      const { meter, reading, failed, stale } = entry;
      if (failed || !reading) {
        // Not read this time: nothing of it is sent (never an old value as a new one).
        continue;
      }
      const external = ids(this.gladys, meter.id);
      const created = this.createdOf(external.device);
      if (!created) {
        continue;
      }
      if (meter.kind === KINDS.ELECTRICITY) {
        const e = electricityOf(reading);
        const index = this.indexFor(created, external, e.energy, nameOf(meter));
        states.push(
          ...this.allowed(created, [
            ...electricityCounters(external, e, index),
            ...(stale ? [] : liveStates(external, e)),
          ]),
        );
      } else {
        states.push(
          ...this.allowed(created, volumeStates(external, meter.kind, volumeOf(reading))),
        );
      }
    }
    // The guards are in /data BEFORE Gladys gets the values: a crash in
    // between never sends an index /data does not know.
    await this.saveState();
    if (gone()) return;
    await this.publishStates(states, gone);
  }

  /** Only the features the created device has (they are fixed at its creation). */
  allowed(created, states) {
    const features = created.features ? new Set(created.features.map((f) => f.external_id)) : null;
    return features ? states.filter((s) => features.has(s.device_feature_external_id)) : states;
  }

  /** Room left in the budget of the last minute (all publications together). */
  room() {
    const mono = this.monotonic();
    this.sent = this.sent.filter((s) => mono - s.at < MINUTE);
    return STATES_PER_MINUTE - this.sent.reduce((n, s) => n + s.count, 0);
  }

  /**
   * The states sent within the budget of STATES_PER_MINUTE: the indexes
   * first, then the others; what does not fit waits for the next read
   * (publishChangedStates only counts what changed).
   */
  async publishStates(states, gone) {
    const isIndex = (s) => s.device_feature_external_id.endsWith(`:${FEATURE.CONSUMPTION_INDEX}`);
    const queue = [...states.filter(isIndex), ...states.filter((s) => !isIndex(s))];
    while (queue.length > 0) {
      const room = this.room();
      if (room <= 0) {
        this.notes.budget = true;
        this.logger.warn(`inexogy: ${queue.length} values left for the next read (budget)`);
        return;
      }
      const batch = queue.splice(0, room);
      let count = batch.length;
      try {
        const result = await this.gladys.publishChangedStates(batch, {
          heartbeat: STATE_HEARTBEAT,
        });
        count = Number.isInteger(result?.count) ? result.count : batch.length;
      } catch (err) {
        this.logger.warn(`Publishing the inexogy values failed: ${err.message}`);
      }
      this.sent.push({ at: this.monotonic(), count });
      if (gone()) return;
    }
  }

  /** The indexes held back: `[{ id, label, direction, from, to, threshold }]`. */
  heldItems() {
    const items = [];
    for (const [id, guard] of this.guards) {
      if (guard.held) {
        const { direction, from, to, threshold } = guard.held;
        items.push({ id, label: this.labels.get(id) ?? id, direction, from, to, threshold });
      }
    }
    return items;
  }

  // --- Configuration screen buttons -------------------------------------------------

  /**
   * "Accept the held index", in two clicks: the first lists the jumps held
   * and takes nothing; a second click within ACCEPT_CONFIRM_WITHIN takes
   * exactly the jumps listed (a value changed since stays held). Each taken
   * value is published at the next read (never a read sooner), bounded by
   * the guard (src/guard.js) to the value shown plus what may come meanwhile.
   * A DROP is never accepted (as gladys-hypontech): a glitch taken would
   * count the climb back as consumption; it corrects itself when the register
   * comes back, and a meter really replaced or reset is a device deleted and
   * created again.
   */
  async acceptHeldIndex() {
    const held = this.heldItems();
    const jumps = held.filter((h) => h.direction === 'up');
    const drops = held.length - jumps.length;
    const mono = this.monotonic();
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    if (pending && mono - pending.at <= ACCEPT_CONFIRM_WITHIN && pending.session === this.session) {
      const taken = [];
      let changed = 0;
      for (const item of pending.items) {
        const now = jumps.find((h) => h.id === item.id);
        const same =
          now && now.from === item.from && now.to === item.to && now.threshold === item.threshold;
        if (same && this.guards.get(item.id)?.acceptHeld()) {
          taken.push(item);
          this.logger.info('inexogy consumption index jump accepted by the user');
        } else {
          changed += 1;
        }
      }
      return T.accept.done(taken, changed);
    }
    if (jumps.length === 0) {
      return drops > 0 ? T.accept.drop : T.accept.nothing;
    }
    this.pendingAccept = { at: mono, items: jumps, session: this.session };
    return T.accept.list(jumps, ACCEPT_CONFIRM_WITHIN, drops);
  }

  /**
   * The test button: never a read sooner than the pace allows. When a read
   * is due, this click makes it (refused credentials included: one try);
   * otherwise it tells the last one. The next read is scheduled when this
   * read ends, whatever the answer of the button.
   */
  async testConnection() {
    if (!this.session?.client) {
      return T.incomplete;
    }
    if (this.pause && this.now() < this.pause.until) {
      return this.currentStatus()[1];
    }
    const refused = this.isRefused();
    if (this.busy || this.dueAt() > this.monotonic()) {
      return refused
        ? T.test.refusedWait(Math.max(0, this.dueAt() - this.monotonic()))
        : this.describeOutcome();
    }
    const session = this.session;
    const run = this.tick({ retryRefused: refused }).finally(() => {
      if (this.running && session === this.session) this.schedule();
    });
    this.loopRun = run.catch(() => {});
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(T.test.slow), TEST_ANSWER_WITHIN);
    });
    try {
      return await Promise.race([
        run.then(() =>
          this.isRefused() ? T.refused(this.refused.status) : this.describeOutcome(),
        ),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** The last read in words, and the time to the next one. */
  describeOutcome() {
    const mono = this.monotonic();
    const next = Math.max(0, this.dueAt() - mono);
    const outcome = this.outcome;
    if (!outcome) {
      return T.test.notYet(next);
    }
    const ago = Math.max(0, mono - outcome.at);
    if (outcome.kind === 'ok') {
      return T.test.reading(outcome.count, ago, next);
    }
    return T.test.failed(outcome.err, ago, next);
  }
}

function freshNotes() {
  return {
    failing: 0,
    denied: 0,
    truncated: false,
    skipped: 0,
    unsupported: 0,
    stale: 0,
    budget: false,
  };
}
