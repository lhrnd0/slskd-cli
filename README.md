# slskd-cli

`slskd-cli` is a non-interactive JSON command line interface for one trusted [slskd](https://github.com/slskd/slskd) instance. The npm package installs the `slskd` command. It supports slskd **0.26.1 or later** and Node.js **24 or later**. The CLI keeps no Workflow database and never moves or deletes downloaded files.

## Install and build

The source tag [v0.1.0-beta.1](https://github.com/lhrnd0/slskd-cli/tree/v0.1.0-beta.1) exists.
The npm package is not published yet. After publication, install the preview under the `next` tag:

```sh
npm install --global slskd-cli@next --registry=https://registry.npmjs.org/
slskd --help
```

CI checks Linux and macOS with Node.js 24.
Windows support remains unverified.
The CLI uses the [MIT license](LICENSE).
See the [release procedure](docs/releasing.md) for package checks and publication requirements.

For development, install dependencies and run the checks:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
pnpm package:check
```

`package:check` builds and packs the CLI, then installs it into a temporary global prefix.
It verifies package contents, offline help, and `check` against a fixture slskd server.
It then runs all CLI tests against the installed package, without the source tree or development dependencies.
It installs only production dependencies and disables installation scripts.
The check uses the public npm registry and removes its temporary files afterward.

The project declares its pnpm version in `package.json`. Run `corepack enable` once if your Node.js installation includes Corepack but pnpm is not available.

Run `pnpm format` to apply the repository's oxfmt rules. `pnpm lint:fix` applies safe oxlint fixes.

Contributions use [Conventional Commits](CONTRIBUTING.md#commit-messages). The repository's Git hook validates commit messages locally.

## Release process

Release changes enter `main` through a PR.
A release PR updates the version in `package.json` and the corresponding entry in `CHANGELOG.md`.
After CI passes and reviewers approve the PR, merge it into `main`.
Successful `main` CI creates the missing annotated `v<version>` tag automatically.
Existing version tags stay at their original commits.
PR checks and manual CI runs do not create tags.

Tag creation does not publish the npm package.
Publication remains a future step, using the verified artifact from the tagged `main` commit.
See [Contributing](CONTRIBUTING.md#pull-requests) and the [release procedure](docs/releasing.md) for checks, publication gates, and recovery.

## Issue tracking with Beads

Development tasks are tracked with [Beads](https://github.com/gastownhall/beads) using the `bd` command. Install a current version of Beads before setting up a development checkout; it is separate from the project's pnpm dependencies.

### Bootstrap a fresh clone

Run bootstrap before starting a coding agent or running other Beads commands:

```sh
git clone git@github.com:lhrnd0/slskd-cli.git
cd slskd-cli

chmod 700 .beads
git config --local beads.role maintainer
bd bootstrap --yes

# Verify the restored database
bd config get issue_prefix # should print slskd-cli
bd stats
bd ready
```

Use `contributor` instead of `maintainer` for a contributor checkout. The role is local to the checkout and does not override this repository's requirement for explicit authorization before an agent commits or pushes.

A normal `git clone` does not fetch the issue database stored under `refs/dolt/data`. `bd bootstrap` retrieves the existing Dolt history and configures its remote using this repository's tracked `.beads/config.yaml`. Use bootstrap for this existing project; `bd init` is for initializing a new Beads project. Bootstrap restores the history already published to the remote, so issues created in another checkout must be published before they appear here. See the upstream [clone and sync setup guide](https://github.com/gastownhall/beads/blob/main/docs/getting-started/sync-setup.md).

If bootstrap reports an existing database but `issue_prefix` is missing or expected issues are absent, stop and inspect the local database and remote history. Back up local data before attempting recovery; setting a prefix alone does not restore missing issues.

### Daily workflow and synchronization

```sh
bd prime                           # Load workflow guidance and project memories
bd ready                           # Find available work
bd show '<issue-id>'                # Read an issue
bd update '<issue-id>' --claim      # Claim it before starting
bd create --title='Describe work' --description='Context and acceptance criteria' --type=task --priority=2
bd close '<issue-id>' --reason='Describe what was completed'
```

Use Beads for task tracking and `bd remember` for persistent project knowledge, rather than separate Markdown task lists or memory files.

Issue history and source code have separate synchronization commands:

```sh
bd dolt pull # Receive published issue updates
bd dolt push # Publish local issue updates
```

`git pull` and `git push` synchronize source branches; they do not replace these Beads commands. Agents follow the repository's conservative policy: commit, push, and Dolt remote sync require explicit authorization.

## Run after building

After `pnpm build`, run the generated entry point directly from the project directory:

```sh
node dist/cli.js --help
node dist/cli.js check
node dist/cli.js search create --query 'artist album'
```

`dist` is a directory, so Node must be given the complete `dist/cli.js` path. To make the `slskd` command available globally from a local checkout, link the package:

```sh
pnpm link --global
slskd --help
```

The npm package exposes `slskd` from `dist/cli.js`. After preview publication, install it with `pnpm add --global slskd-cli@next --registry=https://registry.npmjs.org/`. During development, either use `node dist/cli.js` in place of `slskd` below or create the global link shown above.

## Help

Help is available offline at the root, command-group, and individual-command levels. Both forms are supported:

```sh
node dist/cli.js --help
node dist/cli.js search --help
node dist/cli.js transfer enqueue --help
node dist/cli.js help search create
```

Running the CLI, `search`, `transfer`, or `message` without further arguments also displays the relevant help. Help is plain text and does not read the Connection profile or contact slskd. One-shot operational commands emit exactly one JSON object. Watch commands emit newline-delimited JSON.

## Connection profile

Create `$XDG_CONFIG_HOME/slskd-cli/config.toml`, or `~/.config/slskd-cli/config.toml` when `XDG_CONFIG_HOME` is unset:

```toml
[connection]
baseUrl = "http://127.0.0.1:5030"
apiKey = "your-readwrite-api-key"
timeoutMs = 30000
```

Keep the profile readable only by your user account (for example, `chmod 600 ~/.config/slskd-cli/config.toml` on Unix-like systems).

Set `SLSKD_CLI_CONFIG` to use a different profile file. `SLSKD_BASE_URL`, `SLSKD_API_KEY`, and `SLSKD_TIMEOUT_MS` override the profile. `--base-url`, `--api-key`, and `--timeout-ms` override both. Every HTTP request has its own timeout; the default is 30,000 ms. Configure a slskd **ReadWrite** API key. slskd's public version endpoint authenticates the key but does not disclose its role, so `check` cannot prove the role independently. A rejected API request produces `AUTHENTICATION`.

`check` reports `apiKeyRole: "unverified"` to make that limit explicit. Verify the role in your slskd configuration before allowing the CLI to enqueue downloads.

```sh
slskd check
```

One-shot operational commands emit one JSON object on stdout. They never prompt or print the API key. Success uses `{"ok":true,"result":...}`; failure uses `{"ok":false,"error":{"code":"...","message":"..."}}`. stderr is reserved for process level failures.

## Private messages

Use `message` commands to exchange Private messages with Soulseek usernames through your configured slskd account.
Chat rooms and an interactive chat screen are outside this release.

```sh
slskd message conversations
slskd message conversations --unacknowledged
slskd message list 'peer'
slskd message list 'peer' --unacknowledged
slskd message send 'peer' --text 'Hello!' --yes
printf '%s\n' 'Hello!' | slskd message send 'peer' --stdin --yes
slskd message acknowledge 'peer' --id '<messageId>' --yes
slskd message acknowledge 'peer' --id '<messageId1>' --id '<messageId2>' --yes
slskd message acknowledge 'peer' --all --yes
```

`message conversations` includes inactive Conversations and reports their pending counts.
`message list` returns a `conversation` summary, chronological `messages` in both directions, and `history` metadata.
Each message has `messageId`, `serverId`, `username`, `timestamp`, `direction`, `text`, `isAcknowledged`, and `wasReplayed`.
Unavailable replay information is `null`. Direction is `incoming` or `outgoing`.
Use the opaque `messageId` for selection. Numeric `serverId` values can repeat, including zero for outgoing messages.
Message identifiers remain stable across CLI invocations with unchanged slskd data.

slskd 0.26.1 exposes the latest **100 messages per Conversation**, without pagination.
Its pending-message filter runs after this limit. Older Unacknowledged messages can be absent from inspection.
The CLI reports `history: {limit:100, complete:false, lossless:false, returnedBeforeFilter:...}` even for empty filtered history.
The Conversation summary reports slskd's count. Its individual-Conversation count can itself be capped at 100.
The CLI keeps no message archive or persistent consumer position.

Inspection and watching never acknowledge messages.
Acknowledgement is an explicit mutation and requires `--yes`.
Selected references must resolve to incoming messages in the available history before any mutation starts.
slskd acknowledges by username and numeric ID. Reused IDs cannot be acknowledged individually.
The command verifies the selected message's state after acknowledgement.
Already acknowledged selections return `outcome: "existing"` without another mutation.
`--all` deliberately acknowledges the entire Conversation, including messages outside the visible window.
It verifies that slskd reports no pending messages afterward.
Concurrent arrivals or replay can prevent verification. The command then reports an uncertain outcome.
Partial selection failures preserve per-message outcomes under `result.messages` and return nonzero status.
Later selections have `outcome: "not_attempted"`. Earlier successful acknowledgements remain in effect.

Sending preserves the exact text, including newlines from `--stdin`.
Use either `--text` or `--stdin`; blank input is rejected. Each invocation sends one message.
Use `--text=--literal` when the text starts with `--`.
A successful send returns `{username, submitted:true, delivered:null, read:null}`.
Submission does not prove delivery or remote reading.
slskd's HTTP 200 response for skipped, potentially blacklisted recipients produces `MESSAGE_REJECTED`.
Interrupted sends and server failures can produce `AMBIGUOUS_MUTATION`.
The CLI never automatically retries a message or acknowledgement mutation.
Inspect slskd before deciding whether to repeat an uncertain send; a duplicate message is possible.

### Watch incoming messages

```sh
slskd message watch
slskd message watch --username 'peer' --new-only --poll-interval-ms 1000 --timeout 60
```

Watching polls every **5000 ms** by default and runs until interrupted.
`--poll-interval-ms` accepts integers **100..60000**.
`--timeout` accepts integers **1..2147483** seconds and bounds the total message observation.
The connection option `--timeout-ms` still controls each HTTP request separately.
A username filter can wait for that username's first Conversation.
Without a filter, the watcher discovers new Conversations between polls.

The initial snapshot emits available Unacknowledged incoming messages.
`--new-only` records the initial snapshot without emitting its messages.
Later snapshots emit newly observed incoming messages, even when another client has already acknowledged them.
The watcher suppresses duplicate message identities within that invocation.
A new invocation can replay pending messages. Message replay does not imply that the remote user sent a second message.

Each stdout line uses the usual JSON envelope:

```json
{"ok":true,"result":{"event":"started","username":null,"history":{"limit":100,"complete":false,"lossless":false}}}
{"ok":true,"result":{"event":"message","message":{"messageId":"<messageId>","serverId":42,"username":"peer","timestamp":"2026-11-01T12:00:00Z","direction":"incoming","text":"Hello!","isAcknowledged":false,"wasReplayed":false}}}
{"ok":true,"result":{"event":"ended","reason":"deadline","messageCount":1}}
```

`started` follows the initial successful snapshot. A duration limit can expire before that snapshot arrives.
The duration limit emits `ended` with exit 0. It does not prove all messages were captured.
A failed poll emits a typed error and exits without automatic retries.
SIGINT and SIGTERM stop observation with exit **130** and **143**. A closed output pipe exits **0**.
Output respects backpressure. Watching never sends replies or performs Message acknowledgement.
Bursts beyond slskd's history window and interruptions can lose observable history.
This watcher cannot promise lossless capture or exactly-once processing.

The implementation follows slskd's [Conversation API](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Messaging/API/Controllers/ConversationsController.cs),
[message service](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Messaging/ConversationService.cs),
and [polling chat UI](https://github.com/slskd/slskd/blob/0.26.1/src/web/src/components/Chat/Chat.jsx).

## List searches

```sh
node dist/cli.js search list
```

`search list` returns `{searches:[...]}` for active and completed Searches stored in slskd, including old Searches. Each summary contains `searchId` (the UUID returned by slskd), `query`, `state`, `startedAt`, `endedAt`, `responseCount`, `fileCount`, and `lockedFileCount`. Unavailable metadata is `null`; an empty instance returns an empty array. It does not fetch Candidates.

Pass a listed `searchId` directly to `search candidates` or `transfer enqueue`. All commands use slskd's UUID as the canonical Search identifier; there is no separate CLI Search reference.

Delete a Search and its stored responses with an explicit acknowledgement:

```sh
slskd search delete '<searchId>' --yes
```

The command returns `{searchId,deleted:true}`. A missing Search returns `MISSING_SEARCH`. As with other mutations, an interrupted or timed-out request returns `AMBIGUOUS_MUTATION`; run `search list` before deciding whether to retry.

## Workflow

```sh
slskd search create --query 'artist album' --lifetime-seconds 60
slskd search candidates '<searchId>'
slskd transfer enqueue '<searchId>' '<candidateId>' --yes
slskd transfer show '<username>' '<transferId>'
```

`search create` passes the query literally to slskd. Lifetime is an integer from **5 to 300 seconds**, default **60**. For slskd 0.26.1, the CLI sends the API timeout in milliseconds because that release interprets the field in milliseconds despite describing it as seconds. The returned `searchId` is slskd's UUID, identical to the ID in `search list`. The lifetime controls response collection; completed Searches and their Candidates remain usable while slskd retains them. The CLI does not impose a separate age limit or store Search state. `search create` returns `{searchId,lifetimeSeconds}`. Previous signed CLI Search references are no longer accepted; use `search list` to obtain the canonical UUID. `search candidates` returns `{searchId,candidates:[...]}`. Each Candidate includes an opaque `candidateId`, username, remote `path`, basename `filename`, extension, byte `size`, queue length, free slot status, upload speed, available audio attributes, and `null` for unavailable metadata. Candidates are never ranked or selected by the CLI.

When given a Search identifier, `transfer enqueue` accepts only the `candidateId` from that Search. It rereads live slskd results, checks slskd Search availability and Candidate association, and requires the literal `--yes`. It first checks slskd's downloads for the same username, remote path, and size; a safe retry returns that Transfer with `existing:true`. A new enqueue uses slskd's batch API and returns an inspectable Transfer. If the request's network outcome is unknown, it returns `AMBIGUOUS_MUTATION` and does not retry it. Inspect slskd Transfer state before issuing another enqueue.

`transfer show` reports slskd state, normalized status (`queued`, `active`, `complete`, `failed`, `cancelled`, or `unknown`), terminal flag, progress, failure detail, and `destination`. **Known limitation:** slskd 0.26.1 does not expose the resolved path for an individual Transfer, so `destination` is `null`. Its configured download root is not necessarily the final file path. A completed slskd Transfer is reported as complete; the CLI does not verify local file contents. Observation works from any new process with the same Connection profile.

## Enqueue a release folder

A Search can return one track while the peer shares a whole release. Discover the selected Candidate's immediate folder, then inspect the returned files before choosing a selection:

```sh
slskd search folder '<searchId>' '<candidateId>' --yes
slskd search folder '<folderRef>' --yes
slskd transfer enqueue '<folderRef>' '<fileId1>' '<fileId2>' --yes
# Alternatively, enqueue every eligible file in the current folder:
slskd transfer enqueue '<folderRef>' --all --yes
slskd transfer show '<username>' '<transferId>'
```

Use the `folderRef` and `fileId` values returned by discovery. These references work across CLI invocations without local Workflow state. Each discovery or refresh requests the directory from that peer and requires `--yes`; it never starts Transfers. The original Search does not need to contain every file in the directory. This uses slskd’s [peer-directory endpoint](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Users/API/Controllers/UsersController.cs), which waits for the peer’s directory response.

Enqueue refreshes the listing before selecting files. Explicit identifiers become invalid if the file's remote path or byte size changes; discover or refresh again and inspect the new selection. `--all` selects the current eligible files, including artwork and other non-audio extras. It excludes nested folders and reports ineligible files under `skipped`. Use explicit file identifiers when you want only particular tracks. Do not combine explicit identifiers with `--all`.

The result contains a `files` array with an `outcome` of `enqueued`, `existing`, `failed`, or `uncertain`, known Transfer details, and aggregate `counts`. Matching existing Transfers are returned without another enqueue. slskd controls the destination. Partial failures return `ok:false` with the per-file `result` preserved and a nonzero exit status; successful Transfers remain queued. An uncertain mutation is never automatically retried: inspect slskd using the returned Transfer identifiers and reconcile its downloads before retrying.

The directory request uses the configured per-request timeout. Unavailable peers, missing directories, and incomplete responses are errors, rather than successful empty releases.

## Watch search candidates

`search create` starts a Search and returns its canonical `searchId` immediately. To monitor Search progress and receive Candidates when slskd exposes them, pass that ID to `search candidates --watch`:

```sh
slskd search create --query 'artist album' --lifetime-seconds 60
slskd search candidates '<searchId>' --watch \
  --poll-interval-ms 1000 \
  --watch-timeout-seconds 300
```

Watch mode writes one newline-delimited JSON record at a time to stdout. Success records use the existing `ok: true` envelope and `result` fields:

```json
{"ok":true,"result":{"event":"started","searchId":"<searchId>"}}
{"ok":true,"result":{"event":"progress","searchId":"<searchId>","state":"InProgress","responseCount":12,"fileCount":48,"lockedFileCount":3}}
{"ok":true,"result":{"event":"candidate","searchId":"<searchId>","candidate":{"candidateId":"<candidateId>","searchId":"<searchId>","username":"peer","path":"Artist/Album/01 - Track.flac","filename":"01 - Track.flac","extension":".flac","size":12345678,"queueLength":0,"hasFreeUploadSlot":true,"uploadSpeed":1200000,"bitRate":900,"length":240,"sampleRate":44100,"bitDepth":16,"isVariableBitRate":false,"isLocked":false}}}
{"ok":true,"result":{"event":"ended","searchId":"<searchId>","reason":"completed","candidateCount":1}}
```

The event types are `started`, `progress`, `candidate`, and `ended`. A `progress` record is emitted on every successful Search-state poll, including the initial and completed snapshots, even if counts have not changed. It contains the daemon's raw `state`, `responseCount` (peer responses), `fileCount`, and `lockedFileCount`; unavailable counts are `null`. These counts describe the daemon's Search, while `candidateCount` describes distinct Candidates emitted by this watch invocation.

slskd 0.26.1 accumulates file results in memory and publishes them through REST only when the Search finalizes. Counts can rise while the Candidate list remains empty. Watch mode therefore provides live progress followed by the available Candidates, rather than promising incremental file results. See the upstream [Search service](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/SearchService.cs).

Agents should keep reading until `ended` with `reason: "completed"`, then evaluate the collected Candidates. Neither unchanged counts, an empty Candidate list, nor a `progress` record with a completed state is the final result signal. `ended` with `reason: "deadline"` means observation stopped early: resume watching the same `searchId` to wait again. Exit 0 alone does not prove Search completion. An `ok: false` record is a failure and must not be treated as a final result set. Retain Candidates across deadline resumptions by `candidateId`, because a new watch replays available Candidates.

Each candidate record contains the full normalized Candidate. `candidateCount` counts distinct Candidate identifiers emitted during this invocation. Repeated or reordered slskd snapshots do not emit the same Candidate twice, and metadata changes for an already emitted Candidate do not produce update records. A new watch has no saved cursor: it replays Candidates currently available from slskd and deduplicates only within that invocation.

`--poll-interval-ms` accepts **100–60,000** and defaults to **1,000**. `--watch-timeout-seconds` accepts **1–3,600** and defaults to **300**. The watch timeout bounds the complete observation, including requests. When slskd reports the Search's `Completed` state, the CLI fetches one final response snapshot, emits any new Candidates, then ends with `reason: "completed"`. slskd 0.26.1 serializes Search states as enum names; `Completed` is the collection-terminal flag and may appear with a reason such as `TimedOut`, `Cancelled`, or `Errored`. The upstream [`Search` model](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/Types/Search.cs), [Search API controller](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/API/Controllers/SearchesController.cs), and [`SearchStates` enum](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/SearchStates.cs) define this contract. An Expired or missing Search is an error, not normal collection completion.

If the observation deadline arrives first, watch mode emits `ended` with `reason: "deadline"` and exits successfully. That means observation ended at its configured bound; it does not mean slskd finished collecting responses. A remote or request failure emits one `ok: false` error record and a nonzero exit status, with no successful `ended` record afterward. SIGINT and SIGTERM stop observation with exit status **130** and **143**, respectively, and do not emit a successful end event. If the stdout consumer closes the pipe, observation stops cleanly. Watch mode is read-only: it does not create, cancel, delete, rank, select, or enqueue anything.

Select a Candidate explicitly from the stream before enqueueing it. For example, after reviewing the `candidate` records, use the chosen values in the existing workflow:

```sh
slskd transfer enqueue '<searchId>' '<candidateId chosen from the candidate event>' --yes
slskd transfer show '<username from that candidate>' '<transferId>'
```

Without `--watch`, `search candidates '<searchId>'` remains a single JSON result containing the current `{searchId,candidates:[...]}` snapshot.

## Transfer mutations

```sh
slskd transfer cancel '<username>' '<transferId>' --yes
slskd transfer clear --yes
slskd transfer delete '<username>' '<transferId>' --yes
```

Every mutation needs its own literal `--yes`. `cancel` leaves completed or already cancelled Transfers unchanged. `clear` invokes slskd's **global clear completed downloads** endpoint. `delete` removes one Transfer record through slskd's `remove=true` endpoint, which may cancel an active Transfer first. These commands do not act on downloaded files.

## Exit codes

| Exit | Meaning                                                                | Error codes                                                                                                                                                                                             |
| ---: | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    0 | Success                                                                | —                                                                                                                                                                                                       |
|    2 | Invalid input or acknowledgement                                       | `INVALID_INPUT`, `INVALID_CONFIG`, `INVALID_CANDIDATE`, `ACKNOWLEDGEMENT_REQUIRED`, `INPUT`                                                                                                             |
|    3 | Missing Connection values                                              | `MISSING_CONFIGURATION`                                                                                                                                                                                 |
|    4 | Authentication or key permissions                                      | `AUTHENTICATION`                                                                                                                                                                                        |
|    5 | Unsupported or unreadable slskd version                                | `INCOMPATIBLE`                                                                                                                                                                                          |
|    6 | Connection failure                                                     | `CONNECTION`                                                                                                                                                                                            |
|    7 | Remote error, unavailable resource, rejected message, partial mutation | `REMOTE`, `MISSING_SEARCH`, `EXPIRED_SEARCH`, `MISSING_CANDIDATE`, `TRANSFER_NOT_FOUND`, `UNAVAILABLE_FOLDER`, `PARTIAL_ENQUEUE`, `MISSING_CONVERSATION`, `MESSAGE_REJECTED`, `PARTIAL_ACKNOWLEDGEMENT` |
|    8 | Read request timeout                                                   | `TIMEOUT`                                                                                                                                                                                               |
|    9 | Unknown mutation outcome                                               | `AMBIGUOUS_MUTATION`                                                                                                                                                                                    |
|  130 | SIGINT during watch observation                                        | —                                                                                                                                                                                                       |
|  143 | SIGTERM during watch observation                                       | —                                                                                                                                                                                                       |

An unknown mutation outcome uses exit 9 and `AMBIGUOUS_MUTATION`, including a timeout after sending a mutation. The CLI does not retry state-changing requests automatically.
