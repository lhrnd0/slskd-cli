# slskd-cli

A command-line client for one trusted [slskd](https://github.com/slskd/slskd) instance.
The `slskd-cli` package provides the `slskd` command.

The CLI is **agent-first**: commands run without prompts and return JSON with stable exit codes.
People can use the same commands directly or compose them in scripts.
Search for files, inspect Candidates, manage Transfers, and exchange Private messages.
slskd owns Search, Transfer, and message state.

## Requirements

- Node.js **24 or later**.
- slskd **0.26.1 or later**, with a **ReadWrite API key**.
- Linux or macOS; CI checks both with Node.js 24. Windows remains unverified.

## slskd server

This CLI connects to a separate [slskd server](https://github.com/slskd/slskd).
First, install, configure, and run slskd using that project's setup instructions.
Then set the server's base URL and ReadWrite API key in the CLI's [Connection profile](#configuration).
Installing `slskd-cli` does not install or configure the server.

## Installation

The source tag [v0.1.0-beta.1](https://github.com/lhrnd0/slskd-cli/tree/v0.1.0-beta.1) exists.
**The npm package is not published yet.**
For now, use the [source setup](docs/development/setup.md).

After publication, install the preview:

```sh
npm install --global slskd-cli@next --registry=https://registry.npmjs.org/
slskd --help
```

## Configuration

Create `~/.config/slskd-cli/config.toml`:

```toml
[connection]
baseUrl = "http://127.0.0.1:5030"
apiKey = "your-readwrite-api-key"
timeoutMs = 30000
```

When `XDG_CONFIG_HOME` is set, create `slskd-cli/config.toml` inside that directory instead.
Keep the file readable only by your account.
On Unix-like systems, use `chmod 600` with the profile's actual path.

```sh
slskd check
```

See [Connection profile](docs/reference/configuration.md) for environment variables, flags, and timeout settings.

## First Workflow

Create a Search, then observe its Candidates:

```sh
slskd search create --query 'artist album'
slskd search candidates '<searchId>' --watch
```

Use the returned `searchId` in the second command.
Wait for `ended` with `reason: "completed"`, then inspect the Candidates and choose one.
If observation ends with `reason: "deadline"`, watch the same Search again.

```sh
slskd transfer enqueue '<searchId>' '<candidateId>' --yes
slskd transfer show '<username>' '<transferId>'
```

Use the chosen Candidate's identifier and username, and the returned Transfer's `id`.
The CLI never ranks or selects Candidates for you.
slskd controls download locations; the CLI never moves or deletes downloaded files.
See [Downloading files](docs/guides/downloading.md) for selection, progress, and uncertain outcomes.

## Documentation

Start with the [documentation index](docs/README.md).

| Find                                 | Read                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Command syntax, options, and results | [check](docs/commands/check.md), [search](docs/commands/search.md), [transfer](docs/commands/transfer.md), [message](docs/commands/message.md) |
| Complete tasks                       | [Workflow guides](docs/README.md#guides)                                                                                                       |
| JSON output and exit codes           | [Output](docs/reference/output.md), [errors](docs/reference/errors.md)                                                                         |
| Build and contribute                 | [Contributing](CONTRIBUTING.md)                                                                                                                |

Offline help works at every command level:

```sh
slskd --help
slskd search --help
slskd transfer enqueue --help
slskd help message watch
```

## License

[MIT](LICENSE).
