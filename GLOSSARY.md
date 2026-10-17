# slskd CLI

This project provides an agent-first command-line interface for a trusted user's local slskd instance.

## Language

**Agent-first CLI**:
A command-line interface with machine-readable results, stable exit codes, and non-interactive operation suitable for an agent or automation to compose.
_Avoid_: conversational CLI, human-only CLI

**slskd instance**:
The single, trusted local deployment of slskd that this CLI controls.
_Avoid_: service account, remote control plane

**Connection profile**:
The locally configured slskd base URL and API key used by the CLI to authenticate to its slskd instance. It is stored in a narrow TOML file and is overridden by environment variables and then command-line flags.
_Avoid_: embedded credential, anonymous connection

**ReadWrite API key**:
The least-privilege slskd API key role required by this CLI to query searches and create or cancel transfers.
_Avoid_: Administrator key, ReadOnly key

**Compatible slskd**:
A configured slskd instance at version 0.26.1 or later that passes the CLI's compatibility check before workflow commands run.
_Avoid_: best-effort server, unverified version

**Workflow**:
A repeatable agent-executed sequence that discovers content through slskd, selects files, enqueues them, and observes transfer completion.
_Avoid_: chat session, manual procedure

**Candidate**:
A search result exposed by slskd that a calling agent explicitly evaluates and selects before it is enqueued.
_Avoid_: automatic match, best result

**Candidate identifier**:
An opaque reference to one candidate within a particular search; it is supplied with that search's identifier to enqueue the candidate.
_Avoid_: filename, reconstructed peer path

**Candidate metadata**:
The normalized selection information returned for a candidate: source username, remote path, filename, extension, byte size, queue or slot availability, and available parsed audio attributes.
_Avoid_: hidden score, automatic match

**Search**:
A slskd-backed discovery operation whose candidates are retrieved and inspected by the calling agent.
_Avoid_: automatic acquisition, recommendation

**Search identifier**:
The opaque reference returned when a search is created and supplied when its candidates are later queried.
_Avoid_: search query, keyword string

**Expired search**:
A search whose configured bounded lifetime has elapsed and whose candidates must no longer be used; it defaults to 60 seconds, and an agent creates a new search to obtain current availability.
_Avoid_: current search, reusable query

**Search query**:
The single literal free-text string supplied by the calling agent when it creates a search; the CLI does not rewrite it or infer filters.
_Avoid_: query DSL, rewritten query

**Transfer**:
The slskd-managed download created when a selected candidate is enqueued; its reported completed status is the workflow's completion authority.
_Avoid_: locally verified file, CLI job

**Transfer destination**:
The slskd-configured download location, which the CLI only reports and never chooses, modifies, or deletes.
_Avoid_: CLI output directory, managed file

**Idempotent cancellation**:
A cancellation request that reports a completed or already-cancelled transfer as an unchanged terminal resource, allowing retries to converge on the intended inactive state.
_Avoid_: cancellation failure, repeated cancellation

**State-changing command**:
A CLI command that modifies the slskd instance, such as enqueuing, cancelling, clearing, or deleting a transfer. It requires its own literal `--yes` acknowledgement.
_Avoid_: query, inspection command

**Workflow state**:
Search and transfer state held by slskd, which the CLI queries rather than duplicating in a separate workflow-run database.
_Avoid_: local run state, CLI state store

**Idempotent enqueue**:
An enqueue operation that reports an existing matching transfer rather than creating another one when it is safely retried.
_Avoid_: duplicate enqueue, blind retry

**Ambiguous mutation**:
A state-changing request whose network outcome is unknown; the calling agent must reconcile it by querying slskd rather than relying on an automatic retry.
_Avoid_: safely retried mutation, assumed failure

**Request timeout**:
The per-request deadline, defaulting to 30 seconds, after which the CLI returns a typed timeout error rather than waiting indefinitely.
_Avoid_: unbounded request, silent hang
