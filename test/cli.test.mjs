import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SEARCH_ID = "11111111-1111-4111-8111-111111111111";
const TRANSFER_ID = "22222222-2222-4222-8222-222222222222";
const PATH = "Albums\\artist\\song.flac";

test("package exposes the slskd executable", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.deepEqual(packageJson.bin, { slskd: "dist/cli.js" });
});

async function fixture(options = {}) {
  const calls = [];
  let transfer = null;
  let batch = null;
  let searchDeleted = false;
  const startedAt = options.startedAt ?? new Date().toISOString();
  const searchId = options.searchId ?? SEARCH_ID;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const path = new URL(req.url, "http://localhost").pathname;
    calls.push({ method: req.method, path: req.url, body, key: req.headers["x-api-key"] });
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(value === undefined ? "" : JSON.stringify(value));
    };
    if (options.auth && req.headers["x-api-key"] !== options.auth) return send(401, {});
    if (path === "/api/v0/application/version") {
      if (options.delayVersion)
        await new Promise((resolve) => setTimeout(resolve, options.delayVersion));
      return send(200, options.version ?? "0.26.1");
    }
    if (path === "/api/v0/searches" && req.method === "GET")
      return send(200, options.searches ?? []);
    if (path === "/api/v0/searches" && req.method === "POST")
      return send(200, { id: searchId, startedAt });
    if (path.toLowerCase() === `/api/v0/searches/${searchId}` && req.method === "GET")
      return searchDeleted
        ? send(404, {})
        : send(
            options.searchStatus ?? 200,
            options.search ?? { id: searchId, startedAt, state: "InProgress" },
          );
    if (path.toLowerCase() === `/api/v0/searches/${searchId}` && req.method === "DELETE") {
      if (searchDeleted || options.searchStatus === 404) return send(404, {});
      if (options.delaySearchDelete)
        await new Promise((resolve) => setTimeout(resolve, options.delaySearchDelete));
      searchDeleted = true;
      return send(204);
    }
    if (path === `/api/v0/searches/${searchId}/responses`)
      return send(200, [
        {
          username: "alice",
          hasFreeUploadSlot: true,
          queueLength: 2,
          files: [{ filename: PATH, size: 1234, extension: "flac", bitRate: 900 }],
        },
      ]);
    if (path === "/api/v0/transfers/downloads" && req.method === "GET")
      return send(
        200,
        transfer
          ? [{ username: "alice", directories: [{ directory: "Albums", files: [transfer] }] }]
          : [],
      );
    if (path === "/api/v0/transfers/downloads/batches" && req.method === "POST") {
      if (options.delayBatch)
        await new Promise((resolve) => setTimeout(resolve, options.delayBatch));
      const payload = JSON.parse(body);
      transfer = {
        id: TRANSFER_ID,
        username: "alice",
        filename: PATH,
        size: 1234,
        state: "Queued",
        bytesTransferred: 0,
      };
      batch = { id: payload.id, transfers: options.emptyBatch ? [] : [transfer] };
      if (options.conflictBatch) return send(409, {});
      return send(201, { batch, failures: [] });
    }
    if (batch && path === `/api/v0/transfers/downloads/batches/${batch.id}` && req.method === "GET")
      return send(200, batch);
    // slskd resolves individual downloads by ID, even when the route username differs.
    const transferRoute =
      path.startsWith("/api/v0/transfers/downloads/") && path.endsWith(`/${TRANSFER_ID}`);
    if (transferRoute && req.method === "GET")
      return transfer ? send(200, transfer) : send(404, {});
    if (transferRoute && req.method === "DELETE") {
      if (!transfer) return send(404, {});
      if (req.url.includes("remove=true")) transfer = null;
      else transfer.state = "Cancelled";
      return send(204);
    }
    if (path === "/api/v0/transfers/downloads/all/completed" && req.method === "DELETE")
      return send(204);
    send(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    setTransfer(value) {
      transfer = value;
    },
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function rawCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["dist/cli.js", ...args],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          SLSKD_CLI_CONFIG: "/nonexistent/slskd-cli-test.toml",
          SLSKD_BASE_URL: "",
          SLSKD_API_KEY: "",
          ...env,
        },
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        if (error && error.killed) return reject(error);
        resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
  });
}

