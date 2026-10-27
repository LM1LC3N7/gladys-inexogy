# TODO

## Before announcing

- [ ] Test on a real Gladys 5.2+ with a real inexogy account (an electricity
      meter, ideally two-way with three phases, and a gas meter): test
      button, device creation, the consumption and cost the core derives from
      the index, the sensors.
- [ ] Test the Docker image (no Docker on the development PC yet).
- [ ] Run the store validator (`npx github:GladysAssistant/integration-store .`):
      not possible from the development agent.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).

## To confirm with a real account (built without one)

- [ ] HTTP Basic is accepted for every customer account (pydiscovergy's
      default, used by Home Assistant); what inexogy answers to wrong
      credentials (401 assumed, 403 handled the same on the meter list).
- [ ] The scales: power in mW, voltage in mV, energy in 1e-10 kWh, volume in
      1e-3 m³ (Home Assistant's); the water meters (`WATER`, `volume`) were
      never seen anywhere.
- [ ] The sign of `power` on a two-way meter (negative while injecting is
      assumed: published as given) and of `power1`..`power3`.
- [ ] Whether `energy` is always present on an electricity meter (Home
      Assistant falls back to `energy1`; here no index without `energy`).
- [ ] How often the readings change at inexogy, and the age of a gas
      reading (only electricity live values are called stale).
- [ ] The `Date` header on every answer (the age of a reading uses it).
- [ ] Any rate limit of the API (none documented; 1 + N requests a minute by
      default).
- [ ] The `scalingFactor`, `currentScalingFactor` and `voltageScalingFactor`
      of `/meters` (review 1, M2): ignored, as Home Assistant does (1 in the
      pydiscovergy fixture). A meter behind current transformers with a
      factor other than 1 would give values off by that factor: confirm, then
      apply them or list such meters without reading them.

## Decisions

- **SDK `^0.16.0`** (2026-10-27, migration wave 4): 0.16.0 is on npm since
  2026-10-25 (a stale npm cache said otherwise); it adds the ai, tts and music
  types; no effect here (`poll_frequency` unused). `keywords`, `countries`
  and `gladys_version >= 5.3.0` wait until Gladys 5.3 is widespread.
- **Versions**: 0.1.0 set once by hand when leaving the template (package,
  lock file, manifest, image tag), as for the sibling integrations; the
  Release workflow owns them from now on (the first patch release gives
  0.1.1).
- **Reused project**: pydiscovergy (jpbede/pydiscovergy, MIT, Jan-Philipp
  Benecke, read at commit 8c69cd2, after 3.1.0), license checked in its LICENSE file,
  ported to JavaScript: the base address, HTTP Basic, `/meters`,
  `/last_reading`, the shapes of a meter and a reading
  (`THIRD_PARTY_NOTICES.md`, README, docs). The Home Assistant integration
  (Apache-2.0) was read for the field names and scales only; nothing copied.
  The SDK stays the only runtime dependency.
- **Authentication**: HTTP Basic (pydiscovergy's default and Home
  Assistant's). The OAuth 1 flow of pydiscovergy is not ported: it asks a
  consumer token under an application name (`client=<app>`), and the e-mail
  and password would still be sent to authorize it; Basic is simpler, no
  token to renew, no application name. No User-Agent of ours, no key of an
  app. The password goes only to `api.inexogy.com` in HTTPS, redirects never
  followed. An e-mail with a colon is refused (Basic would cut it there).
- **Refused credentials**: 401 or 403 on `/meters` is final (salted HMAC
  fingerprint in /data, erased at the first answer that accepts them, never a
  fingerprint of good credentials), no new try by itself, even after a
  restart; other credentials saved, or the test button (one try, never
  sooner than the interval). A 401/403 on one `last_reading` concerns that
  meter only (never the refusal of the account); when every meter answers
  401/403, the meter list is asked ONCE at the next read (where a refusal is
  final) instead of an hour later. A meter whose reading is refused while
  the list answers 200 is asked again spaced (the interval, doubled at each
  refusal, up to 1 h), and the status says "access refused to N meter(s)"
  (review 1, M1).
- **Device created** (review 1, I1): `onDeviceCreated` recognises a meter id
  of this integration by its form alone (`ext:<selector>:meter:<id>`, id
  checked by `ID_PATTERN`), never by the meter list, which is empty after a
  restart until the first read: the guard and its /data entry are always
  erased for a device created again.
- **Pause capped at each use** (review 1, M3): the time left is never above
  6 h, even when the wall clock goes back.
- **Pauses**: 429 anywhere, 5xx on `/meters`, or 5xx on every meter read:
  1 min doubled up to 6 h, or the `Retry-After` within those bounds
  (an HTTP date compared with the `Date` of the answer), kept in /data,
  applied to every read and to the test button. A 5xx on one meter only is a
  note of the status, the others go on.
- **Pace**: `poll_minutes` 1 (default) to 60; the meter list once an hour;
  the time of the last read written in /data BEFORE the read, at most once a
  minute; never two reads less than an interval apart whatever asks (restart,
  reconnection, save, Discover tab, test button). Network failures: retries
  doubled from the interval, up to 1 h.
- **External id**: `meter:<meterId>`, the id of inexogy (fixed for a meter);
  a meter without a usable id gets no device. Name `inexogy <kind>
<serialNumber>`; the location (a postal address) is never read; the full
  serial and the make are device params only (never in /data).
- **Kinds**: ELECTRICITY, GAS and WATER read; any other (HEAT...) listed in
  the status, never read (no request for it). At most 10 meters.
- **Energy** (lessons of waves 2 and 3, lot 6): `consumption_index` is the
  only `energy-sensor` / `index` feature, the meter's own `energy` register;
  never `energy1` (Home Assistant's fallback) nor a sum of the tariffs: a
  partial register would be billed. The tariff registers and `energyOut` are
  plain sensors (`unknown` / `decimal`, kWh in the name), not
  `energy-production-sensor` (injection is not production) nor
  `grid-sensor`. Gas and water: `volume-sensor` / `decimal` in m³, never in
  the energy monitoring, never `publishEnergyConsumption`. `power` is the
  only `energy-sensor` / `power`, signed (min -1,000,000 W) as inexogy gives
  it; the power of each phase is a plain sensor; the voltages are
  `energy-sensor` / `voltage`. The phase features have `keep_history: false`.
- **Index guard**: `src/guard.js` of gladys-hypontech, i.e. the approved
  guard of gladys-p1-monitor with `maxKw` / `slackKwh` as parameters,
  unchanged: never 0, a jump (over 100 kW on average + 0.5 kWh) held whatever
  the time, kept in /data across restarts, never confirmed by time,
  repetition, a restart nor a save. Acceptance in two clicks (5 minutes),
  bounded to the values listed (a value changed since stays held). A DROP is
  never accepted (as gladys-hypontech): a glitch taken would bill the climb
  back; a meter really replaced or reset is a device deleted and created
  again (the guard and its /data entry start afresh at `onDeviceCreated`).
  The margin grows with the time since the last value: after 24 h without a
  reading, up to 2,400 kWh pass at once (documented).
- **Capabilities**: a feature appears once inexogy gives its value (a
  counter: above 0); they only grow, merged with the features of the created
  device (`gladys.devices`), and a republished device keeps every feature of
  the created one (`keepCreatedFeatures`): no `structure_changed`, no
  history lost by "Update".
- **Staleness**: a reading more than 15 min older than the `Date` of the
  answer sends no power, phase power nor voltage; the counters still go
  (a frozen counter gives no delta). Without a readable `Date`, never stale
  (lesson of lot 13). A meter not read this time sends nothing.
- **Budget**: at most 280 states a minute, all meters together, the indexes
  first (`publishChangedStates`, 10-minute heartbeat).
- **Republication**: every `connected` calls `forgetPublishedStates()`,
  publishes the status and the Discovery list again; the values at the next
  read (never a read sooner).
- **Hostile answers**: one request at a time, 10 s for the whole answer,
  256 KiB read into one buffer, JSON without `__proto__` / `constructor` /
  `prototype`, values into a null-prototype object, at most 200 values and
  10 meters, texts bounded to 64 printable characters.
- **Gladys version**: `>=5.2.0`, like the other energy integrations (index
  features of external integrations, volume-sensor).
- **No command**: read-only, no `switch`, no `onSetValue`, no scene event.

## Ideas

- A setting for the margin of the guard (a business above 100 kW).
- The readings by period (`/readings`) to fill a gap after an outage.
- Heat meters, once their fields are known.
