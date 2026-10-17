import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const SEARCH_ID = '11111111-1111-4111-8111-111111111111';
const TRANSFER_ID = '22222222-2222-4222-8222-222222222222';
const PATH = 'Albums\\artist\\song.flac';

async function fixture(options = {}) {
  const calls = [];
  let transfer = null;
  const startedAt = new Date().toISOString();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const path = new URL(req.url, 'http://localhost').pathname;
    calls.push({ method: req.method, path: req.url, body, key: req.headers['x-api-key'] });
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(value === undefined ? '' : JSON.stringify(value));
    };
    if (options.auth && req.headers['x-api-key'] !== options.auth) return send(401, {});
    if (path === '/api/v0/application/version') {
      if (options.delayVersion) await new Promise((resolve) => setTimeout(resolve, options.delayVersion));
      return send(200, options.version ?? '0.26.1');
    }
    if (path === '/api/v0/searches' && req.method === 'POST') return send(200, { id: SEARCH_ID, startedAt });
    if (path === `/api/v0/searches/${SEARCH_ID}`) return send(200, { id: SEARCH_ID, startedAt, state: 'InProgress' });
    if (path === `/api/v0/searches/${SEARCH_ID}/responses`) return send(200, [{ username: 'alice', hasFreeUploadSlot: true, queueLength: 2, files: [{ filename: PATH, size: 1234, extension: 'flac', bitRate: 900 }] }]);
    if (path === '/api/v0/transfers/downloads' && req.method === 'GET') return send(200, transfer ? [{ username: 'alice', directories: [{ directory: 'Albums', files: [transfer] }] }] : []);
    if (path === '/api/v0/transfers/downloads/batches' && req.method === 'POST') {
      if (options.delayBatch) await new Promise((resolve) => setTimeout(resolve, options.delayBatch));
      const payload = JSON.parse(body);
      transfer = { id: TRANSFER_ID, username: 'alice', filename: PATH, size: 1234, state: 'Queued', bytesTransferred: 0 };
      return send(201, { batch: { id: payload.id, transfers: [transfer] }, failures: [] });
    }
    if (path === `/api/v0/transfers/downloads/alice/${TRANSFER_ID}` && req.method === 'GET') return transfer ? send(200, transfer) : send(404, {});
    if (path === `/api/v0/transfers/downloads/alice/${TRANSFER_ID}` && req.method === 'DELETE') {
      if (!transfer) return send(404, {});
      if (req.url.includes('remove=true')) transfer = null;
      else transfer.state = 'Cancelled';
      return send(204);
    }
    if (path === '/api/v0/transfers/downloads/all/completed' && req.method === 'DELETE') return send(204);
    send(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    setTransfer(value) { transfer = value; },
    close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  };
}

function cli(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['dist/cli.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, SLSKD_CLI_CONFIG: '/nonexistent/slskd-cli-test.toml', SLSKD_BASE_URL: '', SLSKD_API_KEY: '', ...env },
      timeout: 5000,
    }, (error, stdout, stderr) => {
      if (error && error.killed) return reject(error);
      try { resolve({ code: error?.code ?? 0, json: JSON.parse(stdout), stderr }); } catch (parseError) { reject(parseError); }
    });
  });
}

