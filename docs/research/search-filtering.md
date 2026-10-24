# Search creation and Candidate observation filtering

Research for `slskd-cli-e67`, checked 2026-10-24. This report separates verified upstream behavior from the proposed CLI contract. No production filters are implemented by this investigation.

## Evidence and version scope

The baseline is Compatible slskd 0.26.1, commit `71dcc7a60650b5a61d1d2a35609b65f3467d1396`. The latest published release observed during research is [0.26.2](https://github.com/slskd/slskd/releases/tag/0.26.2), commit `e472ecd706050332c8615dc3b908c92afaed592c`, published 2026-10-23. Comparing these tags shows no changes to the Search controller, request DTO, service, response/file models, or browser filtering implementation; the Soulseek dependency remains 10.0.2. This verifies those two releases, not every future version.

The [official slskd configuration documentation](https://github.com/slskd/slskd/blob/0.26.1/docs/config.md#features) describes optional Swagger/OpenAPI documentation at `/swagger` when the swagger feature is enabled. No live instance configuration was changed to enable it. Exact API details below were checked against the owning controller and DTO, then followed into the dependency where the DTO merely forwards options. Context7's available match was a Python wrapper, so it was not treated as evidence for slskd's implementation.

Primary sources:

- [S1: slskd Search request DTO, 0.26.1](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/API/DTO/SearchRequest.cs).
- [S2: slskd Searches controller, 0.26.1](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/API/Controllers/SearchesController.cs).
- [S3: slskd Search service, 0.26.1](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/SearchService.cs).
- [S4: slskd dependency versions, 0.26.1](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/slskd.csproj).
- [S5: Soulseek.NET SearchOptions, 10.0.2](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/Options/SearchOptions.cs).
- [S6: Soulseek.NET response acceptance, 10.0.2](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/SearchInternal.cs).
- [S7: slskd response model, 0.26.1](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/Types/Response.cs).
- [S8: slskd file model, 0.26.1](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/Types/File.cs).
- [S9: slskd browser filtering, 0.26.1](https://github.com/slskd/slskd/blob/0.26.1/src/web/src/lib/searches.js).
- [S10: Soulseek.NET query parsing, 10.0.2](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/SearchQuery.cs).
- [S11: Soulseek.NET Search dispatch, 10.0.2](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/SoulseekClient.cs).
- [S12: Soulseek.NET file attributes, 10.0.2](https://github.com/jpdillingham/Soulseek.NET/blob/10.0.2/src/File.cs).
- [S13: slskd persisted Search model, 0.26.1](https://github.com/slskd/slskd/blob/0.26.1/src/slskd/Search/Types/Search.cs).

## Verified upstream capabilities

### Creation controls are response acceptance controls

`POST /api/v0/searches` accepts a Search request, calls `SearchQuery.FromText`, fixes the scope to the network, and forwards request options to Soulseek.NET. The request does not expose arbitrary response/file predicates. Although the internal conversion method accepts callbacks, the REST controller does not supply them. Neither a peer username scope nor filename, extension, size, audio-quality, or free-slot criteria are exposed in this DTO. [S1, S2]

| Request field              | Effective behavior in 0.26.1 / 0.26.2                                        | Default if omitted |
| -------------------------- | ---------------------------------------------------------------------------- | ------------------ |
| `searchText`               | Required nonblank string, parsed by upstream                                 | None               |
| `id`                       | Optional caller-provided Search UUID                                         | New UUID           |
| `filterResponses`          | Enables response acceptance criteria and any internal callbacks              | `true`             |
| `minimumResponseFileCount` | Accept response when unlocked + locked file count is at least this value     | `1`                |
| `maximumPeerQueueLength`   | Reject response when queue length is **greater than or equal to** this value | `2147483647`       |
| `minimumPeerUploadSpeed`   | Reject response when reported upload speed is below this value               | `0`                |
| `responseLimit`            | Complete after accepted response count reaches threshold                     | `250`              |
| `fileLimit`                | Complete after accepted unlocked-file count reaches threshold                | `25000`            |
| `searchTimeout`            | Inactivity timeout reset after accepted response, in **milliseconds**        | `15000`            |

The table follows executable defaults in Soulseek.NET 10.0.2, the version pinned by slskd, and acceptance logic rather than stale DTO comments. Those comments incorrectly describe a seconds-based timeout and older limits. Numeric DTO ranges are nonnegative signed 32-bit integers, except `searchTimeout`, whose DTO lower bound is 5. `filterResponses=false` bypasses the minimum count, queue, and speed checks; limits still govern completion. Queue comparison is exclusive at the configured maximum, unlike a typical inclusive CLI maximum. Response/file limits terminate after accepting a whole response, so they are completion thresholds rather than strict truncation guarantees. [S1, S4–S6]

These options filter responses received by slskd; they do not add predicates to the network Search request sent to peers. The dispatched network message contains Search text and token. They can reduce stored/returned results but cannot be promised to reduce incoming peer traffic. Local observation filtering reduces CLI output only, and still fetches the complete REST response list. [S6, S11]

There is no `minimumFileSize`, `minFileSize`, or arbitrary file-filter request field in the REST DTO. A similarly named filter exists in the browser UI: its `minfs`/`minfilesize` parser populates `minFileSize`, which compares the file's raw byte size in JavaScript after retrieval. The browser also provides text include/exclude and audio-related filters; these are not Search creation API contracts. [S1, S9]

### Observation endpoint and query semantics

`GET /api/v0/searches/{id}/responses` returns the complete persisted response collection and declares no filter, pagination, or cursor parameters. `GET /api/v0/searches/{id}` optionally includes responses through `includeResponses`; it likewise has no Candidate predicates. Both return 404 for an unknown Search. [S2]

The CLI's literal Search query contract means it forwards the supplied text unchanged in `searchText`; it cannot promise byte-for-byte upstream interpretation. Soulseek.NET parses leading `-term` tokens as exclusions and removes single-character Search terms by default before dispatch. The CLI must neither emulate this parser nor rewrite the query to encode its own filters. [S2, S5, S10, S11]

### Candidate metadata support and limits

| Selection information  | Upstream location                                                       | Availability and caveat                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Source username        | Response `username`                                                     | Peer response value; not a live identity lookup                                                                                    |
| Remote path / filename | File `filename`                                                         | Full remote filename; CLI derives basename                                                                                         |
| Format                 | File `extension`                                                        | Reported extension; does not prove codec/container contents                                                                        |
| Byte size              | File `size`                                                             | 64-bit upstream integer; CLI uses JavaScript numbers, so precise matching above safe-integer range needs explicit policy           |
| Queue length           | Response `queueLength`                                                  | Snapshot from response; not continuously refreshed peer status                                                                     |
| Free upload slot       | Response `hasFreeUploadSlot`                                            | Snapshot; cannot guarantee immediate enqueue availability                                                                          |
| Upload speed           | Response `uploadSpeed`                                                  | Peer-reported response value; not measured transfer throughput                                                                     |
| Audio attributes       | File `bitRate`, `length`, `sampleRate`, `bitDepth`, `isVariableBitRate` | Nullable parsed attributes; unknown values are normal                                                                              |
| Locked status          | Separate `files` and `lockedFiles` collections                          | CLI uses collection membership as fallback; slskd's file mapping does not itself set `isLocked=true` for locked collection entries |

The response and file models copy metadata from Soulseek.NET responses. Numeric audio properties are nullable there, and the CLI normalizes absent or invalid fields to null. File-size units are explicitly bytes in the dependency source. Neither extension nor nullable audio attributes justify inferring a lossless codec with certainty. [S7, S8, S12; local Candidate normalization]

### REST delivery and freshness limitation

Source inspection shows that the Search service accumulates accepted responses in memory during collection. Its response callback updates counts, while response records are assigned to `search.Responses` and persisted at finalization. REST `FindAsync` reads the database. Thus response polling can observe growing Search counts while still seeing an empty response collection, then receive a final batch. This is a source-derived conclusion, not a live timing measurement. [S3, S13]

There is also a finalization window: the upstream completed state callback writes Search state before the later write that persists the response collection. A poll can therefore observe `Completed` and an empty list before the final batch is available. A watch implementation that treats that snapshot as definitive may end early. The research does not establish how frequently this occurs in practice; deterministic regression modeling and a separate compatibility decision are required before promising complete live streaming. Adding local predicates alone does not solve delivery timing. [S3, S11]

Queue and slot values are snapshots in persisted Search responses. Source does not establish a background refresh contract for these values. Define behavior if later snapshots differ, but do not describe watch filtering as a live peer-availability monitor. [S3, S7]

## Representative payloads

These are synthetic examples derived from the source models, not captured live responses or evidence of timing. Unknown JSON properties are not presented as supported controls.

A creation request using verified upstream fields:

```json
{
  "searchText": "isolee - rest",
  "searchTimeout": 60000,
  "filterResponses": true,
  "maximumPeerQueueLength": 11,
  "minimumPeerUploadSpeed": 0,
  "minimumResponseFileCount": 1
}
```

Here queue lengths 0 through 10 satisfy the upstream queue threshold. This says nothing about free slots or file format. The existing CLI currently sends only the literal `searchText` and converted `searchTimeout`. [S1, S6; local Search creation]

A representative `GET /api/v0/searches/{id}/responses` collection:

```json
[
  {
    "username": "example-peer",
    "hasFreeUploadSlot": true,
    "queueLength": 2,
    "uploadSpeed": 1048576,
    "fileCount": 1,
    "files": [
      {
        "filename": "Music\\Isolee\\Rest\\01.flac",
        "extension": "flac",
        "size": 31457280,
        "bitRate": null,
        "length": 300,
        "sampleRate": 44100,
        "bitDepth": 16,
        "isVariableBitRate": null,
        "isLocked": false,
        "code": 1
      }
    ],
    "lockedFileCount": 0,
    "lockedFiles": [],
    "token": 12345
  }
]
```

The file can match extension/size/sample-rate criteria while failing a strict minimum-bitrate predicate because `bitRate` is unknown. The CLI must preserve its Search-scoped Candidate identifier independently of whether a view includes this file. [S7, S8; local Candidate normalization]

## Recommended command contract (design, not implemented)

Start with local observation filters on `search candidates`, shared by one-shot and `--watch`. This directly reduces the output a calling agent must inspect while allowing a different agent to inspect the same retained Search with different criteria. It does not reduce peer traffic, slskd storage, or the response payload fetched by the CLI. Keep `search create` unchanged in the first release: send the literal `--query` as `searchText`, with the existing lifetime conversion, and leave upstream defaults intact.

Do not put observation flags on creation: criteria would be lost between independent invocations unless persisted or confused with destructive collection controls. Do not rewrite the Search query. Explicit upstream collection controls can be a later, separate interface once there is a concrete demand to reduce collection. Their help must explain that discarded results cannot be recovered by relaxing a local predicate on that Search.

### Initial filter set

All flags below are proposed, not currently accepted. They are valid only on `search candidates`, with identical matching in one-shot and watch mode. Each may occur once; repeated flags, including identical repetitions, remain `INVALID_INPUT` with exit 2. Different flags combine with AND. No implicit OR lists, comma splitting, regular expressions, globs, or negation.

| Proposed flag                   | Match on normalized Candidate          | Validation and comparison                                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--extension <extension>`       | `extension`                            | One ASCII alphanumeric extension, optionally prefixed by one dot; strip the dot and compare ASCII lowercase values. `.FLAC` and `flac` match `.flac` and `FLAC`. Do not infer an extension from the path when metadata is missing.                                     |
| `--path-contains <text>`        | full remote `path`, including basename | Nonempty and not whitespace-only. Literal substring after locale-independent Unicode lowercase of both operands; preserve supplied spaces. Normalize backslashes to forward slashes in both operands for comparison only. No Unicode normalization or transliteration. |
| `--username <username>`         | `username`                             | Nonempty and not whitespace-only. Exact case-sensitive equality, preserving spaces; this deliberately avoids inventing peer identity equivalence.                                                                                                                      |
| `--min-size-bytes <integer>`    | `size >= value`                        | Decimal digits only, safe integer, range 0 through `Number.MAX_SAFE_INTEGER`; inclusive bytes.                                                                                                                                                                         |
| `--max-size-bytes <integer>`    | `size <= value`                        | Same integer rules and units; inclusive bytes. If both bounds exist, minimum must not exceed maximum.                                                                                                                                                                  |
| `--min-bit-rate-kbps <integer>` | `bitRate >= value`                     | Decimal digits only, positive safe integer; inclusive kilobits per second, not bytes per second. This is an attribute threshold, not a quality ranking or codec equivalence claim.                                                                                     |
| `--free-slot`                   | `hasFreeUploadSlot === true`           | Boolean switch with no value. It describes the Search response's availability snapshot, not a reservation or a fresh peer status request.                                                                                                                              |

For numeric predicates, missing, nonfinite, negative, fractional, or unsafe-integer Candidate attribute values fail the active predicate. Do not coerce strings to numbers or round metadata. This defensive policy applies only when evaluating a numeric filter; it does not change the existing normalization/output schema for unfiltered Candidates. Bit rate must additionally be positive to match. A nullable field fails a predicate that depends on it; it does not disqualify a Candidate from unrelated filters. Known false is distinct from null, but both fail `--free-slot`. Locked Candidates remain included unless another predicate excludes them; these flags make no promise of download access.

Defer sample-rate, bit-depth, duration, VBR, locked-file, maximum queue, and upload-speed flags. Their metadata remains available for explicit agent inspection; the initial set covers format, relevance, size, one common audio constraint, source, and advertised availability. Defer basename-specific matching because the full path already includes it. Defer multiple extensions and arbitrary expression syntax to avoid a new query language and parser expansion before there is evidence of need. An AND between valid but incompatible metadata constraints simply yields no matches; only malformed values or reversed size bounds are input errors.

### Requests, outputs, and errors

Validate flag values, command placement, and Search identifier before reading the Connection profile or contacting slskd, including its compatibility endpoint. This guarantees deterministic exit-2 failures for malformed filter input. Existing handling of missing configuration, incompatible versions, authentication, request failures, missing/expired Searches, and ambiguous mutations is unchanged for valid inputs.

After compatibility and Search availability checks, fetch the same unfiltered `GET /api/v0/searches/{id}/responses` snapshots as today. Do not send local predicate flags as upstream request fields or query parameters. Normalize first, then evaluate the predicates; share the same matching policy between one-shot and watch observation. Preserve source order and Candidate metadata. No sorting, ranking, automatic selection, extra status requests, or mutations.

One-shot success retains `{ok:true,result:{searchId,candidates:[...]}}`; the Candidate array contains only matches. Empty matches are successful with `candidates:[]`. Preserve the existing one-shot wrapper's input-casing behavior for `searchId`; each normalized Candidate and every watch event uses the canonical lowercase Search ID. This casing distinction is existing behavior, not a filtering change. Candidate identifiers continue to depend only on canonical Search ID, username, remote path, and size, never filters or output position.

Filtered IDs remain valid inputs to `transfer enqueue <searchId> <candidateId> --yes`. Enqueue must resolve against the full, unfiltered Search rather than the previous invocation's predicates; metadata availability can change and a free slot is not guaranteed by selection. Keep literal acknowledgement, idempotent enqueue, and ambiguous-mutation reconciliation unchanged. No filter state survives the process.

Examples below describe the proposed future interface:

```sh
# Unchanged Search creation: no inferred constraints or text rewriting.
slskd search create --query 'isolee - rest' --lifetime-seconds 60

# Inspect only matching files from an existing Search.
slskd search candidates '<searchId>' --extension flac --path-contains 'rest' \
  --min-size-bytes 1000000 --max-size-bytes 100000000

# Observe matching arrivals and replay existing matching Candidates.
slskd search candidates '<searchId>' --watch --extension .FLAC --free-slot \
  --poll-interval-ms 1000 --watch-timeout-seconds 300

# Inspect a specific source and a bit-rate threshold without ranking.
slskd search candidates '<searchId>' --username 'peer' --min-bit-rate-kbps 320

# Explicitly enqueue the Candidate selected from either output form.
slskd transfer enqueue '<searchId>' '<candidateId>' --yes

# Invalid: reversed bounds, exit 2 before any request.
slskd search candidates '<searchId>' --min-size-bytes 200 --max-size-bytes 100

# Invalid: observation-only predicate on creation, exit 2 before any request.
slskd search create --query 'isolee - rest' --extension flac
```

If bit rate is null, a Candidate fails `--min-bit-rate-kbps 320` but can still match `--extension flac`. If every result is MP3, `--extension flac` returns an empty array or a watch stream with no Candidate events; neither means the upstream Search collected no results. The existing `search list` counts remain upstream summary values, not filtered totals.

## Watch contract

Keep the existing success envelope and event types `started`, `candidate`, and `ended`. Do not add update, removal, heartbeat, filtered-total, or progress events in this release.

The upstream REST finalization window described above remains a compatibility risk. The rules below define matching over snapshots actually returned; they do not prove the current final snapshot contains every collected response. Resolve the follow-up before promising complete watch delivery.

1. Validate options, connect, verify compatibility, and validate the Search and state as today; emit one `started` event with canonical Search ID after successful attachment.
2. Evaluate the first response snapshot using the same predicates as one-shot mode. Replay matching Candidates in source order.
3. For every later snapshot, normalize and evaluate each Candidate. An identifier enters the invocation-local emitted set only when it matches and its Candidate event is yielded. A nonmatching Candidate must not be marked as emitted.
4. A previously nonmatching Candidate that later matches may emit once. An already emitted identifier never emits again, even if metadata changes, it stops matching, disappears, or later matches again. Duplicate/reordered snapshots do not duplicate events. There are no retractions. If identity inputs change, the existing identifier contract treats it as a different Candidate.
5. `ended.candidateCount` is the number of distinct matching Candidate identifiers emitted in this invocation, not received files, current matches, peer responses, or the upstream Search summary's file count. Count only yielded matching Candidate events.
6. When slskd reports the `Completed` flag, fetch the final snapshot, emit any previously unseen matches, and then emit `ended` with reason `completed`. Active Searches with no matches continue polling; all-nonmatching results never imply completion.
7. At the observation deadline, emit `ended` with reason `deadline`, the emitted-match count, and exit 0. Completion and deadline remain independent of match count. An already completed Search can emit `started` followed by `ended/completed` with count 0.
8. Preserve existing failure and lifecycle behavior: one typed error record with nonzero exit on a read/remote failure, no subsequent successful `ended`; SIGINT/SIGTERM exit 130/143 without successful termination; closed stdout stops observation cleanly; honor backpressure and abort in-flight reads/waits. Never mutate or cancel the Search.
9. A new invocation has a new emitted set and may replay all current matches. There is no durable offset or cache.

Availability is the data stored in a Search response, not a live Transfer estimate. The match-transition rule is defensive behavior for changing snapshots, not a claim that slskd refreshes every peer's queue or free-slot metadata while a Search is retained. A peer's real availability may change without any corresponding Search response update.

## Deterministic acceptance matrix

Use one existing seam: spawn the packaged CLI against a fake slskd HTTP server. Assert externally observable requests, JSON/NDJSON records, metadata and IDs, exit status, cleanup, and absence of mutations. Existing one-shot Workflow tests and watch response gates/event readers are prior art. Do not test private predicate calls or add production injection seams. These are proposed implementation tests, not tests added by this investigation.

| Scenario                        | Controlled input/action                                                                                                                                        | Observable acceptance                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Literal creation                | Query containing spaces, punctuation, and filter-looking words                                                                                                 | POST preserves `searchText` byte-for-byte; lifetime conversion and defaults unchanged; no extra fields.                                                                                                         |
| Filter placement and validation | Invalid command placement, repeated flag, missing value, empty text, invalid extension, decimal/exponent/signed/unsafe integer, zero bit rate, reversed bounds | `INVALID_INPUT`, exit 2, one JSON error, zero HTTP requests (including compatibility).                                                                                                                          |
| Format and text                 | Mixed `.FLAC`/`flac`, MP3, slash directions, filename/path case, literal regex/glob punctuation, username case                                                 | Only documented matches, unchanged metadata and source order; no pattern expansion or peer-name folding.                                                                                                        |
| Numeric boundaries              | Equal bound, just below/above, zero size, exact min=max, bit-rate threshold                                                                                    | Inclusive comparisons, correct units, no coercion or rounding.                                                                                                                                                  |
| Unknown metadata                | Null, omitted, string, nonfinite-equivalent invalid numeric input, negative/fractional/unsafe values; false/null/true slot state                               | Fail only predicates needing unavailable or invalid metadata; unrelated missing fields do not exclude matches. Use JSON-representable invalid values; do not attempt to serialize NaN/Infinity as JSON numbers. |
| Composition                     | Each individual flag plus all seven together on a mixed snapshot                                                                                               | AND across flags, repeated flags rejected, no implicit comma-list OR, deterministic empty matches.                                                                                                              |
| One-shot empty                  | Nonempty upstream results all fail predicates                                                                                                                  | Successful existing envelope with empty Candidate array; GET snapshot unfiltered, no upstream predicate parameters.                                                                                             |
| Stable identity and enqueue     | Same Candidate observed with/without predicates and uppercase Search input                                                                                     | Canonical Search ID within Candidates/watch and identical opaque Candidate ID; one-shot wrapper preserves input casing; explicit enqueue rereads full Search and keeps acknowledgement/idempotence behavior.    |
| Replay and duplicates           | Gate first snapshot with matches/nonmatches, then reordered and duplicated responses                                                                           | `started`, each distinct matching Candidate once; excluded identifiers do not enter emitted set.                                                                                                                |
| Match transition                | Gate A nonmatching, then A matching, then A nonmatching, then matching again                                                                                   | A emits exactly once at first matching snapshot; no updates or removals. Include unknown-to-known metadata transition.                                                                                          |
| Identity change                 | Same path/peer with changed size in a later snapshot                                                                                                           | Existing identifier semantics preserved; changed identity can emit as a new Candidate if it matches.                                                                                                            |
| Final drain                     | Hold final snapshot until server reports `Completed, TimedOut`, then supply new matches                                                                        | Final unseen matches precede `ended/completed`; count equals distinct emitted matches.                                                                                                                          |
| Zero matches completed          | Completed Search with only nonmatches or empty responses                                                                                                       | `started`, `ended/completed`, count 0, exit 0.                                                                                                                                                                  |
| Zero matches active/deadline    | Keep Search active; release nonmatches and observe later requests; hold subsequent response until real watch deadline                                          | Keeps polling while active; `ended/deadline`, count 0, exit 0; pending read aborted. No sleep schedules Candidate arrivals.                                                                                     |
| Errors and expiry               | Gate typed HTTP/auth/timeout failures or missing/expired state after attachment                                                                                | Existing typed nonzero outcome, no successful `ended`; filtered-out responses do not hide errors.                                                                                                               |
| Lifecycle                       | Interrupt while reads/waits/output are pending, or disconnect stdout; large matching snapshot for backpressure                                                 | Existing 130/143/pipe-close behavior, bounded cleanup, no later polls after stop, no Search/Transfer mutation.                                                                                                  |
| Unfiltered regression           | Run original one-shot/watch examples with no filters                                                                                                           | Same Candidate order, data, event types, deduplication and counts.                                                                                                                                              |

Request barriers must release snapshot N only after the test observes the corresponding request/event. Event reads establish output ordering. For exclusion-only snapshots, observing the next response request establishes progress without inventing an empty-result event. Use bounded test-runner timeouts for hangs and actual watch/request deadlines only for deadline tests; never sleep to make a Candidate arrive.

## Proposed implementation slices

These are future implementation proposals, not additional requirements to implement within this spike. Each slice includes parser/help, behavior, documentation, and CLI-boundary tests. No preparatory refactor is necessary: the existing normalized Candidate and observation paths provide the seam.

1. **Filter one-shot and watch Candidates by extension.** Gated on resolving the REST finalization compatibility follow-up below before claiming complete watch delivery. Add `--extension` validation/placement, shared matching, existing Search ID behavior, predicate-before-dedup behavior, and matching-event counts. Acceptance: mixed format replay/arrivals, zero matches, unknown extension, deduplication, final drain, stable IDs/enqueue, offline help, invalid flags before network, and unfiltered regressions. Document all watch match-transition/lifecycle invariants from the start.
2. **Narrow Candidates by remote path and source username.** Blocked by 1. Add the two string predicates end to end with literal comparison rules. Acceptance: slash/case/space handling, exact peer identity, nulls, AND with extension, duplicate rejection, and one-shot/watch equivalence. Keep output paths unchanged.
3. **Apply size and bit-rate bounds to Candidate observation.** Blocked by 1; can proceed independently of 2. Add the three numeric flags end to end. Acceptance: lexical validation, safe-integer limits, inclusive bounds, min/max contradictions, missing/invalid metadata, AND combinations with extension, unchanged event counts and identifiers, help and examples.
4. **Filter Candidates by advertised free upload slot.** Blocked by 1; independent of 2 and 3. Add `--free-slot` end to end, with explicit snapshot limitation. Acceptance: true/false/null metadata, previously excluded-to-matching snapshots, no re-emission after later transitions, empty matches and terminal counts, no availability refresh or mutation.

Each slice must pass lint, formatting, typechecking, and the full test suite; focused one-shot/watch tests should drive behavior first at the agreed seam. Once all slices land, verify the all-seven composition scenario as part of the last landing slice. The shared matching contract should not require separate parser or matcher-only tickets.

## Alternatives and scope boundaries

- **Expose every upstream creation option now:** useful for collection limits, but not a substitute for file-level observation predicates; it can irreversibly remove discovery data. Defer to a separate request, with explicit upstream-oriented names and exact version-tested payload semantics.
- **Rewrite query text to encode extension/size filters:** rejects the literal Search query contract and relies on peer-specific query behavior. Not recommended.
- **Fetch all Candidates and pipe through an external JSON tool:** works today and is flexible for one-shot results, but leaves watch deduplication/match transitions and validation to every caller. Retain as an escape hatch for deferred fields.
- **Push predicates into the GET responses endpoint:** only justified if upstream actually implements those predicates. Do not invent undocumented query parameters.
- **Persistent saved filters or Workflow state:** unnecessary for invocation-local observation and contrary to the ADR that slskd owns Workflow state. No persistent schema changes.
- **Ranking, auto-enqueue, live peer refresh, or guaranteed availability:** separate features. Candidate matching is an observation aid and preserves explicit selection.

No change to the glossary's Search query or Workflow state definitions is required. A future implementation should document observation filtering under Candidate metadata, amend command help and usage examples. No ADR replacement is needed. Existing output envelopes, event schemas, Search ID casing behavior, and Candidate shape remain unchanged.

## Recorded follow-ups

- `slskd-cli-6vc` (P1): verify and resolve the source-derived gap between completed state and persisted REST responses. Model the race deterministically and choose a bounded policy using verified upstream signals; a fixed delay is not evidence of finalization. This gates a complete-delivery claim for filtered watch implementation, not completion of this research.
- `slskd-cli-e1p` (P2): verify and correct locked Candidate metadata where upstream `lockedFiles` entries contain `isLocked:false`. Collection membership may need to take precedence over the upstream default. This does not gate the proposed initial filters because no locked-status predicate is included.

The investigation tickets are `slskd-cli-e67.1` (upstream evidence), `slskd-cli-e67.2` (creation/one-shot contract), and `slskd-cli-e67.3` (watch and handoff). Production implementation tickets above remain proposals until that work is authorized.