async function cli(args, env = {}) {
  const result = await rawCli(args, env);
  return { code: result.code, json: JSON.parse(result.stdout), stderr: result.stderr };
}

test("help covers the root, command groups, and every command without configuration", async () => {
  const topics = [
    [],
    ["check"],
    ["search"],
    ["search", "list"],
    ["search", "create"],
    ["search", "candidates"],
    ["search", "folder"],
    ["search", "delete"],
    ["transfer"],
    ["transfer", "enqueue"],
    ["transfer", "show"],
    ["transfer", "cancel"],
    ["transfer", "clear"],
    ["transfer", "delete"],
  ];
  for (const topic of topics) {
    for (const args of [
      [...topic, "--help"],
      ["help", ...topic],
    ]) {
      const result = await rawCli(args);
      assert.equal(result.code, 0, args.join(" "));
      assert.match(result.stdout, /slskd/, args.join(" "));
      assert.equal(result.stderr, "", args.join(" "));
    }
  }
  for (const args of [[], ["search"], ["transfer"]]) {
    const result = await rawCli(args);
    assert.equal(result.code, 0, args.join(" "));
    assert.match(result.stdout, /slskd/, args.join(" "));
  }
  const unknown = await cli(["help", "unknown"]);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.json.error.code, "INVALID_INPUT");
});

test("unified folder commands advertise discovery, refresh and both enqueue selections", async () => {
  const search = await rawCli(["search", "folder", "--help"]);
  assert.equal(search.code, 0);
  for (const term of ["searchId", "candidateId", "folderRef", "--yes"])
    assert.ok(search.stdout.includes(term));
  const enqueue = await rawCli(["transfer", "enqueue", "--help"]);
  assert.equal(enqueue.code, 0);
  for (const term of ["searchId", "candidateId", "folderRef", "fileId", "--all", "--yes"])
    assert.ok(enqueue.stdout.includes(term));
  for (const args of [
    ["folder", "--help"],
    ["folder", "discover", "--yes"],
    ["transfer", "enqueue-folder", "--help"],
    ["transfer", "enqueue", SEARCH_ID, "candidate", "--all", "--yes"],
    ["search", "folder", "--all", "--yes"],
  ]) {
    const invalid = await cli(args);
    assert.equal(invalid.code, 2, args.join(" "));
    assert.equal(invalid.json.error.code, "INVALID_INPUT", args.join(" "));
  }
});

