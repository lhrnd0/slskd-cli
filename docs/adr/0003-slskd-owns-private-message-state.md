# slskd owns private-message state

slskd remains the sole persistent authority for Conversations and Private messages; the CLI will not maintain a separate message archive. This extends the existing state-ownership boundary and avoids inconsistent acknowledgement and history state across clients, at the cost of accepting slskd's limited history window and being unable to promise complete historical retrieval or lossless catch-up after interruptions. Inspecting and watching messages do not acknowledge them; Message acknowledgement is a separate explicit state-changing command.
