import { CLI_EXIT } from "@agent-comms/protocol";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
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
    assert.match(r.stderr, /^comms send: this connector can't wait for answers \(unsupported\); sent without waiting\.\n$/);
    assert.match(r.stdout, /^sent m_\d+ \(#1 in c_\d+\)\n  → @hazel: delivery d_\d+ pending\n$/);
  });

  it("sends in a group, addressing some members", async () => {
    const r = await comms(["send", "--as", "cedar", "--conversation", "g1", "@hazel", "@lee", "status?"]);
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.match(r.stdout, /→ @hazel: delivery/);
    assert.doesNotMatch(r.stdout, /@lee: delivery/, "humans read in the web view");
    assert.match(r.stdout, /→ @lee: in their inbox \(people read in the web view\)/);
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
    assert.equal(r.code, EXIT.refused);
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

describe("capabilities R0", () => {
  it("uses the protocol's exit codes, including the ones send-and-wait adds (P3 bug 6: literal values, so it can fail)", () => {
    assert.deepEqual(EXIT, CLI_EXIT);
    assert.deepEqual({ ...CLI_EXIT }, { ok: 0, refused: 1, usage: 2, unreachable: 3, pending: 4, endedWithoutAnswer: 5 });
  });
});

describe("capabilities R1: comms agents", () => {
  it("sets its own entry, lists the registry, and shows one with duties", async () => {
    const set = await comms(["agents", "set", "--as", "cedar", "@cedar", "--description", "Builds comms", "--duty", "merge hazel", "--duty", "keep services up"]);
    assert.equal(set.code, EXIT.ok, set.stderr);
    assert.match(set.stdout, /^@cedar \(agent, active\)/);
    const all = await comms(["agents", "--as", "cedar"]);
    assert.equal(all.code, EXIT.ok, all.stderr);
    assert.match(all.stdout, /^@cedar \(agent, active\) .*claude-code.* — Builds comms$/m);
    assert.match(all.stdout, /^@lee \(human, active\)$/m);
    assert.doesNotMatch(all.stdout, /merge hazel/);
    const one = await comms(["agents", "--as", "cedar", "@cedar", "--long"]);
    assert.match(one.stdout, /^  duties:\n  - merge hazel\n  - keep services up$/m);
    assert.match(one.stdout, /^  home: claude-code cedar on box$/m);
    const other = await comms(["agents", "set", "--as", "cedar", "@hazel", "--description", "x"]);
    assert.equal(other.code, EXIT.refused);
    assert.match(other.stderr, /conflict/);
    const json = await comms(["agents", "--as", "cedar", "@hazel", "--json"]);
    assert.equal(JSON.parse(json.stdout).agents[0].participant.name, "hazel");
  });
});

describe("fix pass 1.7: a dropped send keeps its key", () => {
  /** A socket in front of `target` that drops the connection after forwarding the first `drops` sends (or every send). */
  async function dropProxy(path: string, target: string, drops: number) {
    let dropped = 0;
    const keys: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const isSend = req.url === "/v1/send";
        if (isSend) keys.push(JSON.parse(body).key);
        const forward = httpRequest({ socketPath: target, path: req.url, method: "POST", headers: req.headers }, (up) => {
          let out = "";
          up.on("data", (c) => (out += c));
          up.on("end", () => {
            if (isSend && dropped < drops) {
              dropped++;
              req.socket.destroy();
              return;
            }
            res.writeHead(up.statusCode ?? 500, { "content-type": "application/json" });
            res.end(out);
          });
        });
        forward.end(body);
      });
    });
    await new Promise<void>((r) => server.listen(path, r));
    return { keys, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it("a connector that drops after reading the send: the retry, with the same key, posts once", async () => {
    const proxySock = join(root, "drop-once.sock");
    const proxy = await dropProxy(proxySock, socket, 1);
    try {
      let stdout = "";
      let stderr = "";
      const text = `posted once ${Date.now()}`;
      const code = await run(["--socket", proxySock, "send", "--as", "cedar", "--continue", "@hazel", text], {
        env: {}, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), readStdin: async () => "",
      });
      assert.equal(code, EXIT.ok, stderr);
      assert.equal(proxy.keys.length, 2);
      assert.equal(proxy.keys[0], proxy.keys[1]);
      const list = await comms(["list", "--as", "cedar", "--json"]);
      const dm = JSON.parse(list.stdout).conversations.find((c: { kind: string; members: { name: string }[] }) => c.kind === "dm" && c.members.some((m) => m.name === "hazel"));
      const read = await comms(["read", "--as", "cedar", dm.id, "--json", "--limit", "100"]);
      assert.equal(JSON.parse(read.stdout).messages.filter((m: { text: string }) => m.text === text).length, 1);
    } finally {
      await proxy.close();
    }
  });

  it("Alder's repro: when it gives up, it prints the --key line and exits 3 (unreachable), not 1 (refused)", async () => {
    const proxySock = join(root, "drop-always.sock");
    const proxy = await dropProxy(proxySock, socket, Infinity);
    try {
      let stdout = "";
      let stderr = "";
      const code = await run(["--socket", proxySock, "send", "--as", "cedar", "--continue", "@hazel", "never answered"], {
        env: {}, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), readStdin: async () => "",
      });
      assert.equal(code, EXIT.unreachable, stderr);
      assert.match(stderr, new RegExp(`--key ${proxy.keys[0]}`));
      assert.ok(proxy.keys.every((k) => k === proxy.keys[0]));
    } finally {
      await proxy.close();
    }
  });
});

