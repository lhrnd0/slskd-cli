import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const stamp = (second) => `2026-11-01T12:00:${String(second).padStart(2, "0")}.0000000Z`;
const message = (id, extra = {}) => ({
  id,
  username: "alice",
  timestamp: stamp(id),
  direction: "In",
  message: `message ${id}`,
  isAcknowledged: false,
  wasReplayed: false,
  ...extra,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function startCli(t, host, args, input = "") {
  const child = spawn(process.execPath, ["dist/cli.js", ...args], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      SLSKD_CLI_CONFIG: "/nonexistent/slskd-message-test.toml",
      SLSKD_BASE_URL: host?.url ?? "",
      SLSKD_API_KEY: host ? "test-key" : "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  let stdout = "";
  let stderr = "";
  let buffer = "";
  const records = [];
  const queue = [];
  const waiters = [];
  const exited = deferred();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("{")) continue; // Plain-text help is tested separately.
      const record = JSON.parse(line);
      records.push(record);
      if (waiters.length) waiters.shift().resolve(record);
      else queue.push(record);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", exited.reject);
  child.on("close", (code, signal) => {
    exited.resolve({ code, signal, stdout, stderr, records });
    for (const waiter of waiters.splice(0))
      waiter.reject(new Error(`CLI exited ${code}: ${stdout} ${stderr}`));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited.promise;
  });
  return {
    child,
    records,
    closed: exited.promise,
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      const waiter = deferred();
      waiters.push(waiter);
      return waiter.promise;
    },
  };
}

async function cli(t, host, args, input) {
  const result = await startCli(t, host, args, input).closed;
  assert.equal(result.stderr, "");
  return { ...result, json: result.records[0] };
}

async function fixture(t, options = {}) {
  const state = options.state ?? { alice: { isActive: true, messages: [message(1)] } };
  const calls = [];
  const waiters = [];
  const timers = [];
  const summary = (username) => ({
    username,
    isActive: state[username].isActive,
    unAcknowledgedMessageCount: state[username].messages.filter((item) => !item.isAcknowledged)
      .length,
  });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, "http://localhost");
    const call = {
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      body: Buffer.concat(chunks).toString(),
      key: req.headers["x-api-key"],
    };
    calls.push(call);
    const matched = waiters.filter((waiter) => waiter.matches(call));
    for (const waiter of matched) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(call);
    }
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (options.override && (await options.override(call, { res, send, state, calls, summary })))
      return;
    if (req.headers["x-api-key"] !== "test-key") return send(401);
    if (url.pathname === "/api/v0/application/version")
      return send(200, options.version ?? "0.26.1");
    if (url.pathname === "/api/v0/conversations") {
      assert.equal(req.method, "GET");
      assert.equal(url.searchParams.get("includeInactive"), "true");
      let result = Object.keys(state).map(summary);
      if (url.searchParams.get("unAcknowledgedOnly") === "true")
        result = result.filter((item) => item.unAcknowledgedMessageCount > 0);
      return send(200, result);
    }
    const match = url.pathname.match(/^\/api\/v0\/conversations\/([^/]+)(?:\/(messages|-?\d+))?$/);
    if (!match) return send(404);
    const username = decodeURIComponent(match[1]);
    const suffix = match[2];
    if (req.method === "POST") {
      if (options.sendDelay) {
        await new Promise((resolve) => timers.push(setTimeout(resolve, options.sendDelay)));
      }
      if ((options.sendStatus ?? 201) === 201) {
        state[username] ??= { isActive: true, messages: [] };
        state[username].messages.push(
          message(0, {
            username,
            timestamp: stamp(59),
            direction: "Out",
            message: JSON.parse(call.body),
            isAcknowledged: true,
          }),
        );
      }
      return send(options.sendStatus ?? 201);
    }
    if (!state[username]) return send(req.method === "PUT" ? 200 : 404);
    if (req.method === "GET") {
      if (suffix === "messages") {
        const history = [...state[username].messages]
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          .slice(-100);
        return send(200, history);
      }
      assert.equal(url.searchParams.get("includeMessages"), "false");
      return send(200, summary(username));
    }
    if (req.method === "PUT") {
      if (options.falseAck) return send(200);
      const selected = state[username].messages.filter(
        (item) => suffix === undefined || item.id === Number(suffix),
      );
      if (suffix !== undefined && selected.length > 1) return send(500);
      for (const item of selected) item.isAcknowledged = true;
      return send(200);
    }
    send(404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    calls,
    waitFor(matches) {
      const existing = calls.find(matches);
      if (existing) return Promise.resolve(existing);
      const waiter = { ...deferred(), matches };
      waiters.push(waiter);
      return waiter.promise;
    },
  };
}

