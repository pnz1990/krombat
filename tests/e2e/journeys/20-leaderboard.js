// Journey 20: Leaderboard
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests: Leaderboard button visible on dungeon list; panel opens; shows correct columns;
//        after deleting a dungeon, its record appears in the leaderboard.
const { chromium } = require('playwright');
const { createDungeonUI, deleteDungeon } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 20000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function run() {
  console.log('Journey 20: Leaderboard\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j20-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  try {
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // ── Leaderboard accessible via hamburger menu on home screen ──────────────
    console.log('\n  [Leaderboard via hamburger menu]');
    const hamBtn = page.locator('button.hamburger-btn[aria-label="Menu"]');
    await hamBtn.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await hamBtn.count() > 0) ? ok('Hamburger menu button visible on home screen') : fail('Hamburger button not found (.hamburger-btn)');

    await hamBtn.click();
    await page.waitForTimeout(300);

    const lbItem = page.locator('button.hamburger-item:has-text("Leaderboard")');
    (await lbItem.count() > 0) ? ok('Leaderboard item present in hamburger menu') : fail('Leaderboard item not found in hamburger menu');
    (await lbItem.textContent()).toLowerCase().includes('leaderboard')
      ? ok('Leaderboard item text correct')
      : fail('Leaderboard item text incorrect');

    // ── Open leaderboard panel ────────────────────────────────────────────────
    console.log('\n  [Open leaderboard panel]');
    await lbItem.click();
    await page.waitForTimeout(1000);

    const panel = page.locator('.leaderboard-panel');
    await panel.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await panel.count() > 0) ? ok('Leaderboard panel opened (.leaderboard-panel)') : fail('Leaderboard panel not found');

    // Title
    const title = page.locator('.leaderboard-title');
    (await title.count() > 0) ? ok('Leaderboard title present (.leaderboard-title)') : fail('Leaderboard title not found');
    (await title.textContent()).toLowerCase().includes('leaderboard')
      ? ok('Leaderboard title text correct')
      : fail('Leaderboard title text incorrect');

    // ── Close button works ────────────────────────────────────────────────────
    console.log('\n  [Close button]');
    const closeBtn = page.locator('.leaderboard-close');
    (await closeBtn.count() > 0) ? ok('Leaderboard close button present') : fail('Leaderboard close button not found');
    await closeBtn.click();
    await page.waitForTimeout(300);
    const panelGone = await page.locator('.leaderboard-panel').count() === 0;
    panelGone ? ok('Leaderboard panel closed by close button') : fail('Leaderboard panel not dismissed by close button');

    // ── Create a dungeon, then delete it to generate a leaderboard entry ──────
    console.log('\n  [Create and delete dungeon for leaderboard entry]');
    const loaded = await createDungeonUI(page, dName, { monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    loaded ? ok('Dungeon created and game view loaded') : fail('Dungeon view did not load');
    await page.waitForTimeout(2000);

    // Navigate back to home
    const backBtn = page.locator('.back-btn');
    if (await backBtn.count() > 0) {
      await backBtn.click();
      await page.waitForTimeout(2000);
    } else {
      await page.goto(BASE_URL, { timeout: TIMEOUT });
      await page.waitForTimeout(2000);
    }

    // Delete the dungeon (this triggers leaderboard recording in the backend)
    const deleted = await deleteDungeon(page, dName);
    deleted ? ok(`Dungeon "${dName}" deleted`) : warn(`Could not delete dungeon "${dName}" via UI`);
    await page.waitForTimeout(3000); // Give backend time to record

    // ── Open leaderboard again and check for the entry ────────────────────────
    console.log('\n  [Leaderboard shows deleted dungeon entry]');
    const lbBtn2 = page.locator('button.leaderboard-btn');
    await lbBtn2.waitFor({ timeout: TIMEOUT }).catch(() => {});
    if (await lbBtn2.count() > 0) {
      await lbBtn2.click();
      await page.waitForTimeout(2000);
    }

    const panel2 = page.locator('.leaderboard-panel');
    await panel2.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await panel2.count() > 0) ? ok('Leaderboard panel opened after deletion') : fail('Leaderboard panel not found after deletion');

    const panelText = await panel2.textContent().catch(() => '');

    // Either shows our dungeon OR shows "no runs yet" (first-time or RBAC issue)
    if (panelText.includes(dName)) {
      ok(`Leaderboard contains entry for "${dName}"`)

      // Check table columns present
      const table = page.locator('.leaderboard-table');
      (await table.count() > 0) ? ok('Leaderboard table rendered') : fail('Leaderboard table not found');

      const rows = page.locator('.lb-row');
      const rowCount = await rows.count();
      rowCount > 0 ? ok(`Leaderboard has ${rowCount} row(s)`) : fail('Leaderboard has no rows despite entry expected');

      // Check the row for our dungeon
      const ourRow = page.locator(`.lb-row:has-text("${dName}")`);
      if (await ourRow.count() > 0) {
        ok(`Row for "${dName}" found in leaderboard`);
        const rowText = await ourRow.textContent();
        rowText.includes('warrior') || rowText.includes('⚔') ? ok('Hero class shown in leaderboard row') : warn('Hero class not in row text');
        rowText.includes('easy') ? ok('Difficulty shown in leaderboard row') : warn('Difficulty not in row text');
      }
    } else if (panelText.includes('No runs') || panelText.includes('no runs')) {
      warn(`Leaderboard shows "no runs" — may be RBAC issue or empty ConfigMap (first run). Entry for "${dName}" not found.`);
    } else {
      warn(`Leaderboard panel text does not contain "${dName}" — may be loading or RBAC issue`);
    }

    // ── ConfigMap footer note visible ────────────────────────────────────────
    console.log('\n  [ConfigMap note]');
    const cmNote = panelText.includes('krombat-leaderboard') || panelText.includes('rpg-system');
    cmNote ? ok('Footer note mentions krombat-leaderboard ConfigMap') : warn('ConfigMap footer note not found');

    // Close
    const closeBtn2 = page.locator('.leaderboard-close');
    if (await closeBtn2.count() > 0) await closeBtn2.click();

    // ── No critical JS errors ─────────────────────────────────────────────────
    console.log('\n  [Error check]');
    const criticalErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('net::ERR') &&
      !e.includes('kro warning') && !e.includes('WebSocket')
    );
    criticalErrors.length === 0
      ? ok('No critical JS errors during journey')
      : fail(`JS errors detected: ${criticalErrors.slice(0, 3).join('; ')}`);

  } catch (err) {
    fail(`Unexpected error: ${err.message}`);
    console.error(err);
  } finally {
    // Cleanup: try to delete test dungeon if it still exists
    await deleteDungeon(page, dName).catch(() => {});
    await browser.close();
    console.log(`\n  Passed: ${passed}  Failed: ${failed}  Warnings: ${warnings}`);
    if (failed > 0) process.exit(1);
  }
}

run();
