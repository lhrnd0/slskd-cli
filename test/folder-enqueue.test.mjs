import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";

const root = "C:\\Music\\Release";
const transferIds = Array.from(
  { length: 13 },
  (_, i) => `30000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);
const releaseFiles = [
  "C2 - Primary Perception - Triplet Move.flac",
  ...Array.from({ length: 12 }, (_, i) => `track-${i + 2}.flac`),
];

function run(args, env) {
  return new Promise((resolve) =>
    execFile(
      process.execPath,
      ["dist/cli.js", ...args],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          SLSKD_CLI_CONFIG: "/nonexistent/folder-enqueue.toml",
          SLSKD_BASE_URL: env.url,
          SLSKD_API_KEY: "fixture-key",
        },
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        let json;
        try {
          json = JSON.parse(stdout);
        } catch {
          return resolve({ code: error?.code === 2 ? 2 : 1, json: null, stderr });
        }
        resolve({ code: error?.code ?? 0, json, stderr });
      },
    ),
  );
}

async function fixture(options = {}) {
  const calls = [];
  let transfers = options.existing ?? [];
  let lastBatch = null;
  let nextId = 0;
  let changed = false;
  let listingFiles = options.listingFiles ?? releaseFiles;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const path = new URL(req.url, "http://localhost").pathname;
    calls.push({ method: req.method, path, body });
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(value === undefined ? "" : JSON.stringify(value));
    };
    if (path === "/api/v0/application/version") return send(200, "0.26.1");
    if (path === "/api/v0/searches/11111111-1111-4111-8111-111111111111" && req.method === "GET")
      return send(200, { id: "11111111-1111-4111-8111-111111111111", state: "Completed" });
    if (path === "/api/v0/searches/11111111-1111-4111-8111-111111111111/responses")
      return send(200, [
        {
          username: "alice",
          files: [{ filename: `${root}\\${releaseFiles[0]}`, size: 100, extension: "flac" }],
        },
      ]);
    if (path === `/api/v0/users/alice/directory` && req.method === "POST")
      return send(200, [
        {
          name: root,
          files: (options.emptyListing ? [] : listingFiles).map((filename, index) => ({
            filename,
            size: index + 100 + (changed ? 1 : 0),
            extension: options.extensions?.[index] ?? "flac",
            isLocked: options.locked?.includes(index) ?? false,
          })),
        },
      ]);
    if (path === "/api/v0/transfers/downloads" && req.method === "GET")
      return send(
        200,
        transfers.length
          ? [{ username: "alice", directories: [{ directory: root, files: transfers }] }]
          : [],
      );
    if (path === "/api/v0/transfers/downloads/batches" && req.method === "POST") {
      const payload = JSON.parse(body);
      if (options.rejectBatchAuth) return send(401, {});
      if (options.batchStatus === 409) {
        const created = payload.files.map((file) => ({
          id: transferIds[nextId++],
          username: "alice",
          filename: file.filename,
          size: file.size,
          state: "Queued",
        }));
        transfers = [...transfers, ...created];
        lastBatch = { batch: { id: payload.id, transfers: created }, failures: [] };
        return send(409, {});
      }
      if (options.ambiguous) {
        res.destroy();
        return;
      }
      const accepted =
        options.partial || options.serverFailure ? payload.files.slice(0, 1) : payload.files;
      const created = accepted.map((file) => ({
        id: transferIds[nextId++],
        username: "alice",
        filename: file.filename,
        size: file.size,
        state: "Queued",
      }));
      transfers = [...transfers, ...created];
      if (options.serverFailure) return send(500, {});
      const failures = options.partial
        ? payload.files
            .slice(1)
            .map((file) => ({ filename: file.filename, message: "not available" }))
        : [];
      if (options.delayedResponse)
        await new Promise((resolve) => setTimeout(resolve, options.delayedResponse));
      return send(options.partial ? 207 : 201, {
        batch: { id: payload.id, transfers: created },
        failures,
      });
    }
    if (path.startsWith("/api/v0/transfers/downloads/batches/") && req.method === "GET")
      return send(200, lastBatch);
    if (path.startsWith("/api/v0/transfers/downloads/alice/") && req.method === "GET") {
      const item = transfers.find((transfer) => transfer.id === path.split("/").at(-1));
      return item ? send(200, item) : send(404, {});
    }
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    setChanged: () => {
      changed = true;
    },
    setListingFiles: (value) => {
      listingFiles = value;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function discover(host) {
  const candidates = await run(
    ["search", "candidates", "11111111-1111-4111-8111-111111111111"],
    host,
  );
  assert.equal(candidates.code, 0, candidates.stderr);
  const output = await run(
    [
      "search",
      "folder",
      "11111111-1111-4111-8111-111111111111",
      candidates.json.result.candidates[0].candidateId,
      "--yes",
    ],
    host,
  );
  assert.equal(output.code, 0, output.stderr);
  return output.json.result;
}

test("packaged CLI enqueues all 13 fresh immediate-folder files and repeat resolves existing Transfers", async (t) => {
  const host = await fixture();
  t.after(host.close);
  const folder = await discover(host);
  const enqueued = await run(["transfer", "enqueue", folder.folderRef, "--all", "--yes"], host);
  assert.equal(enqueued.code, 0, enqueued.stderr);
  assert.equal(enqueued.json.result.counts.enqueued, 13);
  assert.equal(enqueued.json.result.files.length, 13);
  assert.ok(enqueued.json.result.files.every((file) => file.transfer?.id));
  const payload = JSON.parse(
    host.calls.find((call) => call.method === "POST" && call.path.endsWith("/batches")).body,
  );
  assert.equal(payload.files.length, 13);
  assert.equal("searchId" in payload, false);
  const repeated = await run(["transfer", "enqueue", folder.folderRef, "--all", "--yes"], host);
  assert.equal(repeated.code, 0);
  assert.equal(repeated.json.result.counts.existing, 13);
  assert.equal(
    host.calls.filter((call) => call.method === "POST" && call.path.endsWith("/batches")).length,
    1,
  );
});

test("packaged CLI requires acknowledgement and rejects stale IDs and conflicting modes before mutation", async (t) => {
  const host = await fixture();
  t.after(host.close);
  const folder = await discover(host);
  const noAck = await run(["transfer", "enqueue", folder.folderRef, folder.files[0].fileId], host);
  assert.equal(noAck.json.error.code, "ACKNOWLEDGEMENT_REQUIRED");
  const stale = await run(["transfer", "enqueue", folder.folderRef, "file_stale", "--yes"], host);
  assert.equal(stale.json.error.code, "INVALID_INPUT");
  const conflict = await run(
    ["transfer", "enqueue", folder.folderRef, folder.files[0].fileId, "--all", "--yes"],
    host,
  );
  assert.equal(conflict.json.error.code, "INVALID_INPUT");
  assert.equal(
    host.calls.filter((call) => call.method === "POST" && call.path.endsWith("/batches")).length,
    0,
  );
});

test("explicit selections deduplicate, preserve existing Transfers, and have order-independent batch IDs", async (t) => {
  const existing = {
    id: "40000000-0000-4000-8000-000000000001",
    username: "alice",
    filename: `${root}\\${releaseFiles[0]}`,
    size: 100,
    state: "Queued",
  };
  const first = await fixture({ existing: [existing] });
  t.after(first.close);
  const folder = await discover(first);
  const selected = [
    folder.files[2].fileId,
    folder.files[0].fileId,
    folder.files[2].fileId,
    folder.files[1].fileId,
  ];
  const result = await run(["transfer", "enqueue", folder.folderRef, ...selected, "--yes"], first);
  assert.equal(result.code, 0);
  assert.equal(result.json.result.counts.selected, 3);
  assert.equal(result.json.result.counts.existing, 1);
  assert.equal(result.json.result.counts.enqueued, 2);
  const firstBatch = JSON.parse(
    first.calls.find((call) => call.path.endsWith("/batches") && call.method === "POST").body,
  );
  assert.equal(firstBatch.files.length, 2);

  const second = await fixture({ existing: [existing] });
  t.after(second.close);
  const secondFolder = await discover(second);
  const reordered = await run(
    [
      "transfer",
      "enqueue",
      secondFolder.folderRef,
      secondFolder.files[1].fileId,
      secondFolder.files[2].fileId,
      "--yes",
    ],
    second,
  );
  assert.equal(reordered.code, 0);
  const secondBatch = JSON.parse(
    second.calls.find((call) => call.path.endsWith("/batches") && call.method === "POST").body,
  );
  assert.equal(firstBatch.id, secondBatch.id);
});

test("partial batch failures retain successful Transfer IDs and ambiguous POST is not retried", async (t) => {
  const host = await fixture({ partial: true });
  t.after(host.close);
  const folder = await discover(host);
  const partial = await run(
    [
      "transfer",
      "enqueue",
      folder.folderRef,
      folder.files[0].fileId,
      folder.files[1].fileId,
      "--yes",
    ],
    host,
  );
  assert.equal(partial.code, 7);
  assert.equal(partial.json.result.counts.enqueued, 1);
  assert.equal(partial.json.result.counts.failed, 1);
  assert.ok(partial.json.result.files[0].transfer.id);
  assert.equal(
    host.calls.filter((call) => call.method === "POST" && call.path.endsWith("/batches")).length,
    1,
  );

  const uncertainHost = await fixture({ ambiguous: true });
  t.after(uncertainHost.close);
  const uncertainFolder = await discover(uncertainHost);
  const uncertain = await run(
    ["transfer", "enqueue", uncertainFolder.folderRef, uncertainFolder.files[0].fileId, "--yes"],
    uncertainHost,
  );
  assert.equal(uncertain.code, 9);
  assert.equal(uncertain.json.result.files[0].outcome, "uncertain");
  assert.equal(
    uncertainHost.calls.filter((call) => call.method === "POST" && call.path.endsWith("/batches"))
      .length,
    1,
  );
});

test("409 batch conflict reconciles by batch identity and authentication keeps exit code 4", async (t) => {
  const conflictHost = await fixture({ batchStatus: 409 });
  t.after(conflictHost.close);
  const folder = await discover(conflictHost);
  const conflict = await run(
    ["transfer", "enqueue", folder.folderRef, folder.files[0].fileId, "--yes"],
    conflictHost,
  );
  assert.equal(conflict.code, 0);
  assert.equal(conflict.json.result.files[0].outcome, "enqueued");
  assert.equal(
    conflictHost.calls.filter((call) => call.method === "POST" && call.path.endsWith("/batches"))
      .length,
    1,
  );
  assert.equal(
    conflictHost.calls.filter((call) => call.method === "GET" && call.path.includes("/batches/"))
      .length,
    1,
  );

  const authHost = await fixture({ rejectBatchAuth: true });
  t.after(authHost.close);
  const authFolder = await discover(authHost);
  const auth = await run(
    ["transfer", "enqueue", authFolder.folderRef, authFolder.files[0].fileId, "--yes"],
    authHost,
  );
  assert.equal(auth.code, 4);
  assert.equal(auth.json.error.code, "AUTHENTICATION");
});

test("changed file sizes are rejected against a fresh listing and --all skips locked files", async (t) => {
  const changedHost = await fixture();
  t.after(changedHost.close);
  const previous = await discover(changedHost);
  changedHost.setChanged();
  const stale = await run(
    ["transfer", "enqueue", previous.folderRef, previous.files[0].fileId, "--yes"],
    changedHost,
  );
  assert.equal(stale.code, 2);
  assert.equal(stale.json.error.code, "INVALID_INPUT");
  assert.equal(
    changedHost.calls.filter((call) => call.method === "POST" && call.path.endsWith("/batches"))
      .length,
    0,
  );

  const lockedHost = await fixture({ locked: [3], extensions: { 12: "jpg" } });
  t.after(lockedHost.close);
  const folder = await discover(lockedHost);
  assert.equal(folder.files[12].eligible, true, "non-audio extras remain eligible");
  const explicitLocked = await run(
    ["transfer", "enqueue", folder.folderRef, folder.files[3].fileId, "--yes"],
    lockedHost,
  );
  assert.equal(explicitLocked.code, 2);
  assert.equal(explicitLocked.json.error.code, "INVALID_INPUT");
  const all = await run(["transfer", "enqueue", folder.folderRef, "--all", "--yes"], lockedHost);
  assert.equal(all.code, 0);
  assert.equal(all.json.result.counts.enqueued, 12);
  assert.equal(all.json.result.counts.skipped, 1);
  assert.equal(all.json.result.skipped[0].ineligibleReason, "locked");
  const post = JSON.parse(
    lockedHost.calls.find((call) => call.method === "POST" && call.path.endsWith("/batches")).body,
  );
  assert.ok(post.files.some((file) => file.filename.endsWith("track-13.flac")));
  assert.ok(!post.files.some((file) => file.filename.endsWith("track-4.flac")));
});

test("all mode reports skipped reasons for all-ineligible and empty current listings", async (t) => {
  const ineligibleHost = await fixture({ locked: Array.from({ length: 13 }, (_, i) => i) });
  t.after(ineligibleHost.close);
  const ineligibleFolder = await discover(ineligibleHost);
  const ineligible = await run(
    ["transfer", "enqueue", ineligibleFolder.folderRef, "--all", "--yes"],
    ineligibleHost,
  );
  assert.equal(ineligible.code, 2);
  assert.equal(ineligible.json.result.counts.selected, 0);
  assert.equal(ineligible.json.result.counts.skipped, 13);
  assert.ok(ineligible.json.result.skipped.every((file) => file.ineligibleReason === "locked"));
  assert.equal(
    ineligibleHost.calls.filter((call) => call.method === "POST" && call.path.endsWith("/batches"))
      .length,
    0,
  );

  const emptyHost = await fixture({ emptyListing: true });
  t.after(emptyHost.close);
  const emptyFolder = await discover(emptyHost);
  const empty = await run(
    ["transfer", "enqueue", emptyFolder.folderRef, "--all", "--yes"],
    emptyHost,
  );
  assert.equal(empty.code, 2);
  assert.equal(empty.json.result.counts.selected, 0);
  assert.equal(empty.json.result.counts.skipped, 0);
  assert.equal(
    emptyHost.calls.filter((call) => call.method === "POST" && call.path.endsWith("/batches"))
      .length,
    0,
  );
});

test("changed current membership rejects old explicit IDs and --all selects only the current listing", async (t) => {
  const host = await fixture();
  t.after(host.close);
  const previous = await discover(host);
  host.setListingFiles(releaseFiles.slice(1));
  const stale = await run(
    ["transfer", "enqueue", previous.folderRef, previous.files[0].fileId, "--yes"],
    host,
  );
  assert.equal(stale.code, 2);
  assert.equal(stale.json.error.code, "INVALID_INPUT");
  const current = await run(["transfer", "enqueue", previous.folderRef, "--all", "--yes"], host);
  assert.equal(current.code, 0);
  assert.equal(current.json.result.counts.selected, 12);
  assert.ok(current.json.result.files.every((file) => !file.path.endsWith(releaseFiles[0])));
});

test("HTTP 500 after partial acceptance reconciles known Transfers and marks the rest uncertain", async (t) => {
  const host = await fixture({ serverFailure: true });
  t.after(host.close);
  const folder = await discover(host);
  const result = await run(
    [
      "transfer",
      "enqueue",
      folder.folderRef,
      folder.files[0].fileId,
      folder.files[1].fileId,
      "--yes",
    ],
    host,
  );
  assert.equal(result.code, 9);
  assert.equal(result.json.result.counts.enqueued, 1);
  assert.equal(result.json.result.counts.uncertain, 1);
  assert.ok(result.json.result.files[0].transfer.id);
  assert.equal(
    host.calls.filter((call) => call.method === "POST" && call.path.endsWith("/batches")).length,
    1,
  );
});

test("timed out partial mutation reconciles known Transfers without retrying", async (t) => {
  const host = await fixture({ partial: true, delayedResponse: 250 });
  t.after(host.close);
  const folder = await discover(host);
  const result = await run(
    [
      "transfer",
      "enqueue",
      folder.folderRef,
      folder.files[0].fileId,
      folder.files[1].fileId,
      "--yes",
      "--timeout-ms",
      "100",
    ],
    host,
  );
  assert.equal(result.code, 9);
  assert.equal(result.json.result.counts.enqueued, 1);
  assert.equal(result.json.result.counts.uncertain, 1);
  assert.ok(result.json.result.files[0].transfer.id);
  assert.equal(
    host.calls.filter((call) => call.method === "POST" && call.path.endsWith("/batches")).length,
    1,
  );
});