const mutations = (host) => host.calls.filter((item) => item.method !== "GET");
async function references(t, host, username = "alice") {
  const result = await cli(t, host, ["message", "list", username]);
  assert.equal(result.code, 0, result.stdout);
  return result.json.result.messages;
}

test("message help works offline for every command", { timeout: 10000 }, async (t) => {
  for (const command of [undefined, "conversations", "list", "send", "acknowledge", "watch"]) {
    const topic = ["message", ...(command ? [command] : [])];
    for (const args of [
      [...topic, "--help"],
      ["help", ...topic],
    ]) {
      const result = await cli(t, null, args);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /slskd message/);
    }
  }
  assert.match((await cli(t, null, ["message"])).stdout, /message <subcommand>/);
});

test(
  "message commands reject misplaced flags and invalid input before network access",
  { timeout: 30000 },
  async (t) => {
    const host = await fixture(t);
    for (const args of [
      ["message", "list", "alice", "--yes"],
      ["message", "watch", "--yes"],
      ["message", "watch", "--watch"],
      ["message", "send", "alice", "--text", "hello"],
      ["message", "send", "alice", "--text", "hello", "--stdin", "--yes"],
      ["message", "send", "alice", "--text", "  \n", "--yes"],
      ["message", "send", "alice", "--stdin", "--yes"],
      ["message", "send", "alice", "--yes"],
      ["message", "acknowledge", "alice", "--all"],
      ["message", "acknowledge", "alice", "--yes"],
      ["message", "acknowledge", "alice", "--all", "--id", "x", "--yes"],
      ["message", "watch", "--poll-interval-ms", "99"],
      ["message", "watch", "--timeout", "0"],
      ["message", "watch", "--timeout", "1.5"],
      ["message", "list", ".."],
      ["message", "list", "\n"],
      ["message", "list", ""],
      ["message", "watch", "--username", ""],
      ["search", "list", "--new-only"],
      ["message", "list", "alice", "--all"],
      ["message", "list", "alice", "--query", "x"],
      ["message", "watch", "--username", "alice", "extra"],
    ]) {
      const result = await cli(t, host, args);
      assert.equal(result.code, 2, args.join(" "));
      assert.equal(result.json.ok, false);
    }
    assert.deepEqual(host.calls, []);
  },
);

test(
  "list includes inactive conversations and exposes ordered, scoped message identities",
  { timeout: 10000 },
  async (t) => {
    const username = "space /?#%雪";
    const host = await fixture(t, {
      state: {
        [username]: {
          isActive: false,
          messages: [
            message(4, { username, timestamp: "2026-11-01T12:00:04.0000002Z" }),
            message(4, {
              username,
              timestamp: "2026-11-01T12:00:04.0000001Z",
              isAcknowledged: true,
            }),
            message(0, { username, direction: "Out", isAcknowledged: true }),
          ],
        },
        alice: { isActive: true, messages: [message(4)] },
        bob: { isActive: false, messages: [] },
      },
    });
    const conversations = await cli(t, host, ["message", "conversations"]);
    assert.equal(conversations.code, 0);
    assert.equal(conversations.json.result.conversations.length, 3);
    assert.ok(
      conversations.json.result.conversations.some(
        (item) => item.username === username && item.isActive === false,
      ),
    );
    const pending = await cli(t, host, ["message", "conversations", "--unacknowledged"]);
    assert.deepEqual(
      pending.json.result.conversations.map((item) => item.username).sort(),
      ["alice", username].sort(),
    );
    const inspected = await cli(t, host, ["message", "list", username]);
    const { messages, history } = inspected.json.result;
    assert.deepEqual(
      messages.map((item) => item.direction),
      ["outgoing", "incoming", "incoming"],
    );
    assert.ok(messages[1].timestamp.endsWith("0000001Z"));
    assert.notEqual(
      messages[1].messageId,
      messages[2].messageId,
      "sub-millisecond precision is preserved",
    );
    assert.deepEqual(history, {
      limit: 100,
      complete: false,
      lossless: false,
      returnedBeforeFilter: 3,
    });
    const filtered = await cli(t, host, ["message", "list", username, "--unacknowledged"]);
    assert.deepEqual(filtered.json.result.messages, [messages[2]]);
    const alice = await references(t, host);
    assert.notEqual(alice[0].messageId, messages[2].messageId);
    assert.deepEqual(
      await references(t, host, username),
      messages,
      "references survive separate CLI processes",
    );
    assert.ok(
      host.calls.some(
        (item) => item.path === `/api/v0/conversations/${encodeURIComponent(username)}/messages`,
      ),
    );
    assert.ok(host.calls.every((item) => item.key === "test-key"));
    assert.deepEqual(mutations(host), []);
  },
);