test("packaged command completes and resumes a selected Workflow", async () => {
  const host = await fixture();
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" };
  try {
    const created = await cli(["search", "create", "--query", "  exact  query  "], env);
    assert.equal(created.code, 0);
    assert.equal(created.json.result.lifetimeSeconds, 60);
    assert.equal(created.json.result.searchId, SEARCH_ID);
    assert.equal("expiresAt" in created.json.result, false);
    const searchPayload = JSON.parse(
      host.calls.find((c) => c.method === "POST" && c.path === "/api/v0/searches").body,
    );
    assert.equal(searchPayload.searchText, "  exact  query  ");
    assert.equal(searchPayload.searchTimeout, 60000);

    const searchId = created.json.result.searchId;
    const inspected = await cli(["search", "candidates", searchId], env);
    assert.equal(inspected.code, 0);
    const candidate = inspected.json.result.candidates[0];
    assert.equal(candidate.searchId, SEARCH_ID);
    assert.equal("slskdSearchId" in candidate, false);
    assert.deepEqual(
      [
        candidate.username,
        candidate.path,
        candidate.size,
        candidate.queueLength,
        candidate.bitRate,
      ],
      ["alice", PATH, 1234, 2, 900],
    );

    const blocked = await cli(["transfer", "enqueue", searchId, candidate.candidateId], env);
    assert.equal(blocked.json.error.code, "ACKNOWLEDGEMENT_REQUIRED");
    assert.equal(
      host.calls.filter(
        (c) => c.method === "POST" && c.path === "/api/v0/transfers/downloads/batches",
      ).length,
      0,
    );

    const enqueued = await cli(
      ["transfer", "enqueue", searchId, candidate.candidateId, "--yes"],
      env,
    );
    assert.equal(enqueued.code, 0);
    assert.equal(enqueued.json.result.transfer.id, TRANSFER_ID);
    const payload = JSON.parse(
      host.calls.find((c) => c.path === "/api/v0/transfers/downloads/batches").body,
    );
    assert.deepEqual(payload.files, [{ filename: PATH, size: 1234 }]);
    assert.equal(payload.searchId, SEARCH_ID);

    const retried = await cli(
      ["transfer", "enqueue", searchId, candidate.candidateId, "--yes"],
      env,
    );
    assert.equal(retried.json.result.existing, true);
    assert.equal(
      host.calls.filter(
        (c) => c.method === "POST" && c.path === "/api/v0/transfers/downloads/batches",
      ).length,
      1,
    );

    host.setTransfer({
      id: TRANSFER_ID,
      username: "alice",
      filename: PATH,
      size: 1234,
      state: "Completed",
      bytesTransferred: 1234,
    });
    const resumed = await cli(["transfer", "show", "alice", TRANSFER_ID], env);
    assert.equal(resumed.json.result.status, "complete");
    assert.equal(resumed.json.result.destination, null);
  } finally {
    await host.close();
  }
});

