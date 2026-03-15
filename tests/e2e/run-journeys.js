#!/usr/bin/env node
// Parallel journey test runner
// Runs all journey test files concurrently and reports aggregated results.
// Usage: node tests/e2e/run-journeys.js [--filter 01,07]

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const FILTER = process.env.FILTER || (process.argv[2] ? process.argv[2].replace('--filter=', '') : null);

// Read KROMBAT_TEST_TOKEN from cluster secret if not already set in env.
// Allows journey tests to authenticate via the test-login bypass endpoint.
let KROMBAT_TEST_TOKEN = process.env.KROMBAT_TEST_TOKEN || '';
if (!KROMBAT_TEST_TOKEN) {
  try {
    const ctx = process.env.KUBECTL_CONTEXT || 'arn:aws:eks:us-west-2:319279230668:cluster/krombat';
    const raw = execSync(
      `kubectl --context "${ctx}" get secret krombat-test-auth -n rpg-system -o jsonpath='{.data.KROMBAT_TEST_USER}'`,
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim();
    if (raw) {
      KROMBAT_TEST_TOKEN = Buffer.from(raw, 'base64').toString('utf8').trim();
    }
  } catch (_) {
    // Secret not available — test bypass will be skipped; tests may fail if login screen is shown
  }
}

const journeyDir = path.join(__dirname, 'journeys');
const allFiles = fs.readdirSync(journeyDir)
  .filter(f => /^\d{2}-.*\.js$/.test(f))
  .sort();

const files = FILTER
  ? allFiles.filter(f => FILTER.split(',').some(n => f.startsWith(n.trim())))
  : allFiles;

if (files.length === 0) {
  console.error('No journey files found matching filter:', FILTER);
  process.exit(1);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`  Running ${files.length} journeys in parallel`);
console.log(`  BASE_URL: ${BASE_URL}`);
console.log('='.repeat(60) + '\n');

const startAll = Date.now();

const runs = files.map(file => {
  const fullPath = path.join(journeyDir, file);
  const label = file.replace('.js', '');

  return new Promise(resolve => {
    const proc = spawn(process.execPath, [fullPath], {
      env: { ...process.env, BASE_URL, KROMBAT_TEST_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const start = Date.now();
    proc.on('close', code => {
      resolve({
        label,
        file,
        code,
        stdout,
        stderr,
        duration: Date.now() - start,
      });
    });
  });
});

Promise.all(runs).then(results => {
  const elapsed = Date.now() - startAll;
  console.log(`\n${'='.repeat(60)}`);
  console.log('  JOURNEY RESULTS');
  console.log('='.repeat(60));

  let anyFailed = false;
  const failed = [];

  for (const r of results) {
    const status = r.code === 0 ? '✅' : '❌';
    const dur = (r.duration / 1000).toFixed(1) + 's';
    console.log(`\n${status} ${r.label} (${dur})`);

    // Print stdout always (each journey has its own pass/fail lines)
    if (r.stdout) {
      r.stdout.split('\n').forEach(line => {
        if (line.trim()) console.log('    ' + line);
      });
    }
    if (r.stderr && r.code !== 0) {
      r.stderr.split('\n').forEach(line => {
        if (line.trim()) console.error('    STDERR: ' + line);
      });
    }

    if (r.code !== 0) {
      anyFailed = true;
      failed.push(r.label);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  const passCount = results.filter(r => r.code === 0).length;
  const failCount = results.filter(r => r.code !== 0).length;
  console.log(`  ${passCount} passed, ${failCount} failed — total ${(elapsed / 1000).toFixed(1)}s`);
  if (failed.length > 0) {
    console.log(`  Failed: ${failed.join(', ')}`);
  }
  console.log('='.repeat(60) + '\n');

  process.exit(anyFailed ? 1 : 0);
});
