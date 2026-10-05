#!/usr/bin/env node
import { windowsEndpoint } from '../../windows-pipe/src/index.mjs';
// comms-stub: the stub connector. Serves the loopback protocol on the socket,
// with no Convex behind it. See ../README.md.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { SOCKET_ENV, socketPath as defaultSocketPath } from "@agent-comms/protocol";
import { startStubServer } from "./server.ts";
import { type Fixture, StubComms, type StubRecord } from "./state.ts";

const USAGE = `usage: comms-stub --fixture <file.json> [options]

  --fixture <file>     participants, conversations and messages to start with
  --state <file>       persist the record here; on restart, load it instead of the fixture
  --record <file>      append every request and response as JSON lines
  --socket <path>      default: $${SOCKET_ENV}, else the per-user default path
  --machine <id>       this machine's id (default: the fixture's, else "stub")
  --poll-wait <ms>     how long polls are held by default (max 25000)`;

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    state: { type: "string" },
    record: { type: "string" },
    socket: { type: "string" },
    machine: { type: "string" },
    "poll-wait": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const socket =
  values.socket ??
  (process.platform === "win32" ? process.env[SOCKET_ENV] ?? windowsEndpoint() : defaultSocketPath({
    platform: process.platform,
    override: process.env[SOCKET_ENV],
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
    home: homedir(),
    uid: process.getuid?.(),
  }));
if (!socket) {
  console.error("comms-stub: can't work out the socket path; pass --socket");
  process.exit(2);
}

const persist = values.state
  ? (record: StubRecord) => {
      const tmp = `${values.state}.tmp`;
      writeFileSync(tmp, JSON.stringify(record, null, 2));
      renameSync(tmp, values.state!);
    }
  : undefined;

let comms: StubComms;
if (values.state && existsSync(values.state)) {
  const record = JSON.parse(readFileSync(values.state, "utf8")) as StubRecord;
  comms = new StubComms(record, persist ? { onChange: persist } : {});
  console.error(`comms-stub: resumed ${record.deliveries.length} deliveries from ${values.state}`);
} else {
  if (!values.fixture) {
    console.error(USAGE);
    process.exit(2);
  }
  const fixture = JSON.parse(readFileSync(values.fixture, "utf8")) as Fixture;
  const seeded = StubComms.fromFixture(fixture, values.machine ? { machine: values.machine } : {});
  comms = new StubComms(seeded.record, persist ? { onChange: persist } : {});
  persist?.(comms.record);
}

const server = await startStubServer({
  socketPath: socket,
  comms,
  ...(values.record ? { recordPath: values.record } : {}),
  ...(values["poll-wait"] ? { pollWaitMs: Number(values["poll-wait"]) } : {}),
});
console.error(`comms-stub: machine ${comms.record.machine}, listening on ${server.socketPath}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