test("connection profile precedence, authentication, and redaction", async () => {
  const host = await fixture({ auth: "flag-secret" });
  const dir = mkdtempSync(join(tmpdir(), "slskd-cli-"));
  const config = join(dir, "config.toml");
  writeFileSync(config, `[connection]\nbaseUrl = "http://127.0.0.1:1"\napiKey = "file-secret"\n`);
  try {
    const run = await cli(["check", "--base-url", host.url, "--api-key", "flag-secret"], {
      SLSKD_CLI_CONFIG: config,
      SLSKD_API_KEY: "env-secret",
    });
    assert.equal(run.code, 0);
    assert.equal(run.json.result.apiKeyRole, "unverified");
    assert.equal(host.calls[0].key, "flag-secret");
    assert.equal(JSON.stringify(run.json).includes("flag-secret"), false);
    const rejected = await cli(["check", "--base-url", host.url, "--api-key", "bad-secret"], {
      SLSKD_CLI_CONFIG: config,
    });
    assert.equal(rejected.json.error.code, "AUTHENTICATION");
    assert.equal(JSON.stringify(rejected.json).includes("bad-secret"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await host.close();
  }
});

test("incompatible instance and mutation acknowledgements have stable errors", async () => {
  const host = await fixture({ version: "0.25.1" });
  try {
    const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" };
    const old = await cli(["check"], env);
    assert.equal(old.code, 5);
    assert.equal(old.json.error.code, "INCOMPATIBLE");
    for (const args of [
      ["transfer", "cancel", "alice", TRANSFER_ID],
      ["transfer", "clear"],
      ["transfer", "delete", "alice", TRANSFER_ID],
    ]) {
      const blocked = await cli(args, env);
      assert.equal(blocked.code, 2);
      assert.equal(blocked.json.error.code, "ACKNOWLEDGEMENT_REQUIRED");
    }
    assert.equal(
      host.calls.some((c) => c.method === "DELETE"),
      false,
    );
  } finally {
    await host.close();
  }
});

test("invalid Search identifiers and missing Candidates never enqueue", async () => {
  const host = await fixture();
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" };
  try {
    const created = await cli(["search", "create", "--query", "song"], env);
    const searchId = created.json.result.searchId;
    const candidateId = (await cli(["search", "candidates", searchId], env)).json.result
      .candidates[0].candidateId;
    const missing = await cli(
      ["transfer", "enqueue", searchId, "cand_AAAAAAAAAAAAAAAAAAAAAA", "--yes"],
      env,
    );
    assert.equal(missing.json.error.code, "MISSING_CANDIDATE");
    for (const invalidId of ["not-a-uuid", "old-signed.search-reference", "../searches"]) {
      const invalid = await cli(["transfer", "enqueue", invalidId, candidateId, "--yes"], env);
      assert.equal(invalid.code, 2);
      assert.equal(invalid.json.error.code, "INVALID_INPUT");
    }
    assert.equal(
      host.calls.filter((c) => c.path === "/api/v0/transfers/downloads/batches").length,
      0,
    );
  } finally {
    await host.close();
  }
});

test("cancellation is idempotent; clear and delete require separate acknowledgements", async () => {
  const host = await fixture();
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" };
  const value = {
    id: TRANSFER_ID,
    username: "alice",
    filename: PATH,
    size: 1234,
    state: "Queued",
    bytesTransferred: 0,
  };
  host.setTransfer(value);
  try {
    const cancelled = await cli(["transfer", "cancel", "alice", TRANSFER_ID, "--yes"], env);
    assert.equal(cancelled.json.result.changed, true);
    assert.equal(cancelled.json.result.transfer.status, "cancelled");
    const again = await cli(["transfer", "cancel", "alice", TRANSFER_ID, "--yes"], env);
    assert.equal(again.json.result.changed, false);
    assert.equal(
      host.calls.filter((c) => c.method === "DELETE" && c.path.includes("remove=false")).length,
      1,
    );
    const cleared = await cli(["transfer", "clear", "--yes"], env);
    assert.equal(cleared.json.result.scope, "completed-downloads");
    const deleted = await cli(["transfer", "delete", "alice", TRANSFER_ID, "--yes"], env);
    assert.equal(deleted.json.result.removed, true);
    assert.equal(host.calls.filter((c) => c.method === "DELETE").length, 3);
  } finally {
    await host.close();
  }
});

for (const command of ["show", "cancel", "delete"]) {
  test(`Transfer ${command} rejects a mismatched username without mutation`, async () => {
    const host = await fixture();
    const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" };
    host.setTransfer({
      id: TRANSFER_ID,
      username: "alice",
      filename: PATH,
      size: 1234,
      state: "Queued",
      bytesTransferred: 0,
    });
    try {
      const result = await cli(
        ["transfer", command, "bob", TRANSFER_ID, ...(command === "show" ? [] : ["--yes"])],
        env,
      );
      assert.equal(result.code, 7);
      assert.equal(result.json.error.code, "TRANSFER_NOT_FOUND");
      assert.equal(
        host.calls.some((call) => call.method === "DELETE"),
        false,
      );
      const unchanged = await cli(["transfer", "show", "alice", TRANSFER_ID], env);
      assert.equal(unchanged.code, 0);
      assert.equal(unchanged.json.result.username, "alice");
      assert.equal(unchanged.json.result.state, "Queued");
    } finally {
      await host.close();
    }
  });
}

test("Transfer inspection reports active progress and failure from slskd", async () => {
  const host = await fixture();
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" };
  try {
    host.setTransfer({
      id: TRANSFER_ID,
      username: "alice",
      filename: PATH,
      size: 1234,
      state: "InProgress",
      bytesTransferred: 617,
    });
    const active = await cli(["transfer", "show", "alice", TRANSFER_ID], env);
    assert.equal(active.json.result.status, "active");
    assert.deepEqual(active.json.result.progress, {
      bytesTransferred: 617,
      size: 1234,
      percent: 50,
    });
    host.setTransfer({
      id: TRANSFER_ID,
      username: "alice",
      filename: PATH,
      size: 1234,
      state: "Errored",
      bytesTransferred: 617,
      exception: "peer disconnected",
    });
    const failed = await cli(["transfer", "show", "alice", TRANSFER_ID], env);
    assert.equal(failed.json.result.status, "failed");
    assert.equal(failed.json.result.terminal, true);
    assert.equal(failed.json.result.exception, "peer disconnected");
  } finally {
    await host.close();
  }
});

for (const emptyBatch of [false, true]) {
  test(`concurrent enqueue reports an existing Transfer through ${emptyBatch ? "download lookup" : "batch lookup"}`, async () => {
    const host = await fixture({ conflictBatch: true, emptyBatch });
    const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" };
    try {
      const candidateId = (await cli(["search", "candidates", SEARCH_ID], env)).json.result
        .candidates[0].candidateId;
      const result = await cli(["transfer", "enqueue", SEARCH_ID, candidateId, "--yes"], env);
      assert.equal(result.code, 0);
      assert.equal(result.json.result.existing, true);
      assert.equal(result.json.result.transfer.id, TRANSFER_ID);
      assert.equal(result.json.result.transfer.username, "alice");
      assert.equal(host.calls.filter((call) => call.method === "POST").length, 1);
      assert.equal(
        host.calls.filter((call) => call.method === "GET" && call.path.includes("/batches/"))
          .length,
        1,
      );
    } finally {
      await host.close();
    }
  });
}

test("a timed-out enqueue is an ambiguous mutation and is not retried", async () => {
  const host = await fixture({ delayBatch: 200 });
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" };
  try {
    const searchId = (await cli(["search", "create", "--query", "song"], env)).json.result.searchId;
    const candidateId = (await cli(["search", "candidates", searchId], env)).json.result
      .candidates[0].candidateId;
    const timedOut = await cli(
      ["transfer", "enqueue", searchId, candidateId, "--yes", "--timeout-ms", "50"],
      env,
    );
    assert.equal(timedOut.code, 9);
    assert.equal(timedOut.json.error.code, "AMBIGUOUS_MUTATION");
    assert.equal(
      host.calls.filter(
        (c) => c.method === "POST" && c.path === "/api/v0/transfers/downloads/batches",
      ).length,
      1,
    );
  } finally {
    await host.close();
  }
});

test("version prereleases and read request timeouts are distinct failures", async () => {
  const preview = await fixture({ version: "0.26.1-preview" });
  try {
    const result = await cli(["check"], { SLSKD_BASE_URL: preview.url, SLSKD_API_KEY: "secret" });
    assert.equal(result.json.error.code, "INCOMPATIBLE");
  } finally {
    await preview.close();
  }
  const slow = await fixture({ delayVersion: 150 });
  try {
    const result = await cli(["check", "--timeout-ms", "30"], {
      SLSKD_BASE_URL: slow.url,
      SLSKD_API_KEY: "secret",
    });
    assert.equal(result.code, 8);
    assert.equal(result.json.error.code, "TIMEOUT");
  } finally {
    await slow.close();
  }
});

test("search list reports existing Searches without fetching Candidates", async () => {
  const host = await fixture({
    searches: [
      {
        id: SEARCH_ID,
        searchText: "artist album",
        state: "Completed, TimedOut",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:01:00Z",
        responseCount: 3,
        fileCount: 12,
        lockedFileCount: 2,
        responses: [{ username: "private-peer" }],
      },
    ],
  });
  try {
    const result = await cli(["search", "list"], {
      SLSKD_BASE_URL: host.url,
      SLSKD_API_KEY: "secret",
    });
    assert.equal(result.code, 0);
    assert.deepEqual(result.json, {
      ok: true,
      result: {
        searches: [
          {
            searchId: SEARCH_ID,
            query: "artist album",
            state: "Completed, TimedOut",
            startedAt: "2026-01-01T00:00:00Z",
            endedAt: "2026-01-01T00:01:00Z",
            responseCount: 3,
            fileCount: 12,
            lockedFileCount: 2,
          },
        ],
      },
    });
    assert.deepEqual(
      host.calls.map(({ method, path }) => [method, path]),
      [
        ["GET", "/api/v0/application/version"],
        ["GET", "/api/v0/searches"],
      ],
    );
  } finally {
    await host.close();
  }
});

test("search list handles an empty instance and unavailable metadata", async () => {
  for (const [searches, expected] of [
    [[], []],
    [
      [{ id: SEARCH_ID }],
      [
        {
          searchId: SEARCH_ID,
          query: null,
          state: null,
          startedAt: null,
          endedAt: null,
          responseCount: null,
          fileCount: null,
          lockedFileCount: null,
        },
      ],
    ],
  ]) {
    const host = await fixture({ searches });
    try {
      const result = await cli(["search", "list"], {
        SLSKD_BASE_URL: host.url,
        SLSKD_API_KEY: "secret",
      });
      assert.equal(result.code, 0);
      assert.deepEqual(result.json.result, { searches: expected });
    } finally {
      await host.close();
    }
  }
});

test("search list rejects malformed remote lists and invalid command arguments", async () => {
  for (const searches of [{}, [null], [{ id: "invalid" }]]) {
    const host = await fixture({ searches });
    const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" };
    try {
      const result = await cli(["search", "list"], env);
      assert.equal(result.code, 7);
      assert.equal(result.json.error.code, "REMOTE");
      for (const extra of [["extra"], ["--query", "song"], ["--yes"]]) {
        const invalid = await cli(["search", "list", ...extra], env);
        assert.equal(invalid.code, 2);
        assert.equal(invalid.json.error.code, "INVALID_INPUT");
      }
    } finally {
      await host.close();
    }
  }
});

test("search list accepts upstream GUIDs without RFC version or variant bits", async () => {
  const id = "00000000-0000-0000-0000-000000000000";
  const host = await fixture({ searches: [{ id }] });
  try {
    const result = await cli(["search", "list"], {
      SLSKD_BASE_URL: host.url,
      SLSKD_API_KEY: "secret",
    });
    assert.equal(result.code, 0);
    assert.equal(result.json.result.searches[0].searchId, id);
  } finally {
    await host.close();
  }
});

test("a listed completed Search can be inspected and enqueued with its slskd UUID", async () => {
  const host = await fixture({
    startedAt: "2020-01-01T00:00:00Z",
    search: { id: SEARCH_ID, state: "Completed, TimedOut" },
    searches: [{ id: SEARCH_ID, searchText: "artist album" }],
  });
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "another-api-key" };
  try {
    const listed = await cli(["search", "list"], env);
    assert.equal(listed.code, 0);
    const searchId = listed.json.result.searches[0].searchId;
    assert.equal(searchId, SEARCH_ID);
    const inspected = await cli(["search", "candidates", searchId], env);
    assert.equal(inspected.code, 0);
    const candidate = inspected.json.result.candidates[0];
    assert.equal(candidate.searchId, searchId);
    assert.equal("slskdSearchId" in candidate, false);
    const enqueued = await cli(
      ["transfer", "enqueue", searchId, candidate.candidateId, "--yes"],
      env,
    );
    assert.equal(enqueued.code, 0);
    assert.equal(enqueued.json.result.searchId, searchId);
    const payload = JSON.parse(
      host.calls.find((call) => call.path === "/api/v0/transfers/downloads/batches").body,
    );
    assert.equal(payload.searchId, searchId);
  } finally {
    await host.close();
  }
});

test("slskd controls missing and expired Searches before enqueue", async () => {
  for (const [options, code] of [
    [{ searchStatus: 404, search: {} }, "MISSING_SEARCH"],
    [{ search: { id: SEARCH_ID, state: "Expired" } }, "EXPIRED_SEARCH"],
    [{ search: { id: TRANSFER_ID } }, "REMOTE"],
  ]) {
    const host = await fixture(options);
    try {
      const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" };
      for (const args of [
        ["search", "candidates", SEARCH_ID],
        ["transfer", "enqueue", SEARCH_ID, "cand_AAAAAAAAAAAAAAAAAAAAAA", "--yes"],
      ]) {
        const result = await cli(args, env);
        assert.equal(result.code, 7);
        assert.equal(result.json.error.code, code);
      }
      assert.equal(
        host.calls.some((call) => call.method === "POST"),
        false,
      );
      assert.equal(
        host.calls.some((call) => call.path.endsWith("/responses")),
        false,
      );
    } finally {
      await host.close();
    }
  }
});

test("canonical Search GUIDs work across API keys and UUID casing", async () => {
  const searchId = "abcdefab-cdef-0000-0000-abcdefabcdef";
  const host = await fixture({ searchId });
  try {
    const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "first-key" };
    const created = await cli(["search", "create", "--query", "song"], env);
    assert.equal(created.code, 0);
    assert.equal(created.json.result.searchId, searchId);
    const first = await cli(["search", "candidates", searchId], env);
    const second = await cli(["search", "candidates", searchId.toUpperCase()], {
      ...env,
      SLSKD_API_KEY: "second-key",
    });
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    assert.deepEqual(second.json.result.candidates, first.json.result.candidates);
    const candidate = second.json.result.candidates[0];
    const enqueued = await cli(
      ["transfer", "enqueue", searchId.toUpperCase(), candidate.candidateId, "--yes"],
      env,
    );
    assert.equal(enqueued.code, 0);
    assert.equal(enqueued.json.result.searchId, searchId);
    const payload = JSON.parse(
      host.calls.find((call) => call.path === "/api/v0/transfers/downloads/batches").body,
    );
    assert.equal(payload.searchId, searchId);
  } finally {
    await host.close();
  }
});

