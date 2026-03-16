// Journey 20: Leaderboard
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests: Leaderboard button visible on dungeon list; panel opens; shows correct columns;
//        after deleting a dungeon, its record appears in the leaderboard.
const { chromium } = require('playwright');
const { createDungeonUI, deleteDungeon , testLogin} = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 20000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function openLeaderboardViaHamburger(page) {
  const hamBtn = page.locator('button.hamburger-btn[aria-label="Menu"]');
  await hamBtn.waitFor({ timeout: TIMEOUT }).catch(() => {});
  if (await hamBtn.count() === 0) return false;
  await hamBtn.click();
  await page.waitForTimeout(300);
  const lbItem = page.locator('button.hamburger-item:has-text("Leaderboard")');
  if (await lbItem.count() === 0) return false;
  await lbItem.click();
  await page.waitForTimeout(1000);
  return (await page.locator('.leaderboard-panel').count()) > 0;
}

async function run() {
  console.log('Journey 20: Leaderboard\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j20-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('429') && !msg.text().includes('504') && !msg.text().includes('net::ERR')) consoleErrors.push(msg.text()); });

  try {
    await testLogin(page, BASE_URL);

    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // Dismiss onboarding overlay if present — it intercepts pointer events in fresh browser sessions
    const skipBtn = page.locator('button.kro-onboard-skip');
    if (await skipBtn.count() > 0) {
      await skipBtn.click();
      await page.waitForTimeout(400);
    }

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

    // ── Create a dungeon, then delete it — victories-only leaderboard should NOT show it ──
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

    // Accept the browser confirm() dialog that appears on deletion
    page.once('dialog', d => d.accept());

    // Delete the dungeon (abandoned outcome — should NOT appear in leaderboard)
    const deleted = await deleteDungeon(page, dName);
    deleted ? ok(`Dungeon "${dName}" deleted`) : fail(`Could not delete dungeon "${dName}" via UI`);
    await page.waitForTimeout(4000); // Give backend time to record

    // ── Open leaderboard again — abandoned dungeon must NOT be listed ──────────
    console.log('\n  [Leaderboard shows deleted dungeon entry]');
    const panelOpened = await openLeaderboardViaHamburger(page);
    panelOpened ? ok('Leaderboard panel opened via hamburger after deletion') : fail('Leaderboard panel not found after deletion');

    const panel2 = page.locator('.leaderboard-panel');
    const panelText = await panel2.textContent().catch(() => '');

    // Leaderboard is victories-only — a deleted/abandoned dungeon must NOT appear
    if (!panelText.includes(dName)) {
      ok(`Leaderboard correctly excludes abandoned dungeon "${dName}" (victories-only filter)`);
    } else {
      fail(`Leaderboard shows abandoned dungeon "${dName}" — victories-only filter is broken`);
    }

    // Panel still renders (empty state or real entries are both fine)
    const panelStillRendered = (await panel2.count()) > 0;
    panelStillRendered ? ok('Leaderboard panel renders without crash (empty state OK)') : fail('Leaderboard panel disappeared unexpectedly');

    // Difficulty filter buttons should always be present regardless of entries
    console.log('\n  [Difficulty filter]');
    const filterBtns = page.locator('.lb-filter-btn');
    const filterCount = await filterBtns.count();
    filterCount === 4 ? ok('Difficulty filter has 4 buttons (All, easy, normal, hard)') : fail(`Expected 4 filter buttons, got ${filterCount}`);

    // "All" should be active by default
    const allBtn = page.locator('.lb-filter-btn.lb-filter-active');
    const activeText = await allBtn.first().textContent().catch(() => '');
    activeText.toLowerCase().includes('all') ? ok('"All" filter active by default') : warn(`Active filter is "${activeText}", expected "All"`);

    // Filter buttons are clickable without crash
    const easyBtn = page.locator('.lb-filter-btn', { hasText: 'easy' });
    if (await easyBtn.count() > 0) {
      await easyBtn.click();
      await page.waitForTimeout(300);
      ok('Easy filter applied without error');

      const hardBtn = page.locator('.lb-filter-btn', { hasText: 'hard' });
      if (await hardBtn.count() > 0) {
        await hardBtn.click();
        await page.waitForTimeout(300);
        ok('Hard filter applied without error');
      }

      // Reset to All
      const allBtnReset = page.locator('.lb-filter-btn', { hasText: 'All' });
      if (await allBtnReset.count() > 0) await allBtnReset.click();
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
    page.once('dialog', d => d.accept());
    await deleteDungeon(page, dName).catch(() => {});
    await browser.close();
    console.log(`\n  Passed: ${passed}  Failed: ${failed}  Warnings: ${warnings}`);
    if (failed > 0) process.exit(1);
  }
}

run();