test(
  "history never claims completeness or treats an absent old pending message as no backlog",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t, {
      state: {
        alice: {
          isActive: true,
          messages: [
            message(1, { timestamp: "2026-10-01T00:00:00Z" }),
            ...Array.from({ length: 100 }, (_, i) =>
              message(i + 2, {
                timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
                isAcknowledged: true,
              }),
            ),
          ],
        },
      },
    });
    const result = await cli(t, host, ["message", "list", "alice", "--unacknowledged"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.json.result.messages, []);
    assert.equal(result.json.result.conversation.unacknowledgedMessageCount, 1);
    assert.equal(result.json.result.history.returnedBeforeFilter, 100);
    assert.equal(result.json.result.history.complete, false);
    const missing = await cli(t, host, ["message", "list", "missing"]);
    assert.equal(missing.json.error.code, "MISSING_CONVERSATION");
    assert.deepEqual(mutations(host), []);
  },
);

test(
  "sending preserves literal direct and stdin text and returns submission without receipts",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t);
    const text = '  hello "friend"\n世界\n';
    for (const [args, body] of [
      [["--text", text], text],
      [["--stdin"], text],
      [["--text=--literal"], "--literal"],
    ]) {
      const result = await cli(t, host, ["message", "send", "new /雪", ...args, "--yes"], text);
      assert.equal(result.code, 0, result.stdout);
      assert.deepEqual(result.json.result, {
        username: "new /雪",
        submitted: true,
        delivered: null,
        read: null,
      });
      const post = mutations(host).at(-1);
      assert.equal(post.method, "POST");
      assert.equal(post.path, `/api/v0/conversations/${encodeURIComponent("new /雪")}`);
      assert.equal(JSON.parse(post.body), body);
      assert.ok(!result.stdout.includes("test-key"));
    }
    assert.equal(mutations(host).length, 3);
  },
);

test(
  "send rejection, server failure and timeouts never trigger automatic retries",
  { timeout: 10000 },
  async (t) => {
    for (const [options, code, errorCode] of [
      [{ sendStatus: 200 }, 7, "MESSAGE_REJECTED"],
      [{ sendStatus: 503 }, 9, "AMBIGUOUS_MUTATION"],
      [{ sendStatus: 403 }, 4, "AUTHENTICATION"],
      [{ sendStatus: 400 }, 7, "REMOTE"],
      [{ sendStatus: 202 }, 9, "AMBIGUOUS_MUTATION"],
      [{ sendDelay: 500 }, 9, "AMBIGUOUS_MUTATION"],
    ]) {
      const host = await fixture(t, options);
      const result = await cli(t, host, [
        "message",
        "send",
        "alice",
        "--text",
        "hello",
        "--yes",
        "--timeout-ms",
        "100",
      ]);
      assert.equal(result.code, code, result.stdout);
      assert.equal(result.json.error.code, errorCode);
      assert.equal(mutations(host).length, 1);
      assert.equal(mutations(host)[0].method, "POST");
    }
  },
);

