#!/usr/bin/env node
/**
 * download-models.js — Download ONNX model files for Marble embeddings
 *
 * Fetches sentence-transformers/all-MiniLM-L6-v2 from HuggingFace and places
 * the files where core/embeddings.js expects them:
 *   models/all-MiniLM-L6-v2.onnx
 *   models/tokenizer.json
 *   models/vocab.txt
 *
 * Run: node scripts/download-models.js
 * Or:  npm run setup
 */

import { createWriteStream, mkdirSync, existsSync, statSync } from 'fs';
import { pipeline, Transform } from 'stream';
import { promisify } from 'util';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const pipelineAsync = promisify(pipeline);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, '..', 'models');

const FILES = [
  {
    url: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx',
    dest: 'all-MiniLM-L6-v2.onnx',
    minBytes: 80_000_000, // ~86MB
  },
  {
    url: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json',
    dest: 'tokenizer.json',
    minBytes: 400_000, // ~466KB
  },
  {
    url: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/vocab.txt',
    dest: 'vocab.txt',
    minBytes: 200_000, // ~231KB
  },
];

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'marble-setup/1.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        get(res.headers.location).then(resolve).catch(reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      resolve(res);
    }).on('error', reject);
  });
}

async function download(url, destPath) {
  const res = await get(url);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  let received = 0;

  const progress = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (total > 0) {
        const pct = Math.round((received / total) * 100);
        process.stdout.write(`\r  ${pct}% (${(received / 1e6).toFixed(1)}MB)`);
      }
      cb(null, chunk);
    },
  });

  await pipelineAsync(res, progress, createWriteStream(destPath));
  if (total > 0) process.stdout.write('\n');
}

async function main() {
  mkdirSync(MODELS_DIR, { recursive: true });

  let allPresent = true;
  for (const f of FILES) {
    const dest = path.join(MODELS_DIR, f.dest);
    if (!existsSync(dest) || statSync(dest).size < f.minBytes) {
      allPresent = false;
      break;
    }
  }

  if (allPresent) {
    console.log('✓ Model files already present — skipping download.');
    process.exit(0);
  }

  console.log('Downloading sentence-transformers/all-MiniLM-L6-v2 from HuggingFace...\n');

  for (const f of FILES) {
    const dest = path.join(MODELS_DIR, f.dest);
    if (existsSync(dest) && statSync(dest).size >= f.minBytes) {
      console.log(`  ✓ ${f.dest} already present`);
      continue;
    }
    process.stdout.write(`  Downloading ${f.dest}...`);
    try {
      await download(f.url, dest);
      const size = statSync(dest).size;
      console.log(`  ✓ ${f.dest} (${(size / 1e6).toFixed(1)}MB)`);
    } catch (err) {
      console.error(`\n  ✗ Failed to download ${f.dest}: ${err.message}`);
      console.error('  Check your internet connection or download manually from:');
      console.error(`  ${f.url}`);
      process.exit(1);
    }
  }

  console.log('\n✓ Models ready. Marble will use local ONNX embeddings.\n');
}

main();
