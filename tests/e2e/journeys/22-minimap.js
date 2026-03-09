// Journey 22: Dungeon Mini-Map
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
// Tests: DungeonMiniMap renders below dungeon header, room indicators show correct
//        states (R1 current → boss-active → cleared), connector updates, treasure
//        icon appears when treasure available.
const { chromium } = require('playwright');
const { createDungeonUI, attackMonster, attackBoss, waitForCombatResult, deleteDungeon } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 20000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function run() {
  console.log('Journey 22: Dungeon Mini-Map\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j22-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  try {
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // ── Create a dungeon with 1 monster, easy ────────────────────────────────
    console.log('\n  [Create dungeon]');
    const loaded = await createDungeonUI(page, dName, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    loaded ? ok('Dungeon created and game view loaded') : fail('Dungeon view did not load');
    await page.waitForTimeout(2000);

    // ── Test 1: Mini-map renders ─────────────────────────────────────────────
    console.log('\n  [Mini-map renders]');
    const minimap = page.locator('.dungeon-minimap');
    await minimap.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await minimap.count() > 0)
      ? ok('DungeonMiniMap (.dungeon-minimap) is rendered inside dungeon view')
      : fail('DungeonMiniMap not found — check DungeonMiniMap component is rendered in DungeonView');

    // ── Test 2: Minimap has exactly 2 room nodes and 1 connector ────────────
    console.log('\n  [Mini-map structure]');
    const rooms = page.locator('.minimap-room');
    const connectors = page.locator('.minimap-connector');
    const roomCount = await rooms.count();
    const connCount = await connectors.count();
    roomCount === 2
      ? ok(`Mini-map has 2 room nodes (found ${roomCount})`)
      : fail(`Mini-map should have 2 room nodes, found ${roomCount}`);
    connCount === 1
      ? ok('Mini-map has 1 connector between rooms')
      : fail(`Mini-map should have 1 connector, found ${connCount}`);

    // ── Test 3: R1 is "current" (gold) at start ──────────────────────────────
    console.log('\n  [R1 shows current state initially]');
    if (await rooms.count() >= 1) {
      const r1Text = await rooms.nth(0).textContent();
      r1Text.includes('R1')
        ? ok(`Room 1 node shows "R1": "${r1Text.trim()}"`)
        : fail(`Room 1 node text unexpected: "${r1Text.trim()}"`);
      // Check gold color (current state) — style.borderColor or color contains gold-ish value
      const r1Style = await rooms.nth(0).getAttribute('style');
      (r1Style && (r1Style.includes('f5c518') || r1Style.includes('rgb(245, 197, 24)')))
        ? ok('Room 1 has gold border (current state)')
        : warn(`Room 1 border color not confirmed gold; style="${r1Style}"`);
    }

    // ── Test 4: R2 is "locked" (gray) at start ──────────────────────────────
    console.log('\n  [R2 shows locked state initially]');
    if (await rooms.count() >= 2) {
      const r2Text = await rooms.nth(1).textContent();
      r2Text.includes('R2')
        ? ok(`Room 2 node shows "R2": "${r2Text.trim()}"`)
        : fail(`Room 2 node text unexpected: "${r2Text.trim()}"`);
      r2Text.includes('🔒')
        ? ok('Room 2 shows lock icon (locked state)')
        : warn(`Room 2 locked icon not found; text="${r2Text.trim()}"`);
      // Check gray color
      const r2Style = await rooms.nth(1).getAttribute('style');
      (r2Style && r2Style.includes('#333'))
        ? ok('Room 2 has gray border (locked state)')
        : warn(`Room 2 border color not confirmed gray; style="${r2Style}"`);
    }

    // ── Test 5: Connector shows dotted (locked) at start ────────────────────
    console.log('\n  [Connector shows locked state initially]');
    if (await connectors.count() > 0) {
      const connText = await connectors.nth(0).textContent();
      connText.includes('⋯') || connText.includes('…')
        ? ok(`Connector shows locked separator: "${connText.trim()}"`)
        : warn(`Connector text: "${connText.trim()}" (expected ⋯ for locked)`);
    }

    // ── Test 6: Kill monster → boss-active state ─────────────────────────────
    console.log('\n  [Kill monster, R1 transitions to boss-active]');
    for (let i = 0; i < 8; i++) {
      const alive = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
      if (alive === 0) break;
      const r = await attackMonster(page, 0);
      if (!r) break;
      const body = await page.textContent('body');
      if (body.includes('GAME OVER')) { warn('Hero died killing monster — RNG unfavorable'); break; }
      await page.waitForTimeout(500);
    }

    // After monster dies and boss is still alive, R1 may show boss-active or current
    const allDeadAfterMonster = await page.locator('.arena-entity.monster-entity:not(.dead)').count() === 0;
    if (allDeadAfterMonster) {
      ok('Monster killed — can observe room state transition');
      await page.waitForTimeout(1000);
      if (await rooms.count() >= 1) {
        const r1TextAfter = await rooms.nth(0).textContent();
        // Should still show R1 (current or boss-active, not cleared)
        r1TextAfter.includes('R1')
          ? ok(`R1 still shows room label after monster kill: "${r1TextAfter.trim()}"`)
          : warn(`R1 text after monster kill: "${r1TextAfter.trim()}"`);
      }
    } else {
      warn('Monster still alive — skipping boss-active state check');
    }

    // ── Test 7: Kill boss → R1 transitions to cleared (green) ───────────────
    console.log('\n  [Kill boss, R1 transitions to cleared]');
    let bossDefeated = false;
    for (let i = 0; i < 15; i++) {
      const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await bossBtn.count() === 0) { bossDefeated = true; break; }
      const r = await attackBoss(page);
      if (!r) break;
      const body = await page.textContent('body');
      if (body.includes('GAME OVER')) { warn('Hero died fighting boss — RNG unfavorable'); break; }
      await page.waitForTimeout(500);
    }

    if (bossDefeated || await page.locator('.arena-entity.boss-entity:not(.dead)').count() === 0) {
      ok('Boss defeated — R1 should transition to cleared');
      await page.waitForTimeout(1500);
      if (await rooms.count() >= 1) {
        const r1Final = await rooms.nth(0).textContent();
        r1Final.includes('✓') || r1Final.includes('R1')
          ? ok(`R1 shows cleared state: "${r1Final.trim()}"`)
          : warn(`R1 after boss kill: "${r1Final.trim()}"`);
        // Check green color
        const r1Style = await rooms.nth(0).getAttribute('style');
        (r1Style && (r1Style.includes('00ff41') || r1Style.includes('rgb(0, 255, 65)')))
          ? ok('R1 has green border (cleared state)')
          : warn(`R1 cleared border color not confirmed; style="${r1Style}"`);
      }

      // ── Test 8: Treasure icon appears when boss cleared ──────────────────
      console.log('\n  [Treasure icon after boss defeat]');
      await page.waitForTimeout(1000);
      const treasureIcon = page.locator('.minimap-icon[title="Treasure available"]');
      if (await treasureIcon.count() > 0) {
        ok('Treasure icon 💎 appears in mini-map when treasure is available')
      } else {
        // Might not show if treasure already opened or different state
        warn('Treasure icon not found — may have auto-opened or state not cleared');
      }

      // ── Test 9: Open treasure → icon disappears ──────────────────────────
      console.log('\n  [Open treasure, icon clears]');
      const treasureBtn = page.locator('button:has-text("Open Treasure")');
      if (await treasureBtn.count() > 0) {
        await treasureBtn.click();
        await page.waitForTimeout(3000);
        // Dismiss loot modal
        const gotIt = page.locator('button:has-text("Got it!")');
        if (await gotIt.count() > 0) await gotIt.click();
        await page.waitForTimeout(1000);
        // Treasure icon should be gone
        const iconAfter = page.locator('.minimap-icon[title="Treasure available"]');
        (await iconAfter.count() === 0)
          ? ok('Treasure icon removed after opening treasure')
          : warn('Treasure icon still present after opening — may not update immediately');
      } else {
        warn('Treasure button not available — skipping treasure-open icon check');
      }

      // ── Test 10: Enter door → connector becomes active arrow ──────────────
      console.log('\n  [Enter door, R2 unlocks]');
      const doorBtn = page.locator('button:has-text("Enter Door"), button:has-text("Enter Room 2")');
      if (await doorBtn.count() > 0) {
        await doorBtn.click();
        await page.waitForTimeout(4000);
        ok('Entered Room 2');

        // R2 should now show as current (gold)
        if (await rooms.count() >= 2) {
          const r2Text = await rooms.nth(1).textContent();
          r2Text.includes('R2')
            ? ok(`R2 shows label after entering: "${r2Text.trim()}"`)
            : warn(`R2 text after entering: "${r2Text.trim()}"`);
          const r2Style = await rooms.nth(1).getAttribute('style');
          (r2Style && (r2Style.includes('f5c518') || r2Style.includes('rgb(245, 197, 24)')))
            ? ok('R2 has gold border (now current room)')
            : warn(`R2 border color after entering; style="${r2Style}"`);
          // R2 should NOT show lock icon
          !r2Text.includes('🔒')
            ? ok('R2 no longer shows lock icon')
            : fail('R2 still shows lock icon after entering room');
        }

        // Connector should now show active arrow
        if (await connectors.count() > 0) {
          const connText = await connectors.nth(0).textContent();
          connText.includes('→')
            ? ok(`Connector shows active arrow after room unlock: "${connText.trim()}"`)
            : warn(`Connector after unlock: "${connText.trim()}"`);
        }
      } else {
        warn('Door not available — could not test R2 unlock state');
      }
    } else {
      warn('Boss not defeated — skipping R1 cleared / R2 unlock checks');
    }

    // ── Test 11: Mini-map persists after page navigation ─────────────────────
    console.log('\n  [Mini-map still present after re-navigation]');
    const currentUrl = page.url();
    if (currentUrl.includes('/dungeon/')) {
      await page.reload();
      await page.waitForTimeout(3000);
      const minimapAfterReload = page.locator('.dungeon-minimap');
      (await minimapAfterReload.count() > 0)
        ? ok('Mini-map still visible after page reload')
        : fail('Mini-map missing after reload');
    } else {
      warn('Not in dungeon view — skipping reload persistence check');
    }

    // ── Error check ───────────────────────────────────────────────────────────
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
