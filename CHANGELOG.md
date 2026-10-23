# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Read-only reading of an inexogy (formerly Discovergy) customer account
  through the official inexogy API, as the pydiscovergy library does it (HTTP
  Basic with the e-mail and the password of the account): the meter list once
  an hour, the last reading of each meter at every read (1 minute by default).
- One device per meter: for electricity, the power, the consumption index
  (the meter's own `energy` register) fed to the Gladys energy monitoring,
  the tariff registers and the injection as plain sensors, the power and
  voltage of each phase; for gas and water, a volume sensor in m³, out of the
  energy monitoring. A feature appears once inexogy gives its value; a device
  republished never loses a feature of the created one.
- The consumption index is protected: never 0; a drop held and never
  accepted; a jump over 100 kW on average held whatever the time and across
  restarts (kept in `/data`), shown in the status, taken only by two clicks on
  "Accept the held index", bounded to the values listed.
- Pace kept in `/data`: never two reads less than an interval apart, even
  after a restart, a reconnection, a save of the form or the test button.
- Refused credentials (401 or 403 on the meter list): final, kept in `/data`
  as a salted fingerprint erased at the first success; no new try by itself.
- 429 and 5xx: a pause of 1 minute to 6 hours for every read, kept in
  `/data`; a 5xx on one meter leaves the others going.
- A reading more than 15 minutes old on the clock of inexogy (its `Date`
  header) sends no power nor voltage.
- At most 280 values a minute sent to Gladys.
- "Test the connection" button: one read when the interval allows it,
  otherwise the last one in words.
- Documentation in English and French; `LICENSE` (Apache-2.0) and
  `THIRD_PARTY_NOTICES.md` (MIT license of pydiscovergy), shipped in the
  image; a cover generated in plain Node.

[Unreleased]: https://github.com/LM1LC3N7/gladys-inexogy/commits/main
