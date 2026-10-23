# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads an **inexogy customer account** (formerly Discovergy, German smart
meters) through the official API `https://api.inexogy.com/public/v1`, as
[pydiscovergy](https://github.com/jpbede/pydiscovergy) (Jan-Philipp Benecke,
MIT, see `THIRD_PARTY_NOTICES.md`) reads it with HTTP Basic. Unofficial: not
affiliated with inexogy. **Read-only**: never `onSetValue`; GETs only.
Siblings: `gladys-p1-monitor` (the index guard, approved), `gladys-hypontech`
(the structure: pace kept in /data, pauses, refused credentials final and
fingerprinted, sessions, two-click acceptance, budget), `gladys-youless`
(gas and water as volume sensors).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png, 800 x 534, plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

On the development PC, set `npm_config_cache` and `npm_config_logs_dir` to
`C:\Users\user\devtools\npm-cache` first (never under AppData). The CI runs
`format:check`, `lint` and `test` on Node 22 and 24.

## Architecture

```
index.js                 SDK wiring only: handlers registered before connect()
src/app.js               InexogyApp: pace, reads, devices, index guards, pauses, refusal, buttons
src/inexogy/client.js    the only network access (HTTP Basic GETs, bounded, Date of the cloud)
src/inexogy/model.js     the answers -> our values (pure): meters, readings, scales, capabilities
src/devices.js           the Gladys devices and their states (pure)
src/guard.js             plausibility of an energy index (gladys-p1-monitor, maxKw a parameter)
src/config.js            the form, normalized
src/store.js             /data: salt, pace, pause, refused fingerprint, guards
src/i18n.js              every runtime text, { en, fr }
src/constants.js         keys and limits (keys are forever)
scripts/cover.mjs        the cover, plain Node
```

## Rules (do not break)

- External ids are forever: `meter:<meterId>` (the id inexogy gives, 1 to 64
  letters, digits, `_`, `-`); feature keys in `src/devices.js`. A meter
  without a usable id gets no device (counted in the status), never a
  guessed id.
- `consumption_index` is the ONLY energy-sensor / index feature: the meter's
  own `energy` register through `IndexGuard` (never 0, jumps and drops held,
  never confirmed by time, a jump accepted only by two clicks bounded to the
  values listed, a drop NEVER accepted). Never `energy1` + `energy2`, never
  the injection, never `publishEnergyConsumption`. Tariffs and injection are
  plain sensors; gas and water are volume sensors in m³, out of the energy
  monitoring. `power` is the only energy-sensor / power feature.
- Never two reads less than an interval apart (the attempt is written in
  /data BEFORE the read); a 429, a 5xx on the meter list or on every meter
  pauses (1 min to 6 h, in /data); a 5xx on one meter leaves the others;
  401/403 on the meter list is a final refusal (salted fingerprint in /data,
  erased at the first success); a 401/403 on one reading concerns that meter
  only; never a retry loop.
- A late answer of a former account publishes nothing and sets no status
  (`gone()` after every await).
- The age of a reading is measured on the clock of inexogy (`Date` header);
  without it, never stale.
- Never log or keep the password, the e-mail, a serial number in /data, nor
  a text of the cloud; the location of a meter is never read. The password
  field is "kept by Gladys in its database, never shown again"; never say it
  is protected otherwise (a test checks the words).
- Core units only (`DEVICE_FEATURE_UNITS_BY_CATEGORY`); a device republished
  keeps every feature of its created device (`keepCreatedFeatures`).
- At most 280 states a minute, indexes first.
- Files in UTF-8 without BOM, no control byte (`test/encoding.test.js`).

## Releases

Version 0.1.0 was set by hand (package.json, package-lock.json, manifest,
docker_image); the Release workflow bumps them together and rolls
`CHANGELOG.md`. Describe every change under `## [Unreleased]`.