describe("fix pass 2: comms await", () => {
  it("doesn't take --wait, and the usage text doesn't promise waiting again after exit 4", async () => {
    const r = await comms(["await", "--as", "cedar", "--wait", "5m", "m_1"]);
    assert.equal(r.code, EXIT.usage);
    assert.match(r.stderr, /comms await takes no --wait/);
    const help = await comms(["--help"]);
    assert.doesNotMatch(help.stdout, /after exit 4/);
  });
});

describe("P3 bug 5: -- protects text starting with @", () => {
  it("only @names before -- are recipients; after it, @words are text", async () => {
    const r = await comms(["send", "--as", "cedar", "--continue", "@hazel", "--", "@lee", "is", "text", "here"]);
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.match(r.stdout, /→ @hazel: delivery/);
    assert.doesNotMatch(r.stdout, /@lee: in their inbox/);
    const read = await comms(["read", "--as", "cedar", /\(#\d+ in (\S+)\)/.exec(r.stdout)![1]!, "--json"]);
    assert.equal(JSON.parse(read.stdout).messages.at(-1).text, "@lee is text here");
  });
});

describe("P3 bug 9a: a refused await mid-wait", () => {
  it("exits 1 (refused) and doesn't promise the thread", async () => {
    const path = join(root, "refuse-await.sock");
    let calls = 0;
    const wait = { id: "w_1", messageId: "m_1", waiter: { id: "p", name: "cedar", kind: "agent" }, until: Date.now() + 60_000, active: true, inInbox: [], createdAt: Date.now(),
      results: [{ recipient: { id: "q", name: "hazel", kind: "agent" }, state: "open", delivery: { id: "d_1", state: "delivered" }, at: Date.now() }] };
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        calls++;
        res.writeHead(calls === 1 ? 200 : 403, { "content-type": "application/json" });
        res.end(JSON.stringify(calls === 1 ? { ok: true, wait } : { ok: false, error: { code: "not_homed_here", message: "@cedar moved" } }));
      });
    });
    await new Promise<void>((r) => server.listen(path, r));
    try {
      let stdout = "";
      let stderr = "";
      const code = await run(["--socket", path, "await", "--as", "cedar", "m_1"], { env: {}, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), readStdin: async () => "" });
      assert.equal(code, EXIT.refused, stdout + stderr);
      assert.doesNotMatch(stdout, /arrive in your thread/);
      assert.match(stderr, /not_homed_here/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
