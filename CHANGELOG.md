# Changelog

## Unreleased

### Development

- Create missing annotated version tags after successful `main` CI; preserve existing tags and reject conflicts.
- Document release PR approval, automatic tagging, and the separate future npm publication step.

## 0.1.0-beta.1 — Not published to npm

First public preview of the agent-first `slskd` command, packaged as `slskd-cli`.
The source tag exists. Registry publication remains pending.

### Added

- Search creation, listing, deletion, Candidate inspection, and bounded progress watching.
- Folder discovery and explicit selected-file or all-files enqueue.
- Transfer inspection, idempotent enqueue, cancellation, record deletion, and completed-download clearing.
- Private message inspection, sending, acknowledgement, and bounded watching.
- JSON results, typed exit codes, Connection profiles, request timeouts, and offline command help.
- MIT license, clean package installation checks, and Linux/macOS CI configuration.

### Fixed

- Reject a mismatched Transfer username before inspection, cancellation, or deletion.
- Report `existing:true` when concurrent enqueue finds a Transfer after a batch conflict.

### Preview limits

- Requires Node.js 24 or later and a configured slskd ReadWrite API key.
- Live compatibility check currently passes against slskd `0.26.1.0`; complete live Workflow validation remains pending.
- slskd owns Workflow state and Transfer destinations. The CLI does not verify downloaded files.
- Watch commands cannot promise lossless capture across interruptions or slskd history limits.
- Interrupted mutations can have uncertain outcomes. The CLI does not automatically retry them.
- Windows support remains unverified.
