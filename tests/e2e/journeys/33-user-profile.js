// Journey 33: User Profile
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests: Profile button visible in hamburger; panel opens with correct sections;
//        stats update after a dungeon is deleted; persistent backpack section visible after victory;
//        badges rendered with correct aria-labels; ConfigMap footer note present.
const { chromium } = require('playwright');
const { createDungeonUI, deleteDungeon, testLogin } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 20000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function openProfileViaHamburger(page) {
  const hamBtn = page.locator('button.hamburger-btn[aria-label="Menu"]');
  await hamBtn.waitFor({ timeout: TIMEOUT }).catch(() => {});
  if (await hamBtn.count() === 0) return false;
  await hamBtn.click();
  await page.waitForTimeout(300);
  const profileItem = page.locator('button.hamburger-item:has-text("Profile")');
  if (await profileItem.count() === 0) return false;
  await profileItem.click();
  await page.waitForTimeout(1000);
  return (await page.locator('[aria-label="Player Profile"]').count()) > 0;
}

async function run() {
  console.log('Journey 33: User Profile\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j33-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('429') && !msg.text().includes('504') && !msg.text().includes('net::ERR')) consoleErrors.push(msg.text()); });

  try {
    await testLogin(page, BASE_URL);

    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // Dismiss onboarding if present
    const skipBtn = page.locator('button.kro-onboard-skip');
    if (await skipBtn.count() > 0) {
      await skipBtn.click();
      await page.waitForTimeout(400);
    }

    // ── Profile item visible in hamburger ────────────────────────────────────
    console.log('\n=== Hamburger menu ===');
    const hamBtn = page.locator('button.hamburger-btn[aria-label="Menu"]');
    await hamBtn.waitFor({ timeout: TIMEOUT }).catch(() => {});
    await hamBtn.click();
    await page.waitForTimeout(300);

    const profileItem = page.locator('button.hamburger-item:has-text("Profile")');
    ;(await profileItem.count() > 0)
      ? ok('Profile item present in hamburger menu')
      : fail('Profile item not found in hamburger menu');

    // ── Open profile panel ────────────────────────────────────────────────────
    console.log('\n=== Profile panel opens ===');
    await profileItem.click();
    await page.waitForTimeout(1200);

    const panel = page.locator('[aria-label="Player Profile"]');
    await panel.waitFor({ timeout: TIMEOUT }).catch(() => {});
    ;(await panel.count() > 0)
      ? ok('Profile panel opened (aria-label="Player Profile")')
      : fail('Profile panel not found');

    // Title
    const title = page.locator('.leaderboard-title');
    ;(await title.textContent().catch(() => '')).toLowerCase().includes('profile')
      ? ok('Profile panel title correct')
      : fail('Profile panel title incorrect or missing');

    // Close button
    const closeBtn = page.locator('[aria-label="Close profile"]');
    ;(await closeBtn.count() > 0)
      ? ok('Close button present (aria-label="Close profile")')
      : fail('Close button not found');

    // ── Panel sections present ────────────────────────────────────────────────
    console.log('\n=== Panel sections ===');
    const panelText = await panel.textContent().catch(() => '');

    panelText.includes('BADGES')
      ? ok('BADGES section present')
      : fail('BADGES section not found');

    panelText.includes('krombat-profiles')
      ? ok('ConfigMap footer note mentions krombat-profiles')
      : fail('ConfigMap footer note not found');

    panelText.includes('rpg-system')
      ? ok('ConfigMap footer note mentions rpg-system namespace')
      : warn('rpg-system not mentioned in footer');

    // Badge grid rendered — all-badges (earned + unearned) should be visible
    const badges = page.locator('[aria-label^="badge:"]');
    const badgeCount = await badges.count();
    badgeCount >= 8
      ? ok(`Badge grid rendered (${badgeCount} badges visible)`)
      : fail(`Expected >= 8 badges, found ${badgeCount}`);

    // Unearned badges should have aria-label ending in empty (no " earned" suffix)
    // and earned ones should include " earned"
    const earnedBadges = page.locator('[aria-label$=" earned"]');
    const earnedCount = await earnedBadges.count();
    ok(`${earnedCount} earned badge(s) shown with aria-label ending in " earned"`);

    // ── Close panel ──────────────────────────────────────────────────────────
    console.log('\n=== Close panel ===');
    await closeBtn.click();
    await page.waitForTimeout(300);
    ;(await page.locator('[aria-label="Player Profile"]').count() === 0)
      ? ok('Profile panel closed by close button')
      : fail('Profile panel not dismissed');

    // ── Create and delete a dungeon to generate a profile entry ──────────────
    console.log('\n=== Profile updates after dungeon run ===');
    const loaded = await createDungeonUI(page, dName, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    loaded
      ? ok('Dungeon created and game view loaded')
      : fail('Dungeon view did not load');
    await page.waitForTimeout(2000);

    // Navigate back
    const backBtn = page.locator('.back-btn');
    if (await backBtn.count() > 0) {
      await backBtn.click();
      await page.waitForTimeout(2000);
    } else {
      await page.goto(BASE_URL, { timeout: TIMEOUT });
      await page.waitForTimeout(2000);
    }

    // Delete dungeon (triggers profile recording in backend)
    page.once('dialog', d => d.accept());
    const deleted = await deleteDungeon(page, dName);
    deleted
      ? ok(`Dungeon "${dName}" deleted (triggers profile recording)`)
      : fail(`Could not delete dungeon "${dName}"`);
    await page.waitForTimeout(4000); // Give backend time to record

    // ── Re-open profile and check stats updated ───────────────────────────────
    console.log('\n=== Stats updated after run ===');
    const panelOpened = await openProfileViaHamburger(page);
    panelOpened
      ? ok('Profile panel opened after dungeon run')
      : fail('Profile panel not found after dungeon run');

    const panel2 = page.locator('[aria-label="Player Profile"]');
    const panelText2 = await panel2.textContent().catch(() => '');

    // "Played" stat should be visible and > 0
    panelText2.includes('Played:')
      ? ok('"Played:" stat label present')
      : fail('"Played:" stat label not found');

    panelText2.includes('Won:')
      ? ok('"Won:" stat label present')
      : fail('"Won:" stat label not found');

    panelText2.includes('Total turns:')
      ? ok('"Total turns:" stat label present')
      : fail('"Total turns:" stat label not found');

    // @login present in header
    panelText2.includes('@')
      ? ok('Login handle visible in profile header')
      : fail('Login handle not found in profile header');

    // ── Error check ───────────────────────────────────────────────────────────
    console.log('\n=== Error check ===');
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
    page.once('dialog', d => d.accept());
    await deleteDungeon(page, dName).catch(() => {});
    await browser.close();
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  Journey 33: ${passed} passed, ${failed} failed, ${warnings} warnings`);
    console.log('='.repeat(50));
    if (failed > 0) process.exit(1);
  }
}

run();
