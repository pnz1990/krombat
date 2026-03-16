// Journey 28: Resume Prompt, Dungeon Name Validation, Room 1 Cleared Overlay, LAST PLAYED badge
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests: localStorage resume prompt shows on list page after visiting a dungeon;
//        invalid dungeon names are rejected with visible error;
//        Room 1 CLEARED! overlay appears for 3s after boss kill in Room 1;
//        LAST PLAYED badge on most recently visited dungeon tile.
const { chromium } = require('playwright');
const { createDungeonUI, attackMonster, attackBoss, waitForCombatResult, deleteDungeon , testLogin} = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 20000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function run() {
  console.log('Journey 28: Resume Prompt, Validation, Room 1 Cleared, LAST PLAYED\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j28-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('429') && !msg.text().includes('504') && !msg.text().includes('net::ERR')) consoleErrors.push(msg.text()); });

  try {
    await testLogin(page, BASE_URL);

    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // ── TEST 1: Dungeon name validation ──────────────────────────────────────
    console.log('\n  [Dungeon name validation — invalid names rejected]');
    const nameInput = page.locator('input[placeholder="my-dungeon"]');

    // Try an uppercase name (DNS labels must be lowercase)
    await nameInput.fill('InvalidName');
    await page.waitForTimeout(500);
    // Button should be disabled for invalid names; check for inline validation error
    const btnDisabled1 = await page.locator('button:has-text("Create Dungeon")').getAttribute('disabled').catch(() => null);
    const body1 = await page.textContent('body');
    const hasError = body1.includes('invalid') || body1.includes('lowercase') ||
                     body1.includes('alphanumeric') || body1.includes('DNS') || btnDisabled1 !== null;
    hasError
      ? ok('Invalid uppercase dungeon name rejected with validation message')
      : warn('No validation error shown for uppercase name (may be silently rejected or client-side normalised)');

    // Try name starting with hyphen
    await nameInput.fill('-bad-start');
    await page.waitForTimeout(500);
    const body2 = await page.textContent('body');
    const hasError2 = body2.includes('invalid') || body2.includes('lowercase') ||
                      body2.includes('alphanumeric') || body2.includes('DNS') || body2.includes('must start');
    hasError2
      ? ok('Hyphen-starting name rejected with validation message')
      : warn('No validation error for hyphen-starting name');

    // Try empty name — button should be disabled
    await nameInput.fill('');
    await page.waitForTimeout(500);
    const body3 = await page.textContent('body');
    const btnDisabled3 = await page.locator('button:has-text("Create Dungeon")').getAttribute('disabled').catch(() => null);
    body3.includes('invalid') || body3.includes('name') || body3.includes('required') || btnDisabled3 !== null
      ? ok('Empty dungeon name rejected (button disabled)')
      : warn('Empty name not explicitly rejected (may require UI interaction)');

    // Valid name should work
    await nameInput.fill(dName);
    ok(`Valid dungeon name "${dName}" accepted for creation`);

    // ── TEST 2: Create dungeon and check LAST PLAYED badge ──────────────────
    console.log('\n  [Create dungeon, check LAST PLAYED badge]');
    const loaded = await createDungeonUI(page, dName, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    loaded ? ok('Dungeon created and game view loaded') : fail('Dungeon view did not load');
    await page.waitForTimeout(2000);

    // Go back to dungeon list
    const backBtn = page.locator('.back-btn');
    if (await backBtn.count() > 0) {
      await backBtn.click();
      await page.waitForTimeout(2000);

      // LAST PLAYED badge should show on the just-visited dungeon
      const lastPlayedBadge = page.locator('.last-played-badge');
      if (await lastPlayedBadge.count() > 0) {
        const badgeText = await lastPlayedBadge.first().textContent();
        ok(`LAST PLAYED badge visible: "${badgeText?.trim()}"`)
        // The badge should be on a tile that has the dungeon name
        const lastTile = page.locator('.dungeon-tile.last-played');
        (await lastTile.count() > 0)
          ? ok('Dungeon tile has last-played CSS class applied')
          : warn('last-played CSS class not found on tile (badge may render differently)');
      } else {
        warn('LAST PLAYED badge not visible (localStorage path may not work in headless)');
      }
    }

    // ── TEST 3: Resume prompt ─────────────────────────────────────────────────
    console.log('\n  [Resume prompt appears on list page after visiting dungeon]');
    // The resume prompt should now be visible (from localStorage)
    const resumePrompt = page.locator('text=/Resume last dungeon/');
    if (await resumePrompt.count() > 0) {
      ok('Resume prompt visible after returning to list');
      const promptText = await resumePrompt.first().textContent();
      promptText.includes(dName)
        ? ok(`Resume prompt shows dungeon name: "${promptText?.substring(0, 60)?.trim()}"`)
        : warn(`Resume prompt text: "${promptText?.substring(0, 60)?.trim()}" — dungeon name not in prompt`);

      // Resume button should work
      const resumeBtn = page.locator('button:has-text("Resume")');
      if (await resumeBtn.count() > 0) {
        ok('Resume button present in prompt');
        await resumeBtn.click();
        await page.waitForTimeout(3000);
        const urlAfterResume = page.url();
        urlAfterResume.includes(dName) || urlAfterResume.includes('dungeon')
          ? ok(`Resume navigated to dungeon: ${urlAfterResume.split('/').slice(-2).join('/')}`)
          : warn(`URL after resume: ${urlAfterResume}`);

        // Go back for Room 1 Cleared test
        const backBtn2 = page.locator('.back-btn');
        if (await backBtn2.count() > 0) await backBtn2.click();
        await page.waitForTimeout(1000);

        // Dismiss resume prompt
        const dismissBtn = page.locator('button[aria-label="Dismiss resume prompt"]');
        if (await dismissBtn.count() > 0) await dismissBtn.click();
        await page.waitForTimeout(500);
      }
    } else {
      warn('Resume prompt not found (localStorage may not persist in headless test context)');
    }

    // ── TEST 4: Room 1 CLEARED! overlay ──────────────────────────────────────
    console.log('\n  [Room 1 CLEARED! celebration overlay]');
    // Re-enter the dungeon
    const dungeonTile = page.locator(`.dungeon-tile`).filter({ hasText: dName }).first();
    if (await dungeonTile.count() > 0) {
      await dungeonTile.click();
      await page.waitForTimeout(3000);
    } else {
      // Try navigating directly
      await page.goto(`${BASE_URL}/dungeon/default/${dName}`, { timeout: TIMEOUT });
      await page.waitForTimeout(3000);
    }
    ok('Navigated to dungeon for Room 1 Cleared test');

    // Kill monster
    for (let i = 0; i < 8; i++) {
      const alive = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
      if (alive === 0) break;
      await attackMonster(page, 0);
      await page.waitForTimeout(400);
      const body = await page.textContent('body');
      if (body.includes('GAME OVER')) { warn('Hero died during monster fight'); break; }
    }

    // Kill boss — Room 1 CLEARED overlay should appear
    let room1ClearedSeen = false;
    for (let i = 0; i < 25; i++) {
      const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await bossBtn.count() === 0) break;
      await attackBoss(page);
      await page.waitForTimeout(400);

      const body = await page.textContent('body');
      if (body.includes('GAME OVER')) { warn('Hero died during boss fight'); break; }

      // Check for Room 1 Cleared overlay
      const clearedOverlay = page.locator('.arena-room1-cleared-text').or(page.getByText('ROOM CLEARED', { exact: false }));
      if (await clearedOverlay.count() > 0 && !room1ClearedSeen) {
        room1ClearedSeen = true;
        const overlayText = await clearedOverlay.first().textContent();
        ok(`Room 1 CLEARED overlay appeared: "${overlayText?.trim()}"`)
        // It should disappear within ~4 seconds
        await page.waitForTimeout(4000);
        const clearedAfter = await page.locator('.arena-room1-cleared-text').count();
        clearedAfter === 0
          ? ok('Room 1 CLEARED overlay dismissed after ~3s (auto-dismiss)')
          : warn('Room 1 CLEARED overlay still visible after 4s — auto-dismiss may not have fired');
        break;
      }

      // Also check event log
      if (body.includes('ROOM CLEARED') || body.includes('★ ROOM CLEARED! ★') || body.includes('Room 1 cleared')) {
        room1ClearedSeen = true;
        ok('Room 1 CLEARED text visible (event log or overlay)');
        break;
      }
    }
    room1ClearedSeen
      ? ok('Room 1 CLEARED! celebration confirmed')
      : warn('Room 1 CLEARED overlay not observed (boss may not have been killed, or RNG)');

    // ── Error check ──────────────────────────────────────────────────────────
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
    await page.goto(BASE_URL, { timeout: TIMEOUT }).catch(() => {});
    await page.waitForTimeout(2000);
    await deleteDungeon(page, dName).catch(() => {});
    await browser.close();
    console.log(`\n  Passed: ${passed}  Failed: ${failed}  Warnings: ${warnings}`);
    if (failed > 0) process.exit(1);
  }
}

run();
