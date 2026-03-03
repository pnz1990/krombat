// Journey 7: Dungeon Management — create, list, navigate, delete
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0;
function ok(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }

async function api(page, method, path, body) {
  return page.evaluate(async ([m, p, b]) => {
    const opts = { method: m, headers: { 'Content-Type': 'application/json' } };
    if (b) opts.body = JSON.stringify(b);
    const r = await fetch(`/api/v1${p}`, opts);
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
  }, [method, path, body]);
}

async function waitGone(page, name, maxWait = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const res = await api(page, 'GET', '/dungeons');
    if (!res.body.find(d => d.name === name)) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

async function run() {
  console.log('🧪 Journey 7: Dungeon Management\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const ts = Date.now();
  const names = [`j7-a-${ts}`, `j7-b-${ts}`, `j7-c-${ts}`];

  try {
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // === Create 3 dungeons ===
    console.log('=== Create Dungeons ===');
    for (const name of names) {
      const res = await api(page, 'POST', '/dungeons', { name, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
      res.status === 201 ? ok(`Created "${name}"`) : fail(`Create ${name}: HTTP ${res.status}`);
    }
    await page.waitForTimeout(5000);

    // === Verify all 3 in list ===
    console.log('\n=== List Dungeons ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(3000);
    const bodyText = await page.textContent('body');
    for (const name of names) {
      bodyText.includes(name) ? ok(`"${name}" in list`) : fail(`"${name}" missing from list`);
    }

    // === Click each dungeon, verify it loads ===
    console.log('\n=== Navigate to Dungeons ===');
    for (const name of names) {
      await page.goto(`${BASE_URL}/dungeon/default/${name}`, { timeout: TIMEOUT });
      await page.waitForTimeout(3000);
      const text = await page.textContent('body');
      const loaded = text.includes(name) && !text.includes('Initializing');
      loaded ? ok(`"${name}" loads correctly`) : fail(`"${name}" stuck or wrong content`);
    }

    // === Click back, verify returns to list ===
    console.log('\n=== Back Navigation ===');
    const backBtn = page.locator('.back-btn');
    if (await backBtn.count() > 0) {
      await backBtn.click();
      await page.waitForTimeout(2000);
      const url = page.url();
      (url === BASE_URL + '/' || url === BASE_URL) ? ok('Back returns to list') : fail(`Back went to: ${url}`);
    } else {
      fail('Back button not found');
    }

    // === Delete first dungeon via UI ===
    console.log('\n=== Delete Dungeon (UI) ===');
    page.on('dialog', dialog => dialog.accept());
    // Find the tile for our specific dungeon and click its delete button
    const tile = page.locator(`.dungeon-tile:has-text("${names[0]}")`);
    const delBtn = tile.locator('.tile-delete-btn');
    if (await delBtn.count() > 0) {
      await delBtn.click();
      ok('Delete button clicked');

      // Wait for dungeon to disappear (kro finalizer takes ~60s)
      const gone = await waitGone(page, names[0], 120000);
      gone ? ok(`"${names[0]}" removed from list`) : fail(`"${names[0]}" still in list after 120s`);
    } else {
      fail('Delete button not found for ' + names[0]);
    }

    // === Delete via API ===
    console.log('\n=== Delete Dungeon (API) ===');
    const delRes = await api(page, 'DELETE', `/dungeons/default/${names[1]}`);
    (delRes.status === 204 || delRes.status === 200) ? ok(`DELETE API returns ${delRes.status}`) : fail(`DELETE returned ${delRes.status}`);

    const gone2 = await waitGone(page, names[1], 90000);
    gone2 ? ok(`"${names[1]}" fully deleted`) : fail(`"${names[1]}" still exists after 90s`);

    // === Refresh page, verify deleted dungeons stay gone ===
    console.log('\n=== Persistence Check ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(3000);
    const finalText = await page.textContent('body');
    !finalText.includes(names[0]) ? ok(`"${names[0]}" stays deleted after refresh`) : fail(`"${names[0]}" reappeared`);
    !finalText.includes(names[1]) ? ok(`"${names[1]}" stays deleted after refresh`) : fail(`"${names[1]}" reappeared`);
    finalText.includes(names[2]) ? ok(`"${names[2]}" still exists`) : fail(`"${names[2]}" disappeared`);

    // === Create dungeon with same name as deleted ===
    console.log('\n=== Recreate Deleted Name ===');
    const reRes = await api(page, 'POST', '/dungeons', { name: names[0], monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    reRes.status === 201 ? ok(`Recreated "${names[0]}"`) : fail(`Recreate failed: HTTP ${reRes.status}`);

    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    for (const name of [names[0], names[2]]) {
      await api(page, 'DELETE', `/dungeons/default/${name}`);
    }
    ok('Cleanup initiated');

  } catch (error) {
    console.error(`\n❌ Fatal: ${error.message}`);
    failed++;
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Journey 7: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