test(
  "individual acknowledgement validates references, deduplicates selections and verifies state",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t, {
      state: {
        alice: {
          isActive: true,
          messages: [
            message(1),
            message(2),
            message(0, { direction: "Out", isAcknowledged: true }),
          ],
        },
      },
    });
    const messages = await references(t, host);
    const incoming = messages.filter((item) => item.direction === "incoming");
    const outgoing = messages.find((item) => item.direction === "outgoing");
    for (const ids of [[outgoing.messageId], [incoming[0].messageId, `msg_${"x".repeat(43)}`]]) {
      const result = await cli(t, host, [
        "message",
        "acknowledge",
        "alice",
        ...ids.flatMap((id) => ["--id", id]),
        "--yes",
      ]);
      assert.equal(result.code, 2);
    }
    const wrongPeer = await cli(t, host, [
      "message",
      "acknowledge",
      "missing",
      "--id",
      incoming[0].messageId,
      "--yes",
    ]);
    assert.equal(wrongPeer.code, 7);
    assert.deepEqual(mutations(host), []);
    const ack = await cli(t, host, [
      "message",
      "acknowledge",
      "alice",
      "--id",
      incoming[0].messageId,
      "--id",
      incoming[0].messageId,
      "--yes",
    ]);
    assert.equal(ack.code, 0, ack.stdout);
    assert.deepEqual(ack.json.result.messages, [
      { messageId: incoming[0].messageId, outcome: "acknowledged" },
    ]);
    assert.equal(mutations(host).length, 1);
    assert.equal(mutations(host)[0].path, "/api/v0/conversations/alice/1");
    assert.equal(host.state.alice.messages.find((item) => item.id === 2).isAcknowledged, false);
    const retry = await cli(t, host, [
      "message",
      "acknowledge",
      "alice",
      "--id",
      incoming[0].messageId,
      "--yes",
    ]);
    assert.equal(retry.json.result.messages[0].outcome, "existing");
    assert.equal(mutations(host).length, 1);
  },
);

test(
  "reused numeric IDs fail before any individual acknowledgement",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t, {
      state: {
        alice: {
          isActive: true,
          messages: [message(1), message(2), message(2, { timestamp: stamp(3) })],
        },
      },
    });
    const messages = await references(t, host);
    assert.equal(new Set(messages.map((item) => item.messageId)).size, 3);
    const result = await cli(t, host, [
      "message",
      "acknowledge",
      "alice",
      "--id",
      messages[0].messageId,
      "--id",
      messages[1].messageId,
      "--yes",
    ]);
    assert.equal(result.code, 2);
    assert.deepEqual(mutations(host), []);
    const all = await cli(t, host, ["message", "acknowledge", "alice", "--all", "--yes"]);
    assert.equal(all.code, 0);
    assert.equal(all.json.result.outcome, "acknowledged");
    assert.ok(host.state.alice.messages.every((item) => item.isAcknowledged));
  },
);

test(
  "acknowledgement does not trust false HTTP success for individual or all modes",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t, { falseAck: true });
    const [selected] = await references(t, host);
    const result = await cli(t, host, [
      "message",
      "acknowledge",
      "alice",
      "--id",
      selected.messageId,
      "--yes",
    ]);
    assert.equal(result.code, 9);
    assert.equal(result.json.result.messages[0].outcome, "uncertain");
    assert.equal(result.json.error.code, "AMBIGUOUS_MUTATION");
    const all = await cli(t, host, ["message", "acknowledge", "alice", "--all", "--yes"]);
    assert.equal(all.code, 9);
    assert.equal(all.json.result.outcome, "uncertain");
    assert.equal(mutations(host).length, 2);
  },
);