test('packaged command completes and resumes a selected Workflow', async () => {
  const host = await fixture();
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: 'secret' };
  try {
    const created = await cli(['search', 'create', '--query', '  exact  query  '], env);
    assert.equal(created.code, 0);
    assert.equal(created.json.result.lifetimeSeconds, 60);
    const searchPayload = JSON.parse(host.calls.find((c) => c.method === 'POST' && c.path === '/api/v0/searches').body);
    assert.equal(searchPayload.searchText, '  exact  query  ');
    assert.equal(searchPayload.searchTimeout, 60000);

    const searchId = created.json.result.searchId;
    const inspected = await cli(['search', 'candidates', searchId], env);
    assert.equal(inspected.code, 0);
    const candidate = inspected.json.result.candidates[0];
    assert.deepEqual([candidate.username, candidate.path, candidate.size, candidate.queueLength, candidate.bitRate], ['alice', PATH, 1234, 2, 900]);

    const blocked = await cli(['transfer', 'enqueue', searchId, candidate.candidateId], env);
    assert.equal(blocked.json.error.code, 'ACKNOWLEDGEMENT_REQUIRED');
    assert.equal(host.calls.filter((c) => c.method === 'POST' && c.path === '/api/v0/transfers/downloads/batches').length, 0);

    const enqueued = await cli(['transfer', 'enqueue', searchId, candidate.candidateId, '--yes'], env);
    assert.equal(enqueued.code, 0);
    assert.equal(enqueued.json.result.transfer.id, TRANSFER_ID);
    const payload = JSON.parse(host.calls.find((c) => c.path === '/api/v0/transfers/downloads/batches').body);
    assert.deepEqual(payload.files, [{ filename: PATH, size: 1234 }]);
    assert.equal(payload.searchId, SEARCH_ID);

    const retried = await cli(['transfer', 'enqueue', searchId, candidate.candidateId, '--yes'], env);
    assert.equal(retried.json.result.existing, true);
    assert.equal(host.calls.filter((c) => c.method === 'POST' && c.path === '/api/v0/transfers/downloads/batches').length, 1);

    host.setTransfer({ id: TRANSFER_ID, username: 'alice', filename: PATH, size: 1234, state: 'Completed', bytesTransferred: 1234 });
    const resumed = await cli(['transfer', 'show', 'alice', TRANSFER_ID], env);
    assert.equal(resumed.json.result.status, 'complete');
    assert.equal(resumed.json.result.destination, null);
  } finally { await host.close(); }
});

test('connection profile precedence, authentication, and redaction', async () => {
  const host = await fixture({ auth: 'flag-secret' });
  const dir = mkdtempSync(join(tmpdir(), 'slskd-cli-'));
  const config = join(dir, 'config.toml');
  writeFileSync(config, `[connection]\nbaseUrl = "http://127.0.0.1:1"\napiKey = "file-secret"\n`);
  try {
    const run = await cli(['check', '--base-url', host.url, '--api-key', 'flag-secret'], { SLSKD_CLI_CONFIG: config, SLSKD_API_KEY: 'env-secret' });
    assert.equal(run.code, 0);
    assert.equal(run.json.result.apiKeyRole, 'unverified');
    assert.equal(host.calls[0].key, 'flag-secret');
    assert.equal(JSON.stringify(run.json).includes('flag-secret'), false);
    const rejected = await cli(['check', '--base-url', host.url, '--api-key', 'bad-secret'], { SLSKD_CLI_CONFIG: config });
    assert.equal(rejected.json.error.code, 'AUTHENTICATION');
    assert.equal(JSON.stringify(rejected.json).includes('bad-secret'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); await host.close(); }
});

test('incompatible instance and mutation acknowledgements have stable errors', async () => {
  const host = await fixture({ version: '0.25.1' });
  try {
    const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: 'secret' };
    const old = await cli(['check'], env);
    assert.equal(old.code, 5);
    assert.equal(old.json.error.code, 'INCOMPATIBLE');
    for (const args of [['transfer', 'cancel', 'alice', TRANSFER_ID], ['transfer', 'clear'], ['transfer', 'delete', 'alice', TRANSFER_ID]]) {
      const blocked = await cli(args, env);
      assert.equal(blocked.code, 2);
      assert.equal(blocked.json.error.code, 'ACKNOWLEDGEMENT_REQUIRED');
    }
    assert.equal(host.calls.some((c) => c.method === 'DELETE'), false);
  } finally { await host.close(); }
});

test('expired, mismatched, and missing Candidates never enqueue', async () => {
  const host = await fixture();
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: 'secret' };
  try {
    const created = await cli(['search', 'create', '--query', 'song'], env);
    const searchId = created.json.result.searchId;
    const candidateId = (await cli(['search', 'candidates', searchId], env)).json.result.candidates[0].candidateId;
    const missing = await cli(['transfer', 'enqueue', searchId, 'cand_AAAAAAAAAAAAAAAAAAAAAA', '--yes'], env);
    assert.equal(missing.json.error.code, 'MISSING_CANDIDATE');
    const data = Buffer.from(JSON.stringify({ id: SEARCH_ID, expiresAt: Date.now() - 1000 })).toString('base64url');
    const stale = `${data}.${createHmac('sha256', 'secret').update(data).digest('base64url')}`;
    const expired = await cli(['transfer', 'enqueue', stale, candidateId, '--yes'], env);
    assert.equal(expired.json.error.code, 'EXPIRED_SEARCH');
    assert.equal(host.calls.filter((c) => c.path === '/api/v0/transfers/downloads/batches').length, 0);
  } finally { await host.close(); }
});

