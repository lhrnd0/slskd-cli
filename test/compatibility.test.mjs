import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function profile(t, contents) {
  const directory = mkdtempSync(join(tmpdir(), "slskd-compatibility-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "config.toml");
  if (contents !== undefined) writeFileSync(path, contents);
  return { path, directory };
}

function cli(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["dist/cli.js", ...args],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          SLSKD_CLI_CONFIG: "/nonexistent/slskd-compatibility.toml",
          SLSKD_BASE_URL: "",
          SLSKD_API_KEY: "",
          SLSKD_TIMEOUT_MS: "",
          ...env,
        },
        timeout: 5000,
      },
      (error, stdout, stderr) => {
        if (error?.killed) return reject(error);
        resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
  });
}

function failure(result, code, errorCode, message) {
  assert.equal(result.code, code, result.stdout);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: { code: errorCode, message },
  });
}

async function fixture(t, options = {}) {
  const calls = [];
  const timers = [];
  let bodyClosed = false;
  const server = createServer((req, res) => {
    calls.push({ method: req.method, path: req.url, key: req.headers["x-api-key"] });
    if (options.stallBody) {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('"0.26');
      res.on("close", () => {
        bodyClosed = true;
      });
      return;
    }
    const send = () => {
      res.writeHead(options.status ?? 200, { "content-type": "application/json" });
      res.end(options.raw ?? JSON.stringify(options.version ?? "0.26.1"));
    };
    if (options.delay) timers.push(setTimeout(send, options.delay));
    else send();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    timers.forEach(clearTimeout);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    get bodyClosed() {
      return bodyClosed;
    },
  };
}

test("help covers command syntax and options without reading an invalid profile or contacting slskd", async (t) => {
  const host = await fixture(t);
  const config = profile(t, 'apiKey = "profile-secret"\ninvalid = [');
  const env = {
    SLSKD_CLI_CONFIG: config.path,
    SLSKD_BASE_URL: host.url,
    SLSKD_API_KEY: "env-secret",
  };
  const topics = [
    [[], ["check", "search", "transfer", "message"]],
    [["check"], ["check"]],
    [["search"], ["list", "create", "candidates", "folder", "delete"]],
    [["search", "list"], ["list"]],
    [
      ["search", "create"],
      ["--query", "--lifetime-seconds"],
    ],
    [
      ["search", "candidates"],
      ["<searchId>", "--watch", "--poll-interval-ms", "--watch-timeout-seconds"],
    ],
    [
      ["search", "folder"],
      ["<searchId>", "<candidateId>", "<folderRef>", "--yes"],
    ],
    [
      ["search", "delete"],
      ["<searchId>", "--yes"],
    ],
    [["transfer"], ["enqueue", "show", "cancel", "clear", "delete"]],
    [
      ["transfer", "enqueue"],
      ["<searchId>", "<candidateId>", "<folderRef>", "<fileId", "--all", "--yes"],
    ],
    [
      ["transfer", "show"],
      ["<username>", "<transferId>"],
    ],
    [
      ["transfer", "cancel"],
      ["<username>", "<transferId>", "--yes"],
    ],
    [["transfer", "clear"], ["--yes"]],
    [
      ["transfer", "delete"],
      ["<username>", "<transferId>", "--yes"],
    ],
    [["message"], ["conversations", "list", "send", "acknowledge", "watch"]],
    [["message", "conversations"], ["--unacknowledged"]],
    [
      ["message", "list"],
      ["<username>", "--unacknowledged"],
    ],
    [
      ["message", "send"],
      ["<username>", "--text", "--stdin", "--yes"],
    ],
    [
      ["message", "acknowledge"],
      ["<username>", "--id", "--all", "--yes"],
    ],
    [
      ["message", "watch"],
      ["--username", "--new-only", "--poll-interval-ms", "--timeout"],
    ],
  ];
  for (const [topic, terms] of topics) {
    for (const args of [
      [...topic, "--help"],
      ["help", ...topic],
    ]) {
      const result = await cli(args, env);
      assert.equal(result.code, 0, args.join(" "));
      assert.equal(result.stderr, "");
      for (const term of terms) assert.ok(result.stdout.includes(term), `${args}: ${term}`);
      assert.ok(!result.stdout.includes("profile-secret"));
      assert.ok(!result.stdout.includes("env-secret"));
    }
  }
  assert.deepEqual(host.calls, []);
});

test("parser errors precede profile access and preserve exact diagnostics", async (t) => {
  const host = await fixture(t);
  const config = profile(t, "invalid = [");
  const env = { SLSKD_CLI_CONFIG: config.path, SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "key" };
  for (const [args, message] of [
    [["check", "--unknown"], "Unknown or repeated command flag."],
    [["check", "--api-key=a", "--api-key", "b"], "Unknown or repeated command flag."],
    [["check", "--help", "--help"], "Unknown or repeated command flag."],
    [["search", "create", "--query"], "--query requires a value."],
    [["search", "create", "--query", "--help"], "--query requires a value."],
    [["help", "unknown"], "Unknown help topic."],
    [["unknown"], "Unknown command."],
    [["check", "extra"], "Unknown command."],
  ]) {
    failure(await cli(args, env), 2, "INVALID_INPUT", message);
  }
  for (const flag of ["help", "yes", "watch", "all", "stdin", "unacknowledged", "new-only"]) {
    for (const value of ["", "true", "false"]) {
      failure(
        await cli(["check", `--${flag}=${value}`], env),
        2,
        "INVALID_INPUT",
        `--${flag} does not take a value.`,
      );
    }
  }
  assert.deepEqual(host.calls, []);
});

test("acknowledgement and command-specific flag validation precede profile access", async (t) => {
  const config = profile(t, "invalid = [");
  for (const [args, errorCode, message] of [
    [
      ["transfer", "enqueue"],
      "ACKNOWLEDGEMENT_REQUIRED",
      "This state-changing command requires --yes.",
    ],
    [["check", "--yes"], "INVALID_INPUT", "--yes is only valid for state-changing commands."],
    [
      ["search", "create", "--query", "song", "--yes"],
      "INVALID_INPUT",
      "--yes is only valid for state-changing commands.",
    ],
    [
      ["check", "--query", "song"],
      "INVALID_INPUT",
      "Search flags are only valid for search create.",
    ],
    [["check", "--text", "hello"], "INVALID_INPUT", "Message flags require a message command."],
    [["message", "list"], "INVALID_INPUT", "Invalid message command arguments."],
    [
      ["message", "list", "alice", "--yes"],
      "INVALID_INPUT",
      "A flag is not valid for this message command.",
    ],
  ]) {
    failure(await cli(args, { SLSKD_CLI_CONFIG: config.path }), 2, errorCode, message);
  }
});

test("configuration and compatibility checks precede ordinary command argument validation", async (t) => {
  failure(
    await cli(["search", "list", "extra"]),
    3,
    "MISSING_CONFIGURATION",
    "Configure baseUrl and apiKey in the connection profile, environment, or flags.",
  );
  const old = await fixture(t, { version: "0.25.1" });
  failure(
    await cli(["search", "list", "extra"], { SLSKD_BASE_URL: old.url, SLSKD_API_KEY: "key" }),
    5,
    "INCOMPATIBLE",
    "slskd 0.25.1 is unsupported; version 0.26.1 or later is required.",
  );
  const host = await fixture(t);
  for (const args of [
    ["search", "create", "extra", "--query", "song"],
    ["search", "list", "extra"],
    ["search", "candidates"],
  ]) {
    failure(
      await cli(args, { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "key" }),
      2,
      "INVALID_INPUT",
      "Invalid command arguments.",
    );
  }
  assert.deepEqual(old.calls, [{ method: "GET", path: "/api/v0/application/version", key: "key" }]);
  assert.equal(host.calls.length, 3);
  assert.ok(host.calls.every((call) => call.path === "/api/v0/application/version"));
});

test("Connection profile values resolve from file, environment, then flags with both flag syntaxes", async (t) => {
  const file = await fixture(t);
  const environment = await fixture(t);
  const flag = await fixture(t);
  const config = profile(t, `[connection]\nbaseUrl = "${file.url}"\napiKey = "file-secret"\n`);
  const cases = [
    [[], { SLSKD_CLI_CONFIG: config.path }],
    [
      [],
      {
        SLSKD_CLI_CONFIG: config.path,
        SLSKD_BASE_URL: environment.url,
        SLSKD_API_KEY: "env-secret",
      },
    ],
    [
      ["--base-url", flag.url, "check", "--api-key=flag-secret"],
      {
        SLSKD_CLI_CONFIG: config.path,
        SLSKD_BASE_URL: environment.url,
        SLSKD_API_KEY: "env-secret",
      },
    ],
  ];
  for (const [args, env] of cases) {
    const result = await cli(args.length ? args : ["check"], env);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      result: { compatible: true, version: "0.26.1", apiKeyRole: "unverified" },
    });
  }
  for (const [host, key] of [
    [file, "file-secret"],
    [environment, "env-secret"],
    [flag, "flag-secret"],
  ]) {
    assert.deepEqual(host.calls, [{ method: "GET", path: "/api/v0/application/version", key }]);
  }
});

