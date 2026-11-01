import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const SEARCH_ID = "11111111-1111-4111-8111-111111111111";
const candidatePath = "Albums\\A&B [Deluxe]\\01 - Intro.flac";

function run(args, env) {
  return new Promise((resolve) =>
    execFile(
      process.execPath,
      ["dist/cli.js", ...args],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          SLSKD_CLI_CONFIG: "/missing/folder-test.toml",
          SLSKD_BASE_URL: env.url,
          SLSKD_API_KEY: "test-key",
        },
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    ),
  );
}

async function fixture(
  listing = [
    {
      name: "Albums\\A&B [Deluxe]",
      files: [
        {
          filename: "01 - Intro.flac",
          size: 123,
          extension: "flac",
          bitRate: 900,
          length: 42,
          sampleRate: 44100,
          bitDepth: 16,
          isVariableBitRate: false,
        },
        { filename: "cover.jpg", size: 10, extension: "jpg" },
        { filename: "Disc 2\\nested.flac", size: 7, extension: "flac" },
        { filename: "locked.flac", size: 8, extension: "flac", locked: true },
      ],
    },
    {
      name: "Albums\\A&B [Deluxe]\\Disc 2",
      files: [{ filename: "nested.flac", size: 7, extension: "flac" }],
    },
  ],
  options = {},
) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(value === null ? "" : JSON.stringify(value));
    };
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/api/v0/application/version") return send(200, "0.26.1");
    if (path === `/api/v0/searches/${SEARCH_ID}`)
      return send(200, { id: SEARCH_ID, state: "Completed" });
    if (path === `/api/v0/searches/${SEARCH_ID}/responses`)
      return send(200, [
        {
          username: options.username ?? "alice",
          files: [
            { filename: options.candidatePath ?? candidatePath, size: 123, extension: "flac" },
          ],
        },
      ]);
    if (path === `/api/v0/users/${encodeURIComponent(options.username ?? "alice")}/directory`) {
      if (options.directoryStatus) return send(options.directoryStatus, {});
      if (options.delayDirectory)
        await new Promise((resolve) => setTimeout(resolve, options.delayDirectory));
      return send(
        200,
        typeof listing === "function"
          ? listing(JSON.parse(Buffer.concat(chunks).toString()))
          : listing,
      );
    }
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test("folder discover expands a Search Candidate to immediate files and reusable reference", async () => {
  const f = await fixture();
  try {
    const candidates = await run(["search", "candidates", SEARCH_ID], f);
    assert.equal(candidates.code, 0, candidates.stdout);
    const cid = JSON.parse(candidates.stdout).result.candidates[0].candidateId;
    const result = await run(["folder", "discover", SEARCH_ID, cid, "--yes"], f);
    assert.equal(result.code, 0, result.stdout);
    const folder = JSON.parse(result.stdout).result;
    assert.equal(folder.username, "alice");
    assert.equal(folder.directory, "Albums\\A&B [Deluxe]");
    assert.equal(folder.files.length, 4);
    assert.equal(folder.files[0].path, candidatePath);
    assert.equal(folder.files[0].bitDepth, 16);
    assert.equal(folder.files[0].eligible, true);
    assert.equal(folder.files[1].eligible, true);
    assert.equal(folder.files[1].extension, "jpg");
    assert.equal(folder.files[1].bitDepth, null);
    assert.equal(folder.files[1].isVariableBitRate, null);
    assert.equal(folder.files[2].eligible, false);
    assert.match(folder.files[2].ineligibleReason, /immediate directory/i);
    assert.equal(folder.files[3].eligible, false);
    assert.equal(folder.files[3].isLocked, true);
    assert.deepEqual(JSON.parse(f.calls.at(-1).body), { directory: "Albums\\A&B [Deluxe]" });
    const shown = await run(["folder", "show", folder.folderRef, "--yes"], f);
    assert.equal(shown.code, 0, shown.stdout);
    assert.deepEqual(JSON.parse(shown.stdout).result, folder);
    assert.equal(
      f.calls.filter((c) => c.method === "POST" && c.url.includes("directory")).length,
      2,
    );
    assert.equal(
      f.calls.some((c) => c.url.includes("transfers")),
      false,
    );
  } finally {
    await f.close();
  }
});

