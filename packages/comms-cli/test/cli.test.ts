import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StubComms, startStubServer, type StubServer } from "@agent-comms/connector-stub";
import { EXIT, run } from "../src/cli.ts";

const root = await mkdtemp(join(tmpdir(), "comms-cli-test-"));
const socket = join(root, "agent-comms", "connector.sock");
let server: StubServer;

before(async () => {
  const comms = StubComms.fromFixture({
    machine: "box",
    participants: [
      { name: "lee", kind: "human", home: { harness: "web" } },
      { name: "cedar" },
      { name: "hazel" },
      { name: "far", home: { machine: "elsewhere" } },
    ],
    conversations: [{ id: "g1", kind: "group", title: "build", members: ["lee", "cedar", "hazel"] }],
  });
  server = await startStubServer({ socketPath: socket, comms, pollWaitMs: 50 });
});
after(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function comms(args: string[], options: { env?: Record<string, string>; stdin?: string } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(["--socket", socket, ...args], {
    env: options.env ?? {},
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    readStdin: async () => options.stdin ?? "",
  });
  return { code, stdout, stderr };
}

describe("comms CLI against the stub", () => {
  it("sends a DM request and reports the delivery", async () => {
    const r = await comms(["send", "--as", "cedar", "@hazel", "please", "review", "M0"]);
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.match(r.stdout, /^sent m_\d+ \(#1 in c_\d+\)\n  → @hazel: delivery d_\d+ pending\n$/);
  });

  it("sends in a group, addressing some members", async () => {
    const r = await comms(["send", "--as", "cedar", "--conversation", "g1", "@hazel", "@lee", "status?"]);
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.match(r.stdout, /→ @hazel: delivery/);
    assert.doesNotMatch(r.stdout, /@lee: delivery/, "humans read in the web view");
    const quiet = await comms(["send", "--as", "cedar", "--conversation", "g1", "just a note"]);
    assert.match(quiet.stdout, /wakes no one/);
  });

  it("takes --as from AGENT_COMMS_PARTICIPANT and text from stdin", async () => {
    const r = await comms(["send", "@cedar", "-"], { env: { AGENT_COMMS_PARTICIPANT: "hazel" }, stdin: "line one\nline two\n" });
    assert.equal(r.code, EXIT.ok, r.stderr);
    const read = await comms(["read", "--as", "cedar", r.stdout.match(/in (c_\d+)/)![1]!]);
    assert.match(read.stdout, /@hazel → @cedar \[m_\d+\]\n  line one\n  line two\n/);
  });

  it("replies with inReplyTo, reads history and lists conversations", async () => {
    const sent = await comms(["send", "--as", "hazel", "@cedar", "is M0 in?"]);
    const messageId = sent.stdout.match(/^sent (m_\d+)/)![1]!;
    const conversation = sent.stdout.match(/in (c_\d+)/)![1]!;
    const reply = await comms(["reply", "--as", "cedar", messageId, "yes"]);
    assert.equal(reply.code, EXIT.ok, reply.stderr);
    assert.match(reply.stdout, new RegExp(`^answered ${messageId} with m_\\d+`));

    const read = await comms(["read", "--as", "hazel", conversation, "--limit", "2"]);
    assert.match(read.stdout, new RegExp(`@cedar → @hazel \\(answer to ${messageId}\\)`));
    assert.match(read.stdout, /showing #\d+-#\d+; older: --before \d+/);

    const list = await comms(["list", "--as", "hazel"]);
    assert.match(list.stdout, new RegExp(`^${conversation}  dm with @cedar  last #\\d+, 0 unread$`, "m"));
    assert.match(list.stdout, /g1  group "build", 3 members/);
  });

  it("prints the connector's response with --json", async () => {
    const r = await comms(["status", "--json"]);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.implementation, "stub");
  });

  it("shows status in plain text", async () => {
    const r = await comms(["status"]);
    assert.match(r.stdout, /^stub on box, protocol v1\n/);
    assert.match(r.stdout, /@cedar \(agent, active\) claude-code:cedar/);
  });

  it("exits 1 with the connector's error code", async () => {
    const r = await comms(["send", "--as", "far", "@cedar", "hi"]);
    assert.equal(r.code, EXIT.error);
    assert.match(r.stderr, /^comms send: not_homed_here: /);
    const unknown = await comms(["reply", "--as", "cedar", "m_999", "x"]);
    assert.match(unknown.stderr, /unknown_message/);
  });

  it("exits 2 on usage errors", async () => {
    assert.equal((await comms([])).code, EXIT.usage);
    assert.equal((await comms(["send", "@cedar", "hi"])).code, EXIT.usage, "no --as");
    assert.equal((await comms(["send", "--as", "cedar", "@a", "@b", "hi"])).code, EXIT.usage, "two names, no conversation");
    assert.equal((await comms(["send", "--as", "cedar", "@hazel"])).code, EXIT.usage, "no text");
    assert.equal((await comms(["read", "--as", "cedar", "g1", "--limit", "0"])).code, EXIT.usage);
    assert.equal((await comms(["frobnicate"])).code, EXIT.usage);
    assert.equal((await comms(["--help"])).code, EXIT.ok);
  });

  it("exits 3 when no connector is listening", async () => {
    const r = await run(["--socket", join(root, "nothing.sock"), "status"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      readStdin: async () => "",
    });
    assert.equal(r, EXIT.unreachable);
  });

  it("runs as a real binary, quickly", async () => {
    const bin = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const started = Date.now();
    const { stdout } = await promisify(execFile)(bin, ["status"], { env: { ...process.env, AGENT_COMMS_SOCKET: socket } });
    const elapsed = Date.now() - started;
    assert.match(stdout, /^stub on box/);
    assert.ok(elapsed < 1500, `took ${elapsed}ms`);
  });
});

describe("fix pass 3.7", () => {
  it("3.7 accepts text starting with -, and -- before text that looks like options", async () => {
    const a = await comms(["send", "--as", "cedar", "@hazel", "-1", "is", "the", "answer"]);
    assert.equal(a.code, EXIT.ok, a.stderr);
    const b = await comms(["send", "--as", "cedar", "@hazel", "--", "--as", "is", "text", "here"]);
    assert.equal(b.code, EXIT.ok, b.stderr);
    const conversation = b.stdout.match(/in (c_\d+)/)![1]!;
    const read = await comms(["read", "--as", "hazel", conversation, "--limit", "2"]);
    assert.match(read.stdout, /\n  -1 is the answer\n/);
    assert.match(read.stdout, /\n  --as is text here\n/);
  });
});

describe("fix pass 3.1", () => {
  it("3.1 a send repeated with the same --key posts once", async () => {
    const a = await comms(["send", "--as", "cedar", "@hazel", "--key", "retry-key-0001", "once only"]);
    const b = await comms(["send", "--as", "cedar", "@hazel", "--key", "retry-key-0001", "once only"]);
    assert.equal(a.code, EXIT.ok, a.stderr);
    assert.equal(a.stdout.match(/^sent (m_\d+)/)![1], b.stdout.match(/^sent (m_\d+)/)![1]);
  });
});