test("search delete requires acknowledgement and removes the Search", async () => {
  const host = await fixture();
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" };
  try {
    const blocked = await cli(["search", "delete", SEARCH_ID], env);
    assert.equal(blocked.code, 2);
    assert.equal(blocked.json.error.code, "ACKNOWLEDGEMENT_REQUIRED");
    assert.equal(
      host.calls.some((call) => call.method === "DELETE"),
      false,
    );

    const deleted = await cli(["search", "delete", SEARCH_ID, "--yes"], env);
    assert.equal(deleted.code, 0);
    assert.deepEqual(deleted.json.result, { searchId: SEARCH_ID, deleted: true });

    const missing = await cli(["search", "delete", SEARCH_ID, "--yes"], env);
    assert.equal(missing.code, 7);
    assert.equal(missing.json.error.code, "MISSING_SEARCH");
  } finally {
    await host.close();
  }
});

test("search delete validates IDs and reports an ambiguous timeout without retrying", async () => {
  const host = await fixture({ delaySearchDelete: 200 });
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" };
  try {
    const invalid = await cli(["search", "delete", "not-a-uuid", "--yes"], env);
    assert.equal(invalid.code, 2);
    assert.equal(invalid.json.error.code, "INVALID_INPUT");
    assert.equal(
      host.calls.some((call) => call.method === "DELETE"),
      false,
    );

    const timedOut = await cli(["search", "delete", SEARCH_ID, "--yes", "--timeout-ms", "50"], env);
    assert.equal(timedOut.code, 9);
    assert.equal(timedOut.json.error.code, "AMBIGUOUS_MUTATION");
    assert.equal(host.calls.filter((call) => call.method === "DELETE").length, 1);
  } finally {
    await host.close();
  }
});