test("folder commands require acknowledgement before contacting slskd", async () => {
  const f = await fixture();
  try {
    const result = await run(["folder", "show", "folder_e30"], f);
    assert.equal(result.code, 2);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("folder show accepts a complete empty directory and rejects malformed listings", async () => {
  const empty = await fixture([{ name: "Albums\\A&B [Deluxe]", files: [] }]);
  try {
    const result = await run(
      ["folder", "show", "folder_WyJhbGljZSIsIkFsYnVtc1xcQSZCIFtEZWx1eGVdIl0", "--yes"],
      empty,
    );
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).result.files, []);
  } finally {
    await empty.close();
  }

  const incomplete = await fixture([{ name: "Albums\\A&B [Deluxe]" }]);
  try {
    const result = await run(
      ["folder", "show", "folder_WyJhbGljZSIsIkFsYnVtc1xcQSZCIFtEZWx1eGVdIl0", "--yes"],
      incomplete,
    );
    assert.equal(result.code, 7);
    assert.equal(JSON.parse(result.stdout).error.code, "REMOTE");
  } finally {
    await incomplete.close();
  }
});

test("folder discovery rejects missing, ambiguous and duplicate file listings", async () => {
  const missing = await fixture([{ name: "Other", files: [] }]);
  try {
    const candidates = await run(["search", "candidates", SEARCH_ID], missing);
    const cid = JSON.parse(candidates.stdout).result.candidates[0].candidateId;
    const result = await run(["folder", "discover", SEARCH_ID, cid, "--yes"], missing);
    assert.equal(result.code, 7);
    assert.equal(JSON.parse(result.stdout).error.code, "UNAVAILABLE_FOLDER");
  } finally {
    await missing.close();
  }

  const duplicateDirs = await fixture([
    { name: "Albums\\A&B [Deluxe]", files: [] },
    { name: "Albums\\A&B [Deluxe]", files: [] },
  ]);
  try {
    const result = await run(
      ["folder", "show", "folder_WyJhbGljZSIsIkFsYnVtc1xcQSZCIFtEZWx1eGVdIl0", "--yes"],
      duplicateDirs,
    );
    assert.equal(result.code, 7);
    assert.equal(JSON.parse(result.stdout).error.code, "REMOTE");
  } finally {
    await duplicateDirs.close();
  }

  const duplicateFiles = await fixture([
    {
      name: "Albums\\A&B [Deluxe]",
      files: [
        { filename: "same.flac", size: 1 },
        { filename: "same.flac", size: 2 },
      ],
    },
  ]);
  try {
    const result = await run(
      ["folder", "show", "folder_WyJhbGljZSIsIkFsYnVtc1xcQSZCIFtEZWx1eGVdIl0", "--yes"],
      duplicateFiles,
    );
    assert.equal(result.code, 7);
    assert.equal(JSON.parse(result.stdout).error.code, "REMOTE");
  } finally {
    await duplicateFiles.close();
  }
});

test("folder references preserve peer scope and reject traversal, while request failures stay typed", async () => {
  const peer = "odd/name & peer";
  const peerListing = await fixture([{ name: "Albums\\A&B [Deluxe]", files: [] }], {
    username: peer,
  });
  try {
    const candidates = await run(["search", "candidates", SEARCH_ID], peerListing);
    const cid = JSON.parse(candidates.stdout).result.candidates[0].candidateId;
    const discovered = await run(["folder", "discover", SEARCH_ID, cid, "--yes"], peerListing);
    assert.equal(discovered.code, 0, discovered.stdout);
    const folder = JSON.parse(discovered.stdout).result;
    assert.equal(folder.username, peer);
    assert.ok(peerListing.calls.some((call) => call.url.includes("odd%2Fname%20%26%20peer")));
  } finally {
    await peerListing.close();
  }

  const malicious = `folder_${Buffer.from(JSON.stringify(["alice", "..\\outside"])).toString("base64url")}`;
  const invalidRefFixture = await fixture();
  try {
    const result = await run(["folder", "show", malicious, "--yes"], invalidRefFixture);
    assert.equal(result.code, 2);
    assert.equal(
      invalidRefFixture.calls.some((call) => call.url.includes("/directory")),
      false,
    );
  } finally {
    await invalidRefFixture.close();
  }

  const unavailable = await fixture([], { directoryStatus: 404 });
  try {
    const result = await run(
      ["folder", "show", "folder_WyJhbGljZSIsIkFsYnVtc1xcQSZCIFtEZWx1eGVdIl0", "--yes"],
      unavailable,
    );
    assert.equal(result.code, 7);
    assert.equal(JSON.parse(result.stdout).error.code, "UNAVAILABLE_FOLDER");
  } finally {
    await unavailable.close();
  }

  const timeout = await fixture([], { delayDirectory: 300 });
  try {
    const result = await run(
      [
        "folder",
        "show",
        "folder_WyJhbGljZSIsIkFsYnVtc1xcQSZCIFtEZWx1eGVdIl0",
        "--yes",
        "--timeout-ms",
        "100",
      ],
      timeout,
    );
    assert.equal(result.code, 8);
    assert.equal(JSON.parse(result.stdout).error.code, "TIMEOUT");
  } finally {
    await timeout.close();
  }
});

test("malformed immediate file metadata remains visible and ineligible", async () => {
  const f = await fixture([
    {
      name: "Albums\\A&B [Deluxe]",
      files: [
        { filename: " ", size: -1 },
        { filename: "..", size: 4 },
        { filename: "ok.bin", size: "4" },
      ],
    },
  ]);
  try {
    const result = await run(
      ["folder", "show", "folder_WyJhbGljZSIsIkFsYnVtc1xcQSZCIFtEZWx1eGVdIl0", "--yes"],
      f,
    );
    assert.equal(result.code, 0, result.stdout);
    const files = JSON.parse(result.stdout).result.files;
    assert.equal(files.length, 3);
    assert.ok(files.every((file) => !file.eligible));
    assert.ok(files.every((file) => file.size === null || file.size === 4));
  } finally {
    await f.close();
  }
});

test("candidate usernames with control characters are rejected before browsing", async () => {
  const f = await fixture([], { username: "alice\nforged" });
  try {
    const candidates = await run(["search", "candidates", SEARCH_ID], f);
    const cid = JSON.parse(candidates.stdout).result.candidates[0].candidateId;
    const result = await run(["folder", "discover", SEARCH_ID, cid, "--yes"], f);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_INPUT");
    assert.equal(
      f.calls.some((call) => call.url.includes("/directory")),
      false,
    );
  } finally {
    await f.close();
  }
});
