# gladys-inexogy

Unofficial [Gladys Assistant](https://gladysassistant.com) external integration
for **inexogy** (formerly Discovergy) smart meters, through the official
inexogy API (`api.inexogy.com`), read-only: power, a guarded electricity
consumption index for the energy monitoring, tariff registers, injection,
power and voltage per phase, and gas and water meters as volume sensors. Not
affiliated with inexogy.

**Never tested with a real device** nor a real inexogy account: the calls and
the meaning of the values are ported from
[pydiscovergy](https://github.com/jpbede/pydiscovergy) (MIT, Jan-Philipp
Benecke), the library of the Home Assistant integration, see
`THIRD_PARTY_NOTICES.md`.

- User guide: [docs/en.md](docs/en.md), [docs/fr.md](docs/fr.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)
- Contributing and architecture: [CLAUDE.md](CLAUDE.md)
- Open points and decisions: [TODO.md](TODO.md)
- Security: [SECURITY.md](SECURITY.md)

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
npm run cover    # cover.png, 800 x 534, plain Node
```

## License

Apache-2.0 (see `LICENSE`). Logic ported from pydiscovergy (MIT): see
`THIRD_PARTY_NOTICES.md`.
