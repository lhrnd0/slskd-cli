# Connection profile

The Connection profile supplies the slskd base URL, API key, and per-request timeout.
Use one trusted slskd instance with a ReadWrite API key.

## Profile file

The default path is `$XDG_CONFIG_HOME/slskd-cli/config.toml`.
When `XDG_CONFIG_HOME` is unset, use `~/.config/slskd-cli/config.toml`.
Set `SLSKD_CLI_CONFIG` to select another file.

```toml
[connection]
baseUrl = "http://127.0.0.1:5030"
apiKey = "your-readwrite-api-key"
timeoutMs = 30000
```

Keep the file readable only by your account.
For the default Unix-like path:

```sh
chmod 600 ~/.config/slskd-cli/config.toml
```

## Overrides

Command-line flags override environment variables, which override profile values.
All operational commands accept these connection options.

| Profile key | Environment variable | Flag                | Default  |
| ----------- | -------------------- | ------------------- | -------- |
| `baseUrl`   | `SLSKD_BASE_URL`     | `--base-url <url>`  | Required |
| `apiKey`    | `SLSKD_API_KEY`      | `--api-key <key>`   | Required |
| `timeoutMs` | `SLSKD_TIMEOUT_MS`   | `--timeout-ms <ms>` | `30000`  |

`baseUrl` must be an absolute HTTP or HTTPS URL without credentials, a query, or a fragment.
`timeoutMs` must be an integer from `1` to `2147483647` milliseconds.
Each HTTP request has its own deadline.
Watch duration options separately bound total observation time.

## Check the connection

```sh
slskd check
```

The CLI requires slskd 0.26.1 or later.
The version endpoint authenticates the key but does not report its role.
Therefore, `check` returns `apiKeyRole: "unverified"`.
Verify the ReadWrite role in slskd configuration before using operational commands.
A rejected API request returns `AUTHENTICATION`.

See [check](../commands/check.md) and [errors](errors.md).
