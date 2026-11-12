# Use Effect for operations and explicit services

The CLI uses Effect 4.1.4 for configuration, requests, operations, watch streams, and command parsing.
Typed failures keep operational errors visible in Effect signatures.
Explicit services supply the Connection profile and authenticated requests.
The runtime provides cancellation across the complete request, including response body reads.

This adds a production dependency and requires contributors to understand Effect services, layers, and cancellation.
Pure calculations and identifier generation remain ordinary functions.
Native fetch and the existing TOML parser remain at the system boundaries.
The current services do not require a separate Node platform package.

Public commands, JSON, operational errors, and exit codes remain stable during the migration.
Temporary Promise adapters map typed failures to the existing public errors until all commands use Effect.
Internal HTTP failures retain numeric status values for operation decisions.
Adapters preserve existing HTTP status message text for commands awaiting migration.
Request timeouts cover headers and complete bodies.
External cancellation retains its original reason and takes precedence when it first aborts the request.
Requests have no automatic retries, and state-changing requests remain sequential.

slskd remains the authority for Workflow state, Conversations, and Private messages.
The CLI adds no persistent state, message archive, or watch cursor.
The built CLI subprocess remains the contract test boundary.