test(
  "acknowledgement retains successful, failed and unattempted per-message outcomes",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t, {
      state: { alice: { isActive: true, messages: [message(1), message(2), message(3)] } },
      override(call, { send }) {
        if (call.method === "PUT" && call.path.endsWith("/2")) {
          send(403);
          return true;
        }
      },
    });
    const messages = await references(t, host);
    const result = await cli(t, host, [
      "message",
      "acknowledge",
      "alice",
      ...messages.flatMap((item) => ["--id", item.messageId]),
      "--yes",
    ]);
    assert.equal(result.code, 4);
    assert.deepEqual(
      result.json.result.messages.map((item) => item.outcome),
      ["acknowledged", "failed", "not_attempted"],
    );
    assert.equal(result.json.result.messages[1].error.code, "AUTHENTICATION");
    assert.equal(mutations(host).length, 2);
  },
);

test(
  "acknowledgement verification failures and server errors are uncertain without a retry",
  { timeout: 10000 },
  async (t) => {
    for (const failVerification of [false, true]) {
      let mutated = false;
      const host = await fixture(t, {
        override(call, { send }) {
          if (call.method === "PUT") {
            mutated = true;
            if (!failVerification) {
              send(500);
              return true;
            }
          }
          if (failVerification && mutated && call.method === "GET") {
            send(503);
            return true;
          }
        },
      });
      const [selected] = await references(t, host);
      const result = await cli(t, host, [
        "message",
        "acknowledge",
        "alice",
        "--id",
        selected.messageId,
        "--yes",
      ]);
      assert.equal(result.code, 9);
      assert.equal(result.json.result.messages[0].outcome, "uncertain");
      assert.equal(mutations(host).length, 1);
    }
  },
);

test(
  "watch emits backlog then newly observed messages across peers without acknowledging",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t, {
      state: {
        alice: {
          isActive: true,
          messages: [
            message(1),
            message(2, { isAcknowledged: true }),
            message(0, { direction: "Out", isAcknowledged: true }),
          ],
        },
      },
    });
    const child = startCli(t, host, ["message", "watch", "--poll-interval-ms", "100"]);
    const started = await child.next();
    assert.equal(started.result.event, "started");
    assert.equal(started.result.history.complete, false);
    const backlog = await child.next();
    assert.equal(backlog.result.event, "message");
    assert.equal(backlog.result.message.serverId, 1);
    const oldId = backlog.result.message.messageId;
    host.state.alice.messages.push(message(3, { isAcknowledged: true }));
    host.state.bob = { isActive: true, messages: [message(1, { username: "bob" })] };
    const nextMessages = [(await child.next()).result.message, (await child.next()).result.message];
    assert.deepEqual(new Set(nextMessages.map((item) => item.username)), new Set(["bob", "alice"]));
    assert.ok(!nextMessages.some((item) => item.messageId === oldId));
    assert.notEqual(nextMessages.find((item) => item.username === "bob").messageId, oldId);
    assert.equal(nextMessages.find((item) => item.username === "alice").isAcknowledged, true);
    child.child.kill("SIGTERM");
    assert.equal((await child.closed).code, 143);
    assert.equal(child.records.filter((item) => item.result?.event === "message").length, 3);
    assert.deepEqual(mutations(host), []);
    const restarted = startCli(t, host, [
      "message",
      "watch",
      "--username",
      "alice",
      "--poll-interval-ms",
      "100",
    ]);
    assert.equal((await restarted.next()).result.event, "started");
    assert.equal((await restarted.next()).result.message.messageId, oldId);
    restarted.child.kill("SIGINT");
    assert.equal((await restarted.closed).code, 130);
  },
);

test(
  "new-only establishes a baseline and discovers new conversations even with old timestamps",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t);
    const child = startCli(t, host, [
      "message",
      "watch",
      "--new-only",
      "--poll-interval-ms",
      "100",
    ]);
    assert.equal((await child.next()).result.event, "started");
    host.state.alice.messages.push(message(2));
    host.state.bob = {
      isActive: false,
      messages: [message(1, { username: "bob", timestamp: "2026-10-01T00:00:00Z" })],
    };
    const emitted = [(await child.next()).result.message, (await child.next()).result.message];
    assert.deepEqual(emitted.map((item) => item.username).sort(), ["alice", "bob"]);
    assert.ok(!emitted.some((item) => item.username === "alice" && item.serverId === 1));
    child.child.kill("SIGTERM");
    assert.equal((await child.closed).code, 143);
  },
);