test("Request timeout precedence uses flags before environment before the Connection profile", async (t) => {
  const host = await fixture(t, { delay: 1000 });
  const config = profile(t, `baseUrl = "${host.url}"\napiKey = "secret"\ntimeoutMs = 300\n`);
  failure(
    await cli(["check"], { SLSKD_CLI_CONFIG: config.path }),
    8,
    "TIMEOUT",
    "Request timed out after 300 ms.",
  );
  failure(
    await cli(["check"], { SLSKD_CLI_CONFIG: config.path, SLSKD_TIMEOUT_MS: "500" }),
    8,
    "TIMEOUT",
    "Request timed out after 500 ms.",
  );
  const result = await cli(["check", "--timeout-ms=3000"], {
    SLSKD_CLI_CONFIG: config.path,
    SLSKD_TIMEOUT_MS: "500",
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(host.calls.length, 3);
});

test("missing profiles allow overrides while invalid and unreadable profiles reject them without exposing credentials", async (t) => {
  const host = await fixture(t);
  const config = profile(t);
  const env = {
    SLSKD_CLI_CONFIG: config.path,
    SLSKD_BASE_URL: host.url,
    SLSKD_API_KEY: "env-secret",
  };
  assert.equal((await cli(["check"], env)).code, 0);
  for (const contents of [
    'apiKey = "profile-secret"\ninvalid = [',
    "connection = []",
    "connection = 1",
  ]) {
    writeFileSync(config.path, contents);
    const result = await cli(["check", "--api-key", "flag-secret"], env);
    failure(result, 2, "INVALID_CONFIG", "The connection profile is not valid TOML.");
    for (const secret of ["profile-secret", "env-secret", "flag-secret"]) {
      assert.ok(!result.stdout.includes(secret));
      assert.ok(!result.stderr.includes(secret));
    }
  }
  failure(
    await cli(["check"], { ...env, SLSKD_CLI_CONFIG: config.directory }),
    2,
    "INVALID_CONFIG",
    "Could not read the connection profile.",
  );
  assert.equal(host.calls.length, 1);
});

test("invalid connection values preserve messages and never contact slskd", async (t) => {
  const host = await fixture(t);
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "key" };
  for (const [args, message] of [
    [["--base-url", "relative/path"], "baseUrl must be an absolute HTTP or HTTPS URL."],
    [["--base-url", "ftp://localhost"], "baseUrl must use HTTP or HTTPS."],
    [
      ["--base-url", "http://user:secret@localhost"],
      "baseUrl cannot contain credentials, a query, or a fragment.",
    ],
    [
      ["--base-url", `${host.url}?key=secret`],
      "baseUrl cannot contain credentials, a query, or a fragment.",
    ],
    [
      ["--base-url", `${host.url}#secret`],
      "baseUrl cannot contain credentials, a query, or a fragment.",
    ],
    [["--timeout-ms", "0"], "timeoutMs must be a positive integer."],
    [["--timeout-ms", "1.5"], "timeoutMs must be a positive integer."],
    [["--timeout-ms", "2147483648"], "timeoutMs must be a positive integer."],
  ]) {
    failure(await cli(["check", ...args], env), 2, "INVALID_INPUT", message);
  }
  assert.deepEqual(host.calls, []);
});

test("check failures preserve error envelopes, exit codes, redaction and a single request", async (t) => {
  for (const [options, code, errorCode, message] of [
    [{ status: 401 }, 4, "AUTHENTICATION", "slskd rejected the API key or its permissions."],
    [{ status: 403 }, 4, "AUTHENTICATION", "slskd rejected the API key or its permissions."],
    [{ status: 500 }, 7, "REMOTE", "slskd returned HTTP 500."],
    [{ raw: "not-json secret" }, 7, "REMOTE", "slskd returned invalid JSON."],
    [
      { version: {} },
      5,
      "INCOMPATIBLE",
      "slskd did not return a recognizable application version.",
    ],
  ]) {
    const host = await fixture(t, { ...(options.status ? { raw: '"secret"' } : {}), ...options });
    const result = await cli(["check"], { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: "secret" });
    failure(result, code, errorCode, message);
    assert.ok(!result.stdout.includes("secret"));
    assert.deepEqual(host.calls, [
      { method: "GET", path: "/api/v0/application/version", key: "secret" },
    ]);
  }
});

test("Request timeout covers the complete response body and closes the pending request without retrying", async (t) => {
  const host = await fixture(t, { stallBody: true });
  failure(
    await cli(["check", "--timeout-ms", "300"], {
      SLSKD_BASE_URL: host.url,
      SLSKD_API_KEY: "secret",
    }),
    8,
    "TIMEOUT",
    "Request timed out after 300 ms.",
  );
  assert.equal(host.calls.length, 1);
  assert.equal(host.bodyClosed, true);
});
