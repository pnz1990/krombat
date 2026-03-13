// Journey 11: Room 2 Full Victory — Complete both rooms end-to-end
// UI-ONLY: no kubectl, no fetch/api, no execSync
// Covers: Room 1 monsters → dragon boss → treasure/door sequence → Room 2 monsters → bat boss → final victory
const { chromium } = require('playwright');
const {
  createDungeonUI, attackMonster, attackBoss, waitForCombatResult,
  dismissLootPopup, aliveMonsterCount, deadMonsterCount,
  getBodyText, navigateHome, deleteDungeon,
} = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

// Dismiss any blocking modal (combat Continue or loot Got it!)
async function clearModals(page) {
  for (let i = 0; i < 5; i++) {
    const cb = page.locator('button:has-text("Continue")');
    if (await cb.count() > 0) { await cb.click().catch(() => {}); await page.waitForTimeout(500); continue; }
    const gi = page.locator('button:has-text("Got it!")');
    if (await gi.count() > 0) { await gi.click().catch(() => {}); await page.waitForTimeout(500); continue; }
    break;
  }
}

async function run() {
  console.log('🧪 Journey 11: Room 2 Full Victory — Complete both rooms end-to-end\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j11-${Date.now()}`;
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404'))
      consoleErrors.push(msg.text());
  });

  try {
    // === STEP 1: Create dungeon ===
    // 1 monster, easy — minimises RNG variance so the hero reliably survives two rooms.
    console.log('=== Step 1: Create Dungeon ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    const created = await createDungeonUI(page, dName, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    created ? ok('Dungeon created and loaded') : fail('Dungeon did not load');

    // === STEP 2: Initial state ===
    console.log('\n=== Step 2: Initial State ===');
    let body = await getBodyText(page);
    body.includes('200') ? ok('Warrior HP: 200') : fail('Hero HP not 200');
    body.includes('WARRIOR') ? ok('Hero class: WARRIOR') : fail('Hero class not WARRIOR');

    let alive = await aliveMonsterCount(page);
    alive === 1 ? ok('1 alive monster in Room 1') : fail(`Expected 1 alive monster, got ${alive}`);

    const bossAtk = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
    (await bossAtk.count()) === 0 ? ok('Boss not attackable yet (pending)') : warn('Boss visible before all monsters dead');

    // === STEP 3: Kill all Room 1 monsters ===
    console.log('\n=== Step 3: Kill Room 1 Monsters ===');
    let atkCount = 0;
    while (await aliveMonsterCount(page) > 0 && atkCount < 30) {
      const result = await attackMonster(page);
      atkCount++;
      if (!result) { fail(`Attack ${atkCount} did not resolve`); break; }
      await dismissLootPopup(page);
      await page.waitForTimeout(1000);
    }
    alive = await aliveMonsterCount(page);
    alive === 0 ? ok(`Room 1 monster killed (${atkCount} attacks)`) : fail(`${alive} monsters still alive`);

    const dead1 = await deadMonsterCount(page);
    dead1 >= 1 ? ok(`Dead monster rendered (count: ${dead1})`) : warn('Dead monster sprite not visible');

    // === STEP 4: Boss becomes attackable ===
    console.log('\n=== Step 4: Room 1 Boss Unlocked ===');
    let bossReady = false;
    for (let i = 0; i < 30; i++) {
      await clearModals(page);
      const btn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await btn.count() > 0) { bossReady = true; break; }
      await page.waitForTimeout(2000);
    }
    bossReady ? ok('Dragon boss is attackable') : fail('Dragon boss did not become attackable');

    // === STEP 5: Kill Room 1 boss (dragon) ===
    console.log('\n=== Step 5: Kill Dragon Boss ===');
    let bossAtks = 0;
    while (bossAtks < 50) {
      await clearModals(page);
      body = await getBodyText(page);
      if (body.includes('VICTORY') || body.includes('Victory')) break;
      if (body.includes('DEFEAT') || body.includes('fallen')) {
        warn('Hero defeated during dragon fight');
        break;
      }

      const btn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await btn.count() === 0) {
        await page.waitForTimeout(2000);
        body = await getBodyText(page);
        if (body.includes('VICTORY') || body.includes('Victory')) break;
        continue;
      }

      await btn.click({ force: true });
      bossAtks++;
      const result = await waitForCombatResult(page);
      if (!result) {
        body = await getBodyText(page);
        if (body.includes('VICTORY') || body.includes('Victory')) break;
        warn(`Dragon attack ${bossAtks} timeout`);
      }
      await dismissLootPopup(page);
      await page.waitForTimeout(1000);
    }

    body = await getBodyText(page);
    (body.includes('VICTORY') || body.includes('Victory'))
      ? ok(`Dragon boss killed (${bossAtks} attacks) — Room 1 Victory shown`)
      : fail('Dragon boss not killed / Victory not shown after Room 1');

    // === STEP 6: Post-boss auto-sequence (treasure + door) ===
    console.log('\n=== Step 6: Post-Boss Auto-Sequence ===');
    await clearModals(page);

    // Wait for the door unlock (Enter button / door entity appears)
    let doorReady = false;
    for (let i = 0; i < 45; i++) {
      await clearModals(page);
      body = await getBodyText(page);
      if (body.includes('Enter')) { doorReady = true; break; }
      await page.waitForTimeout(2000);
    }
    doorReady ? ok('Door unlocked ("Enter" visible)') : fail('Door did not unlock after boss kill');

    // Verify treasure was auto-opened (treasureOpened → spec field drives state)
    body = await getBodyText(page);
    !body.includes('Open Chest') ? ok('Treasure already opened (no "Open Chest" prompt)') : warn('"Open Chest" still visible after boss — may not be auto-opened yet');

     // === STEP 7: Enter Room 2 ===
     console.log('\n=== Step 7: Enter Room 2 ===');
     await clearModals(page);
     // door-entity div has role="button" when doorUnlocked=1; use JS click to reliably trigger React onClick
     const doorClicked = await page.evaluate(() => {
       const door = document.querySelector('[role="button"][aria-label="Enter Room 2"], .arena-entity.door-entity');
       if (!door) return false;
       door.click();
       return true;
     });
     if (!doorClicked) {
       fail('Door entity not found — cannot enter Room 2');
     }

    // Wait for Room 2 to fully load (attack buttons must appear; text may be 'Room: 2' or 'Entering Room 2...')
    let r2Loaded = false;
    for (let i = 0; i < 45; i++) {
      body = await getBodyText(page);
      // Status bar shows "Room: 2" (with colon); loading overlay shows "Entering Room 2..."
      const hasR2 = body.includes('Room 2') || body.includes('Room: 2') || body.includes('room 2');
      const atkButtons = await page.locator('.arena-atk-btn.btn-primary').count();
      if (hasR2 && atkButtons > 0) { r2Loaded = true; break; }
      // After kro resolves, attack buttons appear even if text hasn't updated yet
      if (atkButtons > 0 && i >= 2) { r2Loaded = true; break; }
      await page.waitForTimeout(2000);
    }
    r2Loaded ? ok('Room 2 loaded with attack buttons') : fail('Room 2 did not load (no label or attack buttons)');

    // Check for stale victory banner via CSS class (event log may contain "VICTORY" text from boss kill)
    const victoryBanner = await page.locator('.victory-banner').count();
    victoryBanner === 0 ? ok('No stale victory banner in Room 2') : fail('Stale victory banner showing in Room 2');
    !body.includes('DEFEAT') ? ok('Hero alive entering Room 2') : fail('Hero shows DEFEAT on Room 2 entry');

    // === STEP 8: Verify Room 2 monster count ===
    console.log('\n=== Step 8: Room 2 Initial State ===');
    // Wait for monsters to appear (kro reconciliation may take a moment)
    for (let i = 0; i < 15; i++) {
      alive = await aliveMonsterCount(page);
      if (alive > 0) break;
      await page.waitForTimeout(2000);
    }
    alive = await aliveMonsterCount(page);
    alive > 0 ? ok(`${alive} Room 2 monsters visible and alive`) : fail('No Room 2 monsters appeared');

    // Boss should not yet be attackable (monsters must die first)
    const r2BossEarly = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
    (await r2BossEarly.count()) === 0 ? ok('Room 2 boss not attackable yet (correct — monsters alive)') : warn('Room 2 boss attackable with monsters still alive');

    // === STEP 9: Kill all Room 2 monsters ===
    console.log('\n=== Step 9: Kill Room 2 Monsters ===');
    let r2MonsterAtks = 0;
    while (await aliveMonsterCount(page) > 0 && r2MonsterAtks < 40) {
      await clearModals(page);
      body = await getBodyText(page);
      if (body.includes('DEFEAT') || body.includes('fallen')) {
        warn('Hero defeated while fighting Room 2 monsters');
        break;
      }
      const result = await attackMonster(page);
      r2MonsterAtks++;
      if (!result) {
        body = await getBodyText(page);
        if (body.includes('DEFEAT') || body.includes('fallen')) { warn('Hero defeated mid-attack'); break; }
        await page.waitForTimeout(2000);
        continue;
      }
      await dismissLootPopup(page);
      await page.waitForTimeout(1000);
    }
    alive = await aliveMonsterCount(page);
    alive === 0 ? ok(`All Room 2 monsters killed (${r2MonsterAtks} attacks)`) : fail(`${alive} Room 2 monsters still alive`);

    // === STEP 10: Room 2 boss (bat boss) becomes attackable ===
    console.log('\n=== Step 10: Room 2 Boss Unlocked ===');
    let r2BossReady = false;
    for (let i = 0; i < 30; i++) {
      await clearModals(page);
      const btn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await btn.count() > 0) { r2BossReady = true; break; }
      await page.waitForTimeout(2000);
    }
    r2BossReady ? ok('Room 2 bat boss is attackable') : fail('Room 2 bat boss did not become attackable');

    // === STEP 11: Kill Room 2 boss (bat boss) ===
    console.log('\n=== Step 11: Kill Bat Boss (Room 2) ===');
    let batBossAtks = 0;
    while (batBossAtks < 60) {
      await clearModals(page);
      body = await getBodyText(page);
      if (body.includes('VICTORY') || body.includes('Victory') || body.includes('Dungeon Complete')) break;
      if (body.includes('DEFEAT') || body.includes('fallen')) {
        warn('Hero defeated during bat boss fight');
        break;
      }

      const btn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await btn.count() === 0) {
        await page.waitForTimeout(2000);
        body = await getBodyText(page);
        if (body.includes('VICTORY') || body.includes('Victory') || body.includes('Dungeon Complete')) break;
        batBossAtks++;
        continue;
      }

      await btn.click({ force: true });
      batBossAtks++;
      const result = await waitForCombatResult(page);
      if (!result) {
        body = await getBodyText(page);
        if (body.includes('VICTORY') || body.includes('Victory') || body.includes('Dungeon Complete')) break;
        warn(`Bat boss attack ${batBossAtks} timeout`);
      }
      await dismissLootPopup(page);
      await page.waitForTimeout(1000);
    }

    // === STEP 12: Final victory assertions ===
    console.log('\n=== Step 12: Final Victory State ===');
    body = await getBodyText(page);
    (body.includes('VICTORY') || body.includes('Victory') || body.includes('Dungeon Complete'))
      ? ok(`Dungeon complete — final victory shown (${batBossAtks} bat boss attacks)`)
      : fail(`No final victory after Room 2 boss (${batBossAtks} attacks)`);

    // No attack buttons should be present after full victory
    const finalAtk = await page.locator('.arena-atk-btn.btn-primary').count();
    finalAtk === 0 ? ok('No attack buttons after dungeon complete') : warn(`${finalAtk} attack buttons still visible post-victory`);

    // No stale DEFEAT banner
    !body.includes('DEFEAT') ? ok('No DEFEAT banner at end') : fail('DEFEAT banner shown alongside victory');

    // === STEP 13: Console errors ===
    console.log('\n=== Step 13: Console Errors ===');
    consoleErrors.length === 0
      ? ok('No console errors throughout journey')
      : fail(`${consoleErrors.length} console error(s): ${consoleErrors[0]}`);

  } catch (error) {
    console.error(`\n❌ Fatal: ${error.message}`);
    failed++;
  } finally {
    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    try {
      await navigateHome(page, BASE_URL);
      await page.waitForTimeout(2000);
      await deleteDungeon(page, dName);
      ok('Dungeon deleted via UI');
    } catch (_) {
      warn('Cleanup failed — dungeon may have been auto-deleted or navigation failed');
    }
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Journey 11: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
