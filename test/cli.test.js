/**
 * cli.test.js — PR 4 acceptance: spawn bin/marble and check the no-LLM paths.
 *
 * Limiting coverage to commands that don't need network (`--help`,
 * `--version`, `init`, `diagnose`) keeps these tests deterministic in CI.
 * The LLM-driven commands (`ingest`, `learn`, `investigate`) rely on the
 * underlying Marble API which is covered by the other test suites.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { unlink, readFile } from 'fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'marble.mjs');

function runCLI(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [BIN, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('marble CLI — no-LLM paths', () => {
  it('--version prints the package version', async () => {
    const { code, stdout } = await runCLI(['--version']);
    assert.equal(code, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  it('--help prints usage without triggering the embeddings banner', async () => {
    const { code, stdout, stderr } = await runCLI(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /USAGE/);
    assert.match(stdout, /ingest/);
    assert.ok(!stderr.includes('Marble embeddings'),
      'embeddings banner should not fire on --help (lazy import)');
  });

  it('unknown command exits with usage and non-zero code', async () => {
    const { code, stdout, stderr } = await runCLI(['wat']);
    assert.equal(code, 1);
    const combined = stdout + stderr;
    assert.match(combined, /Unknown command/);
  });

  it('init creates a fresh KG; second init refuses to overwrite', async () => {
    const storage = join(tmpdir(), `marble-cli-${Date.now()}-init.json`);
    try {
      const first = await runCLI(['--storage', storage, 'init']);
      assert.equal(first.code, 0);
      assert.ok(existsSync(storage));

      // File contents must be valid JSON with version + empty user arrays
      const raw = await readFile(storage, 'utf-8');
      const saved = JSON.parse(raw);
      assert.ok(typeof saved.version === 'number', 'saved KG has version');
      assert.deepEqual(saved.user.beliefs, []);
      assert.deepEqual(saved.user.episodes, []);
      assert.deepEqual(saved.user.entities, []);

      const second = await runCLI(['--storage', storage, 'init']);
      assert.equal(second.code, 1, 'refuses to overwrite');
      assert.match(second.stderr, /already exists/);
    } finally {
      await unlink(storage).catch(() => {});
    }
  });

  it('diagnose on an empty KG prints a readable summary', async () => {
    const storage = join(tmpdir(), `marble-cli-${Date.now()}-diag.json`);
    try {
      await runCLI(['--storage', storage, 'init']);
      const { code, stdout } = await runCLI(['--storage', storage, 'diagnose']);
      assert.equal(code, 0);
      assert.match(stdout, /schema v\d+/);
      assert.match(stdout, /beliefs:\s+0 active/);
      assert.match(stdout, /episodes:\s+0/);
      assert.match(stdout, /last learn:\s+\(never\)/);
    } finally {
      await unlink(storage).catch(() => {});
    }
  });

  it('diagnose --json returns parseable JSON', async () => {
    const storage = join(tmpdir(), `marble-cli-${Date.now()}-json.json`);
    try {
      await runCLI(['--storage', storage, 'init']);
      const { code, stdout } = await runCLI(['--storage', storage, 'diagnose', '--json']);
      assert.equal(code, 0);
      const report = JSON.parse(stdout);
      assert.equal(report.facts.beliefs.total, 0);
      assert.equal(report.last_learn_at, null);
    } finally {
      await unlink(storage).catch(() => {});
    }
  });

  it('missing API key → exits with code 2 and clear message', async () => {
    const storage = join(tmpdir(), `marble-cli-${Date.now()}-noauth.json`);
    try {
      await runCLI(['--storage', storage, 'init']);
      // Strip every env var that could satisfy the key check, including any
      // inherited from the running shell.
      const scrubbedEnv = {
        ...process.env,
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        DEEPSEEK_API_KEY: '',
        LLM_API_KEY: '',
        LLM_PROVIDER: 'anthropic',
      };
      // Spawn directly so we can pass a precise env (not merged with process.env).
      const result = await new Promise((resolve) => {
        const child = spawn('node', [BIN, '--storage', storage, 'learn'], {
          env: scrubbedEnv,
        });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('exit', (code) => resolve({ code, stderr }));
      });
      assert.equal(result.code, 2, 'exit 2 signals missing credentials');
      assert.match(result.stderr, /ANTHROPIC_API_KEY is not set/);
    } finally {
      await unlink(storage).catch(() => {});
    }
  });
});
