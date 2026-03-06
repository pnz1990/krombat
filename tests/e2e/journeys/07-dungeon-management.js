// Journey 7: Dungeon Management — create, list, navigate, delete
// UI-ONLY: no kubectl, no fetch/api, no execSync
const { chromium } = require('playwright');
const { createDungeonUI, navigateHome, deleteDungeon } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0;
function ok(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }

async function run() {
  console.log('🧪 Journey 7: Dungeon Management\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const ts = Date.now();
  const names = [`j7a${ts}`, `j7b${ts}`, `j7c${ts}`];

  try {
    // === Create 3 dungeons via UI ===
    console.log('=== Create Dungeons ===');
    for (const name of names) {
      await page.goto(BASE_URL, { timeout: TIMEOUT });
      await page.waitForTimeout(2000);
      const created = await createDungeonUI(page, name, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
      created ? ok(`Created "${name}"`) : fail(`Failed to create "${name}"`);
    }

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
      await page.goto(BASE_URL, { timeout: TIMEOUT });
      await page.waitForTimeout(2000);
      const tile = page.locator(`.dungeon-tile:has-text("${name}")`);
      if (await tile.count() > 0) {
        await tile.click();
        await page.waitForTimeout(4000);
        const text = await page.textContent('body');
        (text.includes(name) && !text.includes('Initializing'))
          ? ok(`"${name}" loads correctly`)
          : fail(`"${name}" stuck or wrong content`);
      } else {
        fail(`"${name}" tile not found`);
      }
    }

    // === Click back, verify returns to list ===
    console.log('\n=== Back Navigation ===');
    const backBtn = page.locator('.back-btn');
    if (await backBtn.count() > 0) {
      await backBtn.click();
      await page.waitForTimeout(2000);
      const url = page.url();
      (url === BASE_URL + '/' || url === BASE_URL)
        ? ok('Back returns to list')
        : fail(`Back went to: ${url}`);
    } else {
      fail('Back button not found');
    }

    // === Delete first dungeon via UI ===
    console.log('\n=== Delete Dungeon (UI) ===');
    page.on('dialog', dialog => dialog.accept());
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(3000);

    const deleted = await deleteDungeon(page, names[0]);
    deleted ? ok(`Clicked delete on "${names[0]}"`) : fail(`Delete button not found for "${names[0]}"`);

    // Check for deleting state or immediate removal
    await page.waitForTimeout(1000);
    const afterDel = await page.textContent('body');
    if (afterDel.includes('Deleting') || !afterDel.includes(names[0])) {
      ok(`"${names[0]}" shows deleting state or removed`);
    } else {
      fail(`"${names[0]}" still showing normally after delete`);
    }

    // === Refresh page — deleted dungeon should be gone ===
    console.log('\n=== Refresh After Delete ===');
    // Wait for backend to filter out DELETING CRs
    for (let i = 0; i < 30; i++) {
      await page.goto(BASE_URL, { timeout: TIMEOUT });
      await page.waitForTimeout(2000);
      const text = await page.textContent('body');
      if (!text.includes(names[0])) break;
    }
    const afterRefresh = await page.textContent('body');
    !afterRefresh.includes(names[0])
      ? ok(`"${names[0]}" gone after refresh`)
      : fail(`"${names[0]}" still visible after refresh`);

    // === Delete two dungeons in sequence ===
    console.log('\n=== Delete Multiple ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(3000);
    await deleteDungeon(page, names[1]);
    await page.waitForTimeout(500);
    await deleteDungeon(page, names[2]);
    await page.waitForTimeout(1000);

    const afterMultiDel = await page.textContent('body');
    const bothDeleting = afterMultiDel.includes('Deleting') || (!afterMultiDel.includes(names[1]) && !afterMultiDel.includes(names[2]));
    bothDeleting ? ok('Both dungeons deleting or removed') : fail('Multi-delete did not work');

    // === Refresh — both gone ===
    for (let i = 0; i < 30; i++) {
      await page.goto(BASE_URL, { timeout: TIMEOUT });
      await page.waitForTimeout(2000);
      const text = await page.textContent('body');
      if (!text.includes(names[1]) && !text.includes(names[2])) break;
    }
    const finalCheck = await page.textContent('body');
    (!finalCheck.includes(names[1]) && !finalCheck.includes(names[2]))
      ? ok('Both gone after refresh')
      : fail('Deleted dungeons still visible');

    // === Persistence Check ===
    console.log('\n=== Persistence Check ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(3000);
    const finalText = await page.textContent('body');
    !finalText.includes(names[0]) ? ok(`"${names[0]}" stays deleted`) : fail(`"${names[0]}" reappeared`);

    // === Recreate Deleted Name ===
    console.log('\n=== Recreate Deleted Name ===');
    // Wait for kro to fully clean up the namespace before recreating
    await page.waitForTimeout(10000);
    const recreated = await createDungeonUI(page, names[0], { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    recreated ? ok(`Recreated "${names[0]}"`) : fail(`Failed to recreate "${names[0]}"`);

    // === Cleanup — delete all via UI ===
    console.log('\n=== Cleanup ===');
    await navigateHome(page, BASE_URL);
    await page.waitForTimeout(2000);
    for (const name of names) {
      await deleteDungeon(page, name);
      await page.waitForTimeout(500);
    }
    ok('Cleanup initiated via UI');

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