test(
  "watch filters by username and ends successfully on an idle duration limit",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t);
    const child = startCli(t, host, [
      "message",
      "watch",
      "--username",
      "alice",
      "--poll-interval-ms",
      "60000",
      "--timeout",
      "1",
    ]);
    const result = await child.closed;
    assert.equal(result.code, 0);
    assert.deepEqual(
      result.records.map((item) => item.result.event),
      ["started", "message", "ended"],
    );
    assert.deepEqual(result.records.at(-1).result, {
      event: "ended",
      reason: "deadline",
      messageCount: 1,
    });
    assert.ok(
      host.calls.every((item) =>
        [
          "/api/v0/application/version",
          "/api/v0/conversations/alice",
          "/api/v0/conversations/alice/messages",
        ].includes(item.path),
      ),
    );
    assert.deepEqual(mutations(host), []);
  },
);

test("watch duration aborts a pending history response", { timeout: 10000 }, async (t) => {
  const host = await fixture(t, {
    override(call) {
      return call.path.endsWith("/messages");
    },
  });
  const result = await startCli(t, host, [
    "message",
    "watch",
    "--username",
    "alice",
    "--timeout",
    "1",
  ]).closed;
  assert.equal(result.code, 0);
  assert.deepEqual(result.records, [
    { ok: true, result: { event: "ended", reason: "deadline", messageCount: 0 } },
  ]);
  assert.equal(host.calls.filter((item) => item.path.endsWith("/messages")).length, 1);
});

test(
  "watch duration interrupts a pending history body and reports only its deadline",
  { timeout: 10000 },
  async (t) => {
    const bodyClosed = deferred();
    const host = await fixture(t, {
      override(call, { res }) {
        if (!call.path.endsWith("/messages")) return;
        res.on("close", bodyClosed.resolve);
        res.writeHead(200, { "content-type": "application/json" });
        res.write("[");
        return true;
      },
    });
    const result = await startCli(t, host, [
      "message",
      "watch",
      "--username",
      "alice",
      "--timeout",
      "1",
    ]).closed;
    await bodyClosed.promise;
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.records, [
      { ok: true, result: { event: "ended", reason: "deadline", messageCount: 0 } },
    ]);
    assert.equal(host.calls.filter((item) => item.path.endsWith("/messages")).length, 1);
    assert.deepEqual(mutations(host), []);
  },
);

test("watch fails visibly on a later poll without retrying", { timeout: 10000 }, async (t) => {
  let historyCalls = 0;
  const host = await fixture(t, {
    override(call, { send }) {
      if (call.path.endsWith("/messages") && ++historyCalls === 2) {
        send(503);
        return true;
      }
    },
  });
  const result = await startCli(t, host, ["message", "watch", "--poll-interval-ms", "100"]).closed;
  assert.equal(result.code, 7);
  assert.deepEqual(
    result.records.map((item) => item.result?.event ?? item.error.code),
    ["started", "message", "REMOTE"],
  );
  assert.equal(historyCalls, 2);
  assert.deepEqual(mutations(host), []);
});

test(
  "watch preserves per-request timeouts, authentication and compatibility failures",
  { timeout: 10000 },
  async (t) => {
    for (const [options, code, errorCode] of [
      [
        {
          override(call) {
            return call.path.endsWith("/messages");
          },
        },
        8,
        "TIMEOUT",
      ],
      [
        {
          override(_call, { send }) {
            send(401);
            return true;
          },
        },
        4,
        "AUTHENTICATION",
      ],
      [{ version: "0.25.0" }, 5, "INCOMPATIBLE"],
    ]) {
      const host = await fixture(t, options);
      const result = await startCli(t, host, ["message", "watch", "--timeout-ms", "100"]).closed;
      assert.equal(result.code, code);
      assert.equal(result.records.at(-1).error.code, errorCode);
      assert.deepEqual(mutations(host), []);
    }
  },
);

