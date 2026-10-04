# v0.1.1 deployment evidence

Released source: `cc758ce91a170f9b6e5e9977e5fa6c55b714c086`.
[CI release run](https://github.com/liminal-ai/agent-comms/actions/runs/37165135250) passed full checks and published the archive. SHA-256: `c7304d3cf1bc77290e667ad9a072cd10ded461be9e539d08e4f7fb0651f3c87c`.

- `staging-cloud-message.json`: real Claude-LHC thread on T3 staging 13976, released connector after restart, cloud staging. The assertion required exactly one completed run, one reply linked to the request, nonempty answer and replied delivery; it did not require particular model wording. The test thread and project were removed through T3 and the participant retired through comms.
- `production-migration.json`: old self-hosted deployment paused before export, cloud destination paused for import/verification. Comparison of re-exported application documents by table and ID was exact, including creation times, plus stored-file entries. Private exports and SQLite backup are retained outside git. Cloud resumed only after comparison; old backend remains paused/stopped.
- Both web services run the same CI artifact through `current`, with per-environment runtime cloud URLs. Tailnet HTTP/runtime config and connector heartbeat checks passed. Local CLI sockets and T3 stable IDs are distinct. Startup tests reject a different T3 before reading/sending the bearer, and reject an unauthenticated session even if HTTP returns 200.

The original v0.1.0 web launcher exited without listening through a symlink; PR #2 reproduces that ordering in a child-process test and resolves the entrypoint path. All four release tests pass. Production was only promoted after the fixed artifact worked in staging.

Mac and Windows connector instructions are published in platform; those machines were not installed or live-tested in this deployment. Windows currently uses WSL2 because the local connector protocol uses Unix sockets.
