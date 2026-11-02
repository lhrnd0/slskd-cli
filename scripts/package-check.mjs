import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "slskd-cli-package-"));
const registry = "https://registry.npmjs.org/";
const server = createServer((request, response) => {
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/api/v0/application/version");
  assert.equal(request.headers["x-api-key"], "package-check-key");
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify("0.26.1"));
});

try {
  const packed = await exec(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: root, timeout: 30000 },
  );
  const [archive] = JSON.parse(packed.stdout);
  const paths = archive.files.map((file) => file.path);
  for (const required of ["package.json", "README.md", "LICENSE", "dist/cli.js"]) {
    assert.ok(paths.includes(required), `Package is missing ${required}`);
  }
  for (const path of paths) {
    assert.ok(
      ["package.json", "README.md", "LICENSE"].includes(path) ||
        /^dist\/[\w-]+\.(?:js|js\.map|d\.ts)$/.test(path),
      `Unexpected package file: ${path}`,
    );
  }
  const prefix = join(temporary, "installed");
  await exec(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry",
      registry,
      "--fetch-retries=0",
      "--fetch-timeout=30000",
      join(temporary, archive.filename),
    ],
    { cwd: temporary, timeout: 60000 },
  );
  const installed = join(prefix, "lib", "node_modules", "slskd-cli");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.version, archive.version);
  assert.equal(manifest.license, "MIT");
  const dependencyNames = await readdir(join(installed, "node_modules"));
  assert.deepEqual(dependencyNames, ["smol-toml"]);
  const executable = join(prefix, "bin", "slskd");
  const env = {
    ...process.env,
    SLSKD_CLI_CONFIG: join(temporary, "missing-config.toml"),
    SLSKD_BASE_URL: "",
    SLSKD_API_KEY: "",
    SLSKD_TIMEOUT_MS: "5000",
  };
  const help = await exec(executable, ["--help"], { cwd: temporary, env, timeout: 10000 });
  assert.match(help.stdout, /slskd/);
  assert.equal(help.stderr, "");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const check = await exec(executable, ["check"], {
    cwd: temporary,
    env: {
      ...env,
      SLSKD_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      SLSKD_API_KEY: "package-check-key",
    },
    timeout: 10000,
  });
  assert.equal(check.stderr, "");
  assert.deepEqual(JSON.parse(check.stdout), {
    ok: true,
    result: { compatible: true, version: "0.26.1", apiKeyRole: "unverified" },
  });
  // Exercise the installed artifact without the source tree or development dependencies.
  await cp(join(root, "test"), join(installed, "test"), { recursive: true });
  const tests = await exec(process.execPath, ["--test"], {
    cwd: installed,
    env,
    timeout: 120000,
  });
  process.stdout.write(tests.stdout);
  process.stderr.write(tests.stderr);
  const artifactDirectory = process.env.SLSKD_PACKAGE_ARTIFACT_DIR;
  if (artifactDirectory) {
    await mkdir(artifactDirectory, { recursive: true });
    await copyFile(join(temporary, archive.filename), join(artifactDirectory, archive.filename));
  }
  console.log(`Package installation passed: ${archive.name}@${archive.version}`);
  console.log(`Package integrity: ${archive.integrity}`);
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