test(
  "watch SIGTERM aborts an in-flight response body without a terminal error",
  { timeout: 10000 },
  async (t) => {
    const bodyStarted = deferred();
    const host = await fixture(t, {
      override(call, { res }) {
        if (call.path.endsWith("/messages")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.write("[", () => bodyStarted.resolve());
          return true;
        }
      },
    });
    const child = startCli(t, host, ["message", "watch"]);
    await bodyStarted.promise;
    child.child.kill("SIGTERM");
    const result = await child.closed;
    assert.equal(result.code, 143);
    assert.deepEqual(result.records, []);
    assert.equal(result.stderr, "");
    assert.deepEqual(mutations(host), []);
  },
);

test(
  "invalid or cross-peer upstream messaging data fails rather than inventing messages",
  { timeout: 10000 },
  async (t) => {
    for (const raw of [
      null,
      {},
      [message(1, { username: "bob" })],
      [message(1, { direction: "Maybe" })],
      [message(1, { isAcknowledged: null })],
    ]) {
      const host = await fixture(t, {
        override(call, { send }) {
          if (call.path.endsWith("/messages")) {
            send(200, raw);
            return true;
          }
        },
      });
      const result = await cli(t, host, ["message", "list", "alice"]);
      assert.equal(result.code, 7);
      assert.equal(result.json.error.code, "REMOTE");
      assert.deepEqual(mutations(host), []);
    }
  },
);

test(
  "history preserves chronological order below one millisecond with omitted fractional zeros",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t, {
      state: {
        alice: {
          isActive: true,
          messages: [
            message(1, { timestamp: "2026-11-01T12:00:00.0000002Z" }),
            message(2, { timestamp: "2026-11-01T12:00:00Z" }),
            message(3, { timestamp: "2026-11-01T12:00:00.0000001Z" }),
          ],
        },
      },
    });
    const messages = await references(t, host);
    assert.deepEqual(
      messages.map((item) => item.serverId),
      [2, 3, 1],
    );
    assert.equal(new Set(messages.map((item) => item.messageId)).size, 3);
  },
);

test("a filtered watcher waits for a new Conversation", { timeout: 10000 }, async (t) => {
  const host = await fixture(t, { state: {} });
  const child = startCli(t, host, [
    "message",
    "watch",
    "--username",
    "new-peer",
    "--poll-interval-ms",
    "100",
  ]);
  assert.equal((await child.next()).result.event, "started");
  host.state["new-peer"] = { isActive: true, messages: [message(1, { username: "new-peer" })] };
  assert.equal((await child.next()).result.message.username, "new-peer");
  child.child.kill("SIGTERM");
  assert.equal((await child.closed).code, 143);
  assert.deepEqual(mutations(host), []);
});

test(
  "all-mode acknowledges old messages outside the visible history window",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t, {
      state: {
        alice: {
          isActive: false,
          messages: Array.from({ length: 105 }, (_, id) =>
            message(id, { timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0, id)).toISOString() }),
          ),
        },
      },
    });
    const visible = await references(t, host);
    assert.equal(visible.length, 100);
    assert.equal(
      visible.some((item) => item.serverId === 1),
      false,
    );
    const result = await cli(t, host, ["message", "acknowledge", "alice", "--all", "--yes"]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.json.result.outcome, "acknowledged");
    assert.equal(mutations(host).length, 1);
    assert.ok(host.state.alice.messages.every((item) => item.isAcknowledged));
  },
);

test(
  "message output backpressure stops polling and a closed output pipe exits successfully",
  { timeout: 10000 },
  async (t) => {
    const host = await fixture(t, {
      state: {
        alice: {
          isActive: true,
          messages: Array.from({ length: 100 }, (_, id) =>
            message(id, {
              timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0, id)).toISOString(),
              message: "x".repeat(256000),
            }),
          ),
        },
      },
    });
    const child = startCli(t, host, [
      "message",
      "watch",
      "--username",
      "alice",
      "--poll-interval-ms",
      "100",
    ]);
    child.child.stdout.pause();
    await host.waitFor((call) => call.path.endsWith("/messages"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(host.calls.filter((call) => call.path.endsWith("/messages")).length, 1);
    child.child.stdout.destroy();
    const result = await child.closed;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(mutations(host), []);
  },
);
