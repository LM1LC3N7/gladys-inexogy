# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, distributed under its own
license.

## pydiscovergy (jpbede/pydiscovergy)

<https://github.com/jpbede/pydiscovergy>, by Jan-Philipp Benecke, the library
the inexogy (Discovergy) integration of Home Assistant uses. Version 3.1.0
(tag `v3.1.0`; repository read at commit 8c69cd2).

Ported to JavaScript in `src/inexogy/client.js` and `src/inexogy/model.js`:
the base address of the API (`https://api.inexogy.com/public/v1`), its
default authentication (HTTP Basic with the e-mail and the password of the
account), the two calls read here (`/meters`, `/last_reading?meterId=`),
the 10-second timeout, the shape of a meter (`meterId`, `serialNumber`,
`fullSerialNumber`, `type`, `measurementType`) and of a reading (`time` in
milliseconds, `values`), and the answers of its test fixtures, which shape
`test/helpers/fakeCloud.js`. The field names and their scales (power in mW,
voltage in mV, energy in 1e-10 kWh, volume in 1e-3 m³, the alternative keys
`phase1Power`, `phase1Voltage`) come from the Home Assistant integration
`discovergy` (Apache-2.0), read for that purpose only; no code copied from
it. Not ported: the OAuth 1 authentication of pydiscovergy (a consumer token
asked under an application name), the readings by period, the statistics,
the field names and the devices calls. Changed here: a missing value is
never read as 0, the location of a meter (a postal address) is never read,
and the consumption index is the meter's own `energy` register only, never
`energy1`.

Its license, reproduced as it appears in the repository (tag `v3.1.0`):

```
MIT License

Copyright (c) 2017-2021 Jan-Philipp Benecke

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## gladys-p1-monitor, gladys-hypontech

The plausibility guard of the billed index (`src/guard.js`, from
gladys-p1-monitor with `maxKw` as a parameter), the `/data` store
(`src/store.js`) and the pace, pause, refusal and two-click acceptance of
`src/app.js` come from the sibling integrations
[gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor) and
[gladys-hypontech](https://github.com/LM1LC3N7/gladys-hypontech), same
project, Apache-2.0.
