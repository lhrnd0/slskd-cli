import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const SEARCH_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_ONE = {
  username: "alice",
  hasFreeUploadSlot: true,
  queueLength: 2,
  files: [{ filename: "Albums\\artist\\first.flac", size: 1234, extension: "flac" }],
};
const CANDIDATE_TWO = {
  username: "bob",
  hasFreeUploadSlot: false,
  queueLength: 4,
  files: [{ filename: "Albums\\artist\\second.flac", size: 5678, extension: "flac" }],
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function streamingCli(args, env = {}) {
  const child = spawn(process.execPath, ["dist/cli.js", ...args], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      SLSKD_CLI_CONFIG: "/nonexistent/slskd-cli-watch-test.toml",
      SLSKD_BASE_URL: "",
      SLSKD_API_KEY: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const records = [];
  const recordsSeen = [];
  const waiters = [];
  const closed = deferred();
  let buffer = "";
  let stderr = "";
  let stdoutClosed = false;

  const dispatch = () => {
    while (waiters.length > 0 && records.length > 0) waiters.shift().resolve(records.shift());
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        const record = JSON.parse(line);
        records.push(record);
        recordsSeen.push(record);
      }
    }
    dispatch();
  });
  child.stdout.on("close", () => {
    stdoutClosed = true;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("close", (code, signal) => {
    closed.resolve({ code, signal, stderr, remaining: buffer });
    for (const waiter of waiters.splice(0))
      waiter.reject(
        new Error(
          `CLI exited before another NDJSON record (code ${code}, signal ${signal}): ${stderr}`,
        ),
      );
  });
  child.on("error", (error) => {
    closed.reject(error);
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });

  return {
    child,
    get alive() {
      return child.exitCode === null && child.signalCode === null;
    },
    get stdoutClosed() {
      return stdoutClosed;
    },
    recordsSeen,
    nextRecord() {
      if (records.length > 0) return Promise.resolve(records.shift());
      if (!this.alive) return Promise.reject(new Error("CLI exited before another NDJSON record"));
      const waiter = deferred();
      waiters.push(waiter);
      return waiter.promise;
    },
    closed: closed.promise,
    stop() {
      if (this.alive) child.kill("SIGKILL");
      return closed.promise;
    },
    closeStdout() {
      child.stdout.destroy();
    },
  };
}

async function watchFixture(options = {}) {
  const requests = [];
  const requestWaiters = [];
  const heldResponses = [];
  const responseWaiters = [];
  const allResponseGates = new Set();
  const bodyGates = [];
  let searchState = options.searchState ?? "InProgress";
  let automaticSnapshot = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Consume the request body so the connection is ready for its response.
    }
    const url = new URL(req.url, "http://localhost");
    const request = { method: req.method, path: url.pathname, res };
    requests.push(request);
    for (let index = 0; index < requestWaiters.length; index += 1) {
      const waiter = requestWaiters[index];
      if (waiter.matches(request)) {
        requestWaiters.splice(index, 1);
        waiter.resolve(request);
        break;
      }
    }

    const send = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(value === undefined ? "" : JSON.stringify(value));
    };
    if (options.auth && req.headers["x-api-key"] !== options.auth) return send(401, {});
    if (url.pathname === "/api/v0/application/version")
      return send(200, options.version ?? "0.26.1");
    if (url.pathname === `/api/v0/searches/${SEARCH_ID}` && req.method === "GET") {
      if (options.searchHttpStatus) return send(options.searchHttpStatus, {});
      return send(200, { id: SEARCH_ID, state: searchState });
    }
    if (url.pathname === `/api/v0/searches/${SEARCH_ID}/responses` && req.method === "GET") {
      if (options.autoResponses) {
        const snapshots = options.autoResponses;
        const snapshot = snapshots[Math.min(automaticSnapshot, snapshots.length - 1)];
        automaticSnapshot += 1;
        return send(200, snapshot);
      }
      const gate = deferred();
      allResponseGates.add(gate);
      if (responseWaiters.length > 0) responseWaiters.shift().resolve(gate);
      else heldResponses.push(gate);
      const snapshot = await gate.promise;
      allResponseGates.delete(gate);
      if (snapshot?.httpStatus) return send(snapshot.httpStatus, snapshot.body ?? {});
      if (snapshot?.streamBody) {
        res.writeHead(200, { "content-type": "application/json" });
        const partialWritten = deferred();
        res.write("[", () => partialWritten.resolve());
        await partialWritten.promise;
        snapshot.bodyStarted.resolve();
        await snapshot.bodyGate.promise;
        return res.end("]");
      }
      return send(200, snapshot);
    }
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    waitForRequest(method, path) {
      const existing = requests.find(
        (item) => item.method === method && item.path === path && !item.matched,
      );
      if (existing) {
        existing.matched = true;
        return Promise.resolve(existing);
      }
      const barrier = deferred();
      const waiter = {
        matches: (item) => item.method === method && item.path === path,
        resolve(item) {
          item.matched = true;
          barrier.resolve(item);
        },
      };
      requestWaiters.push(waiter);
      return barrier.promise;
    },
    waitForResponseRequest() {
      const next = heldResponses.shift();
      if (next) return Promise.resolve(next);
      const barrier = deferred();
      responseWaiters.push(barrier);
      return barrier.promise;
    },
    release(gate, snapshot) {
      gate.resolve(snapshot);
    },
    streamReply() {
      const bodyGate = deferred();
      const bodyStarted = deferred();
      bodyGates.push(bodyGate);
      return { streamBody: true, bodyGate, bodyStarted };
    },
    get requests() {
      return requests;
    },
    setSearchState(state) {
      searchState = state;
    },
    close() {
      for (const gate of allResponseGates) gate.resolve([]);
      for (const gate of bodyGates) gate.resolve();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test(
  "watch keeps an initially empty active Search observable through streamed Candidates and completion",
  { timeout: 20_000 },
  async (t) => {
    const host = await watchFixture();
    const child = streamingCli(
      [
        "search",
        "candidates",
        SEARCH_ID,
        "--watch",
        "--poll-interval-ms",
        "100",
        "--watch-timeout-seconds",
        "60",
      ],
      { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" },
    );
    t.after(async () => {
      await child.stop();
      await host.close();
    });

    const started = await child.nextRecord();
    assert.deepEqual(started, {
      ok: true,
      result: { event: "started", searchId: SEARCH_ID },
    });

    const emptyPoll = await host.waitForResponseRequest();
    host.release(emptyPoll, []);
    const firstCandidatePoll = await host.waitForResponseRequest();
    host.release(firstCandidatePoll, [CANDIDATE_ONE]);
    const firstCandidate = await child.nextRecord();
    assert.equal(firstCandidate.ok, true);
    assert.equal(firstCandidate.result.event, "candidate");
    assert.equal(firstCandidate.result.searchId, SEARCH_ID);
    assert.equal(firstCandidate.result.candidate.username, "alice");
    assert.equal(child.alive, true, "the first Candidate must arrive while the watcher is alive");

    const secondCandidatePoll = await host.waitForResponseRequest();
    host.release(secondCandidatePoll, [CANDIDATE_ONE, CANDIDATE_TWO, CANDIDATE_TWO]);
    const secondCandidate = await child.nextRecord();
    assert.equal(secondCandidate.result.event, "candidate");
    assert.equal(secondCandidate.result.candidate.username, "bob");
    assert.equal(child.alive, true, "the second Candidate must arrive before completion");

    const completionPoll = await host.waitForResponseRequest();
    host.setSearchState("Completed");
    host.release(completionPoll, [CANDIDATE_ONE, CANDIDATE_TWO]);
    const finalDrain = await host.waitForResponseRequest();
    host.release(finalDrain, [CANDIDATE_ONE, CANDIDATE_TWO]);

    const ended = await child.nextRecord();
    assert.deepEqual(ended, {
      ok: true,
      result: { event: "ended", searchId: SEARCH_ID, reason: "completed", candidateCount: 2 },
    });
    const exit = await child.closed;
    assert.equal(exit.code, 0);
    assert.deepEqual(
      [firstCandidate.result.candidate.username, secondCandidate.result.candidate.username],
      ["alice", "bob"],
    );
    assert.ok(
      host.requests.every(({ path }) =>
        [
          "/api/v0/application/version",
          `/api/v0/searches/${SEARCH_ID}`,
          `/api/v0/searches/${SEARCH_ID}/responses`,
        ].includes(path),
      ),
      "watch requests stay scoped to the supplied Search",
    );
  },
);

test(
  "watch replays and deduplicates normalized Candidates with the same identifiers as one-shot inspection",
  { timeout: 20_000 },
  async (t) => {
    const oneShotHost = await watchFixture({ autoResponses: [[CANDIDATE_ONE]] });
    const oneShot = streamingCli(["search", "candidates", SEARCH_ID], {
      SLSKD_BASE_URL: oneShotHost.url,
      SLSKD_API_KEY: "secret",
    });
    t.after(async () => {
      await oneShot.stop();
      await oneShotHost.close();
    });
    const inspected = await oneShot.nextRecord();
    assert.equal(inspected.ok, true);
    assert.ok(
      Array.isArray(inspected.result.candidates),
      "one-shot candidates output remains an array",
    );
    const [oneShotCandidate] = inspected.result.candidates;
    assert.equal((await oneShot.closed).code, 0);

    const host = await watchFixture();
    const child = streamingCli(
      [
        "search",
        "candidates",
        SEARCH_ID,
        "--watch",
        "--poll-interval-ms",
        "100",
        "--watch-timeout-seconds",
        "60",
      ],
      { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" },
    );
    t.after(async () => {
      await child.stop();
      await host.close();
    });

    const started = await child.nextRecord();
    assert.deepEqual(started.result, { event: "started", searchId: SEARCH_ID });
    const initialSnapshot = await host.waitForResponseRequest();
    host.release(initialSnapshot, [CANDIDATE_ONE]);
    const firstCandidateEvent = await child.nextRecord();
    const watchedCandidate = firstCandidateEvent.result.candidate;
    assert.deepEqual(watchedCandidate, oneShotCandidate);

    const repeatedSnapshot = await host.waitForResponseRequest();
    host.release(repeatedSnapshot, [CANDIDATE_ONE, CANDIDATE_TWO, CANDIDATE_TWO]);
    const secondCandidateEvent = await child.nextRecord();
    const secondCandidate = secondCandidateEvent.result.candidate;
    assert.equal(secondCandidateEvent.result.event, "candidate");
    assert.equal(secondCandidate.username, "bob");

    const reorderedSnapshot = await host.waitForResponseRequest();
    host.setSearchState("Completed");
    host.release(reorderedSnapshot, [CANDIDATE_TWO, CANDIDATE_ONE]);
    const finalSnapshot = await host.waitForResponseRequest();
    host.release(finalSnapshot, [CANDIDATE_TWO, CANDIDATE_ONE]);

    const ended = await child.nextRecord();
    assert.deepEqual(ended.result, {
      event: "ended",
      searchId: SEARCH_ID,
      reason: "completed",
      candidateCount: 2,
    });
    assert.notEqual(watchedCandidate.candidateId, secondCandidate.candidateId);
    const exit = await child.closed;
    assert.equal(exit.code, 0);
  },
);

test(
  "watch attached to a retained completed Search drains its Candidates before ending",
  { timeout: 20_000 },
  async (t) => {
    const host = await watchFixture({ searchState: "Completed", autoResponses: [[CANDIDATE_ONE]] });
    const child = streamingCli(["search", "candidates", SEARCH_ID, "--watch"], {
      SLSKD_BASE_URL: host.url,
      SLSKD_API_KEY: "secret",
    });
    t.after(async () => {
      await child.stop();
      await host.close();
    });

    assert.deepEqual((await child.nextRecord()).result, { event: "started", searchId: SEARCH_ID });
    const candidate = await child.nextRecord();
    assert.equal(candidate.result.event, "candidate");
    assert.equal(candidate.result.candidate.username, "alice");
    assert.deepEqual((await child.nextRecord()).result, {
      event: "ended",
      searchId: SEARCH_ID,
      reason: "completed",
      candidateCount: 1,
    });
    assert.equal((await child.closed).code, 0);
  },
);

test(
  "watch attached to an empty completed Search reports completion with zero Candidates",
  { timeout: 20_000 },
  async (t) => {
    const host = await watchFixture({ searchState: "Completed", autoResponses: [[]] });
    const child = streamingCli(["search", "candidates", SEARCH_ID, "--watch"], {
      SLSKD_BASE_URL: host.url,
      SLSKD_API_KEY: "secret",
    });
    t.after(async () => {
      await child.stop();
      await host.close();
    });

    assert.deepEqual((await child.nextRecord()).result, { event: "started", searchId: SEARCH_ID });
    assert.deepEqual((await child.nextRecord()).result, {
      event: "ended",
      searchId: SEARCH_ID,
      reason: "completed",
      candidateCount: 0,
    });
    assert.equal((await child.closed).code, 0);
  },
);

test(
  "watch deadline ends successfully while idle between polls",
  { timeout: 20_000 },
  async (t) => {
    const host = await watchFixture({ autoResponses: [[]] });
    const child = streamingCli(
      [
        "search",
        "candidates",
        SEARCH_ID,
        "--watch",
        "--poll-interval-ms",
        "60000",
        "--watch-timeout-seconds",
        "1",
      ],
      { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" },
    );
    t.after(async () => {
      await child.stop();
      await host.close();
    });

    assert.deepEqual((await child.nextRecord()).result, { event: "started", searchId: SEARCH_ID });
    assert.deepEqual((await child.nextRecord()).result, {
      event: "ended",
      searchId: SEARCH_ID,
      reason: "deadline",
      candidateCount: 0,
    });
    assert.equal((await child.closed).code, 0);
  },
);

test(
  "watch deadline ends successfully while an upstream response is still pending",
  { timeout: 20_000 },
  async (t) => {
    const host = await watchFixture();
    const child = streamingCli(
      ["search", "candidates", SEARCH_ID, "--watch", "--watch-timeout-seconds", "1"],
      { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" },
    );
    t.after(async () => {
      await child.stop();
      await host.close();
    });

    assert.deepEqual((await child.nextRecord()).result, { event: "started", searchId: SEARCH_ID });
    await host.waitForResponseRequest();
    assert.deepEqual((await child.nextRecord()).result, {
      event: "ended",
      searchId: SEARCH_ID,
      reason: "deadline",
      candidateCount: 0,
    });
    assert.equal((await child.closed).code, 0);
  },
);

test(
  "watch deadline ends successfully while the response body is still being read",
  { timeout: 20_000 },
  async (t) => {
    const host = await watchFixture();
    const child = streamingCli(
      ["search", "candidates", SEARCH_ID, "--watch", "--watch-timeout-seconds", "1"],
      { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" },
    );
    t.after(async () => {
      await child.stop();
      await host.close();
    });

    assert.deepEqual((await child.nextRecord()).result, { event: "started", searchId: SEARCH_ID });
    const response = await host.waitForResponseRequest();
    const streamed = host.streamReply();
    host.release(response, streamed);
    await streamed.bodyStarted.promise;
    assert.deepEqual((await child.nextRecord()).result, {
      event: "ended",
      searchId: SEARCH_ID,
      reason: "deadline",
      candidateCount: 0,
    });
    assert.equal((await child.closed).code, 0);
  },
);

test("an independent request timeout remains a typed failure", { timeout: 20_000 }, async (t) => {
  const host = await watchFixture();
  const child = streamingCli(
    [
      "--timeout-ms",
      "500",
      "search",
      "candidates",
      SEARCH_ID,
      "--watch",
      "--watch-timeout-seconds",
      "10",
    ],
    { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" },
  );
  t.after(async () => {
    await child.stop();
    await host.close();
  });

  assert.deepEqual((await child.nextRecord()).result, { event: "started", searchId: SEARCH_ID });
  await host.waitForResponseRequest();
  assert.deepEqual(await child.nextRecord(), {
    ok: false,
    searchId: SEARCH_ID,
    error: { code: "TIMEOUT", message: "Request timed out after 500 ms." },
  });
  assert.equal((await child.closed).code, 8);
});

test(
  "SIGTERM during a response body read stops without a terminal event or mutation",
  { timeout: 20_000 },
  async (t) => {
    const host = await watchFixture();
    const child = streamingCli(["search", "candidates", SEARCH_ID, "--watch"], {
      SLSKD_BASE_URL: host.url,
      SLSKD_API_KEY: "secret",
    });
    t.after(async () => {
      await child.stop();
      await host.close();
    });

    assert.deepEqual((await child.nextRecord()).result, { event: "started", searchId: SEARCH_ID });
    const response = await host.waitForResponseRequest();
    const streamed = host.streamReply();
    host.release(response, streamed);
    await streamed.bodyStarted.promise;
    child.child.kill("SIGTERM");
    assert.deepEqual(await child.closed.then(({ code, signal }) => ({ code, signal })), {
      code: 143,
      signal: null,
    });
    assert.deepEqual(
      child.recordsSeen.map((record) => record.result?.event),
      ["started"],
    );
    assert.ok(host.requests.every((request) => request.method === "GET"));
  },
);

test(
  "SIGINT during an in-flight response stops without a terminal event",
  { timeout: 20_000 },
  async (t) => {
    const host = await watchFixture();
    const child = streamingCli(["search", "candidates", SEARCH_ID, "--watch"], {
      SLSKD_BASE_URL: host.url,
      SLSKD_API_KEY: "secret",
    });
    t.after(async () => {
      await child.stop();
      await host.close();
    });

    assert.deepEqual((await child.nextRecord()).result, { event: "started", searchId: SEARCH_ID });
    await host.waitForResponseRequest();
    child.child.kill("SIGINT");
    assert.deepEqual(await child.closed.then(({ code, signal }) => ({ code, signal })), {
      code: 130,
      signal: null,
    });
    assert.deepEqual(child.recordsSeen.map((record) => record.result?.event).filter(Boolean), [
      "started",
    ]);
  },
);

test(
  "a missing Search on the final response request is a typed error after attachment",
  { timeout: 20_000 },
  async (t) => {
    const host = await watchFixture({ searchState: "Completed" });
    const child = streamingCli(["search", "candidates", SEARCH_ID, "--watch"], {
      SLSKD_BASE_URL: host.url,
      SLSKD_API_KEY: "secret",
    });
    t.after(async () => {
      await child.stop();
      await host.close();
    });

    assert.deepEqual((await child.nextRecord()).result, { event: "started", searchId: SEARCH_ID });
    const finalResponses = await host.waitForResponseRequest();
    host.release(finalResponses, { httpStatus: 404 });
    assert.deepEqual(await child.nextRecord(), {
      ok: false,
      searchId: SEARCH_ID,
      error: { code: "MISSING_SEARCH", message: "No Search exists for the supplied searchId." },
    });
    assert.equal((await child.closed).code, 7);
  },
);

test(
  "watch reports missing and Expired Searches with the validated Search identifier",
  { timeout: 20_000 },
  async (t) => {
    const cases = [
      {
        name: "missing at attachment",
        options: { searchHttpStatus: 404 },
        code: "MISSING_SEARCH",
        message: "No Search exists for the supplied searchId.",
      },
      {
        name: "Expired at attachment",
        options: { searchState: "Expired" },
        code: "EXPIRED_SEARCH",
        message: "The Search has expired; create a fresh Search.",
      },
    ];
    for (const scenario of cases) {
      const host = await watchFixture(scenario.options);
      const child = streamingCli(["search", "candidates", SEARCH_ID, "--watch"], {
        SLSKD_BASE_URL: host.url,
        SLSKD_API_KEY: "secret",
      });
      t.after(async () => {
        await child.stop();
        await host.close();
      });

      assert.deepEqual(
        await child.nextRecord(),
        {
          ok: false,
          searchId: SEARCH_ID,
          error: { code: scenario.code, message: scenario.message },
        },
        scenario.name,
      );
      assert.equal((await child.closed).code, 7, scenario.name);
    }
  },
);

test(
  "an Expired Search during observation is reported after prior records",
  { timeout: 20_000 },
  async (t) => {
    const host = await watchFixture();
    const child = streamingCli(
      ["search", "candidates", SEARCH_ID, "--watch", "--poll-interval-ms", "100"],
      { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" },
    );
    t.after(async () => {
      await child.stop();
      await host.close();
    });

    assert.deepEqual((await child.nextRecord()).result, { event: "started", searchId: SEARCH_ID });
    const response = await host.waitForResponseRequest();
    host.release(response, []);
    host.setSearchState("Expired");
    assert.deepEqual(await child.nextRecord(), {
      ok: false,
      searchId: SEARCH_ID,
      error: { code: "EXPIRED_SEARCH", message: "The Search has expired; create a fresh Search." },
    });
    assert.deepEqual(child.recordsSeen.map((record) => record.result?.event).filter(Boolean), [
      "started",
    ]);
    assert.equal((await child.closed).code, 7);
  },
);

test("a malformed response list produces a typed watch error", { timeout: 20_000 }, async (t) => {
  const host = await watchFixture();
  const child = streamingCli(["search", "candidates", SEARCH_ID, "--watch"], {
    SLSKD_BASE_URL: host.url,
    SLSKD_API_KEY: "secret",
  });
  t.after(async () => {
    await child.stop();
    await host.close();
  });

  assert.deepEqual((await child.nextRecord()).result, { event: "started", searchId: SEARCH_ID });
  const response = await host.waitForResponseRequest();
  host.release(response, {});
  assert.deepEqual(await child.nextRecord(), {
    ok: false,
    searchId: SEARCH_ID,
    error: { code: "REMOTE", message: "slskd returned an invalid Search response list." },
  });
  assert.equal((await child.closed).code, 7);
});

test(
  "a remote failure after a Candidate preserves prior output and emits no ended event",
  { timeout: 20_000 },
  async (t) => {
    const host = await watchFixture();
    const child = streamingCli(["search", "candidates", SEARCH_ID, "--watch"], {
      SLSKD_BASE_URL: host.url,
      SLSKD_API_KEY: "secret",
    });
    t.after(async () => {
      await child.stop();
      await host.close();
    });

    assert.deepEqual((await child.nextRecord()).result, { event: "started", searchId: SEARCH_ID });
    const firstPoll = await host.waitForResponseRequest();
    host.release(firstPoll, [CANDIDATE_ONE]);
    const candidate = await child.nextRecord();
    assert.equal(candidate.result.event, "candidate");
    assert.equal(candidate.result.candidate.username, "alice");

    const failedPoll = await host.waitForResponseRequest();
    host.release(failedPoll, { httpStatus: 500 });
    assert.deepEqual(await child.nextRecord(), {
      ok: false,
      searchId: SEARCH_ID,
      error: { code: "REMOTE", message: "slskd returned HTTP 500." },
    });
    assert.deepEqual(child.recordsSeen.map((record) => record.result?.event).filter(Boolean), [
      "started",
      "candidate",
    ]);
    assert.equal((await child.closed).code, 7);
  },
);

test(
  "authentication and compatibility failures retain typed envelopes",
  { timeout: 20_000 },
  async (t) => {
    for (const scenario of [
      { options: { auth: "not-secret" }, code: "AUTHENTICATION", exitCode: 4 },
      { options: { version: "0.1.0" }, code: "INCOMPATIBLE", exitCode: 5 },
    ]) {
      const host = await watchFixture(scenario.options);
      const child = streamingCli(["search", "candidates", SEARCH_ID, "--watch"], {
        SLSKD_BASE_URL: host.url,
        SLSKD_API_KEY: "secret",
      });
      t.after(async () => {
        await child.stop();
        await host.close();
      });

      const failure = await child.nextRecord();
      assert.equal(failure.ok, false);
      assert.equal(failure.searchId, SEARCH_ID);
      assert.equal(failure.error.code, scenario.code);
      assert.equal((await child.closed).code, scenario.exitCode);
    }
  },
);

test(
  "invalid watch options and illegal flag combinations fail clearly",
  { timeout: 20_000 },
  async (t) => {
    const host = await watchFixture();
    const invalidNumber = streamingCli(
      ["search", "candidates", SEARCH_ID, "--watch", "--poll-interval-ms", "99"],
      { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" },
    );
    const noWatch = streamingCli(["search", "candidates", SEARCH_ID, "--poll-interval-ms", "100"]);
    const unrelatedWatch = streamingCli(["search", "list", "--watch"]);
    t.after(async () => {
      await Promise.all([invalidNumber.stop(), noWatch.stop(), unrelatedWatch.stop()]);
      await host.close();
    });

    assert.deepEqual(await invalidNumber.nextRecord(), {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "pollIntervalMs must be an integer from 100 to 60000.",
      },
    });
    assert.deepEqual(await noWatch.nextRecord(), {
      ok: false,
      error: { code: "INVALID_INPUT", message: "Watch options require search candidates --watch." },
    });
    assert.deepEqual(await unrelatedWatch.nextRecord(), {
      ok: false,
      error: { code: "INVALID_INPUT", message: "Watch options require search candidates --watch." },
    });
    assert.deepEqual(
      [
        (await invalidNumber.closed).code,
        (await noWatch.closed).code,
        (await unrelatedWatch.closed).code,
      ],
      [2, 2, 2],
    );
  },
);

test(
  "a closed stdout consumer stops observation without an unhandled pipe error or mutation",
  { timeout: 20_000 },
  async (t) => {
    const host = await watchFixture();
    const child = streamingCli(["search", "candidates", SEARCH_ID, "--watch"], {
      SLSKD_BASE_URL: host.url,
      SLSKD_API_KEY: "secret",
    });
    t.after(async () => {
      await child.stop();
      await host.close();
    });

    assert.deepEqual((await child.nextRecord()).result, { event: "started", searchId: SEARCH_ID });
    const pendingResponse = await host.waitForResponseRequest();
    child.closeStdout();
    host.release(pendingResponse, [CANDIDATE_ONE]);
    assert.equal((await child.closed).code, 0);
    assert.deepEqual(
      child.recordsSeen.map((record) => record.result?.event),
      ["started"],
    );
    assert.ok(host.requests.every((request) => request.method === "GET"));
  },
);
