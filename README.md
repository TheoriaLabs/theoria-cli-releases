# Theoria CLI releases

Published releases of [Theoria CLI](https://www.theoria.sh), the Lean-native research agent for mathematics and
theoretical sciences.

Each release `vX.Y.Z` has:

- `theoria-cli-X.Y.Z.tar.gz`: the source of that version, with a `release.json` recording its version and commit;
- `SHA256SUMS`: the checksum of the tarball.

This repository's history holds one snapshot commit per release.

## Install

```sh
curl -fsSL https://www.theoria.sh/install/cli.sh | bash
```

The installer verifies the checksum before installing. It requires Node.js 22.19 or later. macOS is supported;
on Linux it continues with a warning, because the Telegram bot sandbox and some benchmark features are macOS-only.

## License

Copyright 2026 DeepHedge Labs LLC. Licensed under the [Apache License, Version 2.0](LICENSE); see [NOTICE](NOTICE).
