// Journey 7: Dungeon Management — create, list, navigate, delete
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0;
function ok(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }

async function api(page, method, path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(async ([m, p, b]) => {
        const opts = { method: m, headers: { 'Content-Type': 'application/json' } };
        if (b) opts.body = JSON.stringify(b);
        const r = await fetch(`/api/v1${p}`, opts);
        const text = await r.text();
        try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
      }, [method, path, body]);
    } catch {
      await page.waitForTimeout(2000);
    }
  }
  return { status: 0, body: 'fetch failed after retries' };
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
    const tile = page.locator(`.dungeon-tile:has-text("${names[0]}")`);
    const delBtn = tile.locator('.tile-delete-btn');
    if (await delBtn.count() > 0) {
      await delBtn.click();
      await page.waitForTimeout(1000);
      // Dungeon should disappear from list immediately (not wait for kro)
      const listAfterDel = await page.textContent('body');
      !listAfterDel.includes(names[0]) ? ok(`"${names[0]}" removed from list immediately`) : fail(`"${names[0]}" still visible after delete click`);
    } else {
      fail('Delete button not found for ' + names[0]);
    }

    // === Refresh page — deleted dungeon should stay gone ===
    console.log('\n=== Refresh After Delete ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(3000);
    const afterRefresh = await page.textContent('body');
    !afterRefresh.includes(names[0]) ? ok(`"${names[0]}" gone after refresh`) : fail(`"${names[0]}" reappeared after refresh`);

    // === Delete two dungeons in sequence ===
    console.log('\n=== Delete Multiple ===');
    const tile1 = page.locator(`.dungeon-tile:has-text("${names[1]}")`);
    const del1 = tile1.locator('.tile-delete-btn');
    if (await del1.count() > 0) {
      await del1.click();
      await page.waitForTimeout(500);
    }
    const tile2 = page.locator(`.dungeon-tile:has-text("${names[2]}")`);
    const del2 = tile2.locator('.tile-delete-btn');
    if (await del2.count() > 0) {
      await del2.click();
      await page.waitForTimeout(1000);
    }
    const afterMultiDel = await page.textContent('body');
    !afterMultiDel.includes(names[1]) && !afterMultiDel.includes(names[2])
      ? ok('Both dungeons removed from list')
      : fail(`Multi-delete: ${afterMultiDel.includes(names[1]) ? names[1]+' visible' : ''} ${afterMultiDel.includes(names[2]) ? names[2]+' visible' : ''}`);

    // === Refresh — both stay gone ===
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(3000);
    const finalCheck = await page.textContent('body');
    !finalCheck.includes(names[1]) && !finalCheck.includes(names[2])
      ? ok('Both stay gone after refresh')
      : fail('Deleted dungeons reappeared after refresh');

    // === Delete via API ===
    console.log('\n=== Delete Dungeon (API) ===');
    // Create a fresh dungeon for API delete test
    const apiDelName = `j7-api-${ts}`;
    await api(page, 'POST', '/dungeons', { name: apiDelName, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    await page.waitForTimeout(3000);
    const delRes = await api(page, 'DELETE', `/dungeons/default/${apiDelName}`);
    (delRes.status === 204 || delRes.status === 200) ? ok(`DELETE API returns ${delRes.status}`) : fail(`DELETE returned ${delRes.status}`);
    // Backend should filter DELETING CRs from list
    await page.waitForTimeout(1000);
    const listAfterApiDel = await api(page, 'GET', '/dungeons');
    !listAfterApiDel.body.find(d => d.name === apiDelName)
      ? ok('Deleted dungeon filtered from API list')
      : fail('Deleted dungeon still in API list');

    // === Persistence Check ===
    console.log('\n=== Persistence Check ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(3000);
    const finalText = await page.textContent('body');
    !finalText.includes(names[0]) ? ok(`"${names[0]}" stays deleted`) : fail(`"${names[0]}" reappeared`);
    !finalText.includes(apiDelName) ? ok(`"${apiDelName}" stays deleted`) : fail(`"${apiDelName}" reappeared`);

    // === Recreate Deleted Name ===
    console.log('\n=== Recreate Deleted Name ===');
    // Wait for kro to fully clean up before recreating (CR must be fully gone, not just filtered)
    for (let i = 0; i < 40; i++) {
      const check = await api(page, 'GET', `/dungeons/default/${names[0]}`);
      if (check.status === 404) break;
      await page.waitForTimeout(3000);
    }
    const reRes = await api(page, 'POST', '/dungeons', { name: names[0], monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    reRes.status === 201 ? ok(`Recreated "${names[0]}"`) : fail(`Recreate failed: HTTP ${reRes.status} (kro may still be cleaning up)`);

    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    for (const name of [names[0], names[1], names[2], apiDelName]) {
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
