# check

Check connectivity, authentication, and slskd compatibility.

```sh
slskd check
```

The command accepts the shared [connection options](../reference/configuration.md#overrides).
It requires slskd 0.26.1 or later and makes no state changes.

## Result

```json
{ "ok": true, "result": { "compatible": true, "version": "0.26.1.0", "apiKeyRole": "unverified" } }
```

| Field        | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `compatible` | The returned version passes the CLI compatibility check                  |
| `version`    | The version reported by slskd                                            |
| `apiKeyRole` | Always `"unverified"`; the version endpoint does not report the key role |

A successful check does not prove ReadWrite permissions.
Verify the role in slskd configuration.

## Errors

Common errors include `MISSING_CONFIGURATION`, `AUTHENTICATION`, `INCOMPATIBLE`, `CONNECTION`, and `TIMEOUT`.
See [exit codes and recovery](../reference/errors.md).