test('cancellation is idempotent; clear and delete require separate acknowledgements', async () => {
  const host = await fixture();
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: 'secret' };
  const value = { id: TRANSFER_ID, username: 'alice', filename: PATH, size: 1234, state: 'Queued', bytesTransferred: 0 };
  host.setTransfer(value);
  try {
    const cancelled = await cli(['transfer', 'cancel', 'alice', TRANSFER_ID, '--yes'], env);
    assert.equal(cancelled.json.result.changed, true);
    assert.equal(cancelled.json.result.transfer.status, 'cancelled');
    const again = await cli(['transfer', 'cancel', 'alice', TRANSFER_ID, '--yes'], env);
    assert.equal(again.json.result.changed, false);
    assert.equal(host.calls.filter((c) => c.method === 'DELETE' && c.path.includes('remove=false')).length, 1);
    const cleared = await cli(['transfer', 'clear', '--yes'], env);
    assert.equal(cleared.json.result.scope, 'completed-downloads');
    const deleted = await cli(['transfer', 'delete', 'alice', TRANSFER_ID, '--yes'], env);
    assert.equal(deleted.json.result.removed, true);
    assert.equal(host.calls.filter((c) => c.method === 'DELETE').length, 3);
  } finally { await host.close(); }
});

test('Transfer inspection reports active progress and failure from slskd', async () => {
  const host = await fixture();
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: 'secret' };
  try {
    host.setTransfer({ id: TRANSFER_ID, username: 'alice', filename: PATH, size: 1234, state: 'InProgress', bytesTransferred: 617 });
    const active = await cli(['transfer', 'show', 'alice', TRANSFER_ID], env);
    assert.equal(active.json.result.status, 'active');
    assert.deepEqual(active.json.result.progress, { bytesTransferred: 617, size: 1234, percent: 50 });
    host.setTransfer({ id: TRANSFER_ID, username: 'alice', filename: PATH, size: 1234, state: 'Errored', bytesTransferred: 617, exception: 'peer disconnected' });
    const failed = await cli(['transfer', 'show', 'alice', TRANSFER_ID], env);
    assert.equal(failed.json.result.status, 'failed');
    assert.equal(failed.json.result.terminal, true);
    assert.equal(failed.json.result.exception, 'peer disconnected');
  } finally { await host.close(); }
});

test('a timed-out enqueue is an ambiguous mutation and is not retried', async () => {
  const host = await fixture({ delayBatch: 200 });
  const env = { SLSKD_BASE_URL: host.url, SLSKD_API_KEY: 'secret' };
  try {
    const searchId = (await cli(['search', 'create', '--query', 'song'], env)).json.result.searchId;
    const candidateId = (await cli(['search', 'candidates', searchId], env)).json.result.candidates[0].candidateId;
    const timedOut = await cli(['transfer', 'enqueue', searchId, candidateId, '--yes', '--timeout-ms', '50'], env);
    assert.equal(timedOut.code, 9);
    assert.equal(timedOut.json.error.code, 'AMBIGUOUS_MUTATION');
    assert.equal(host.calls.filter((c) => c.method === 'POST' && c.path === '/api/v0/transfers/downloads/batches').length, 1);
  } finally { await host.close(); }
});

test('version prereleases and read request timeouts are distinct failures', async () => {
  const preview = await fixture({ version: '0.26.1-preview' });
  try {
    const result = await cli(['check'], { SLSKD_BASE_URL: preview.url, SLSKD_API_KEY: 'secret' });
    assert.equal(result.json.error.code, 'INCOMPATIBLE');
  } finally { await preview.close(); }
  const slow = await fixture({ delayVersion: 150 });
  try {
    const result = await cli(['check', '--timeout-ms', '30'], { SLSKD_BASE_URL: slow.url, SLSKD_API_KEY: 'secret' });
    assert.equal(result.code, 8);
    assert.equal(result.json.error.code, 'TIMEOUT');
  } finally { await slow.close(); }
});
