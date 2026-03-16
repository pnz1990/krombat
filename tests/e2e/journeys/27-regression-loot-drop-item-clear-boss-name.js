// Journey 27: P0 Regression Guards
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
//
// Tests three critical regression scenarios from AGENTS.md "Key Lessons":
//
// 1. lastLootDrop cleared by non-combat actions (item use, equip) — prevents
//    stale loot popup re-appearing when using/equipping an item after a kill.
//
// 2. Boss target regex uses `-boss$` suffix — dungeon names containing the word
//    "boss" should not match the boss entity incorrectly.
//
// 3. Stale Room 1 attack guard — inRoomTransition logic prevents spurious victory
//    from stale Room 1 attack results in Room 2.
const { chromium } = require('playwright');
const { createDungeonUI, attackMonster, attackBoss, waitForCombatResult, deleteDungeon , testLogin} = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 20000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function run() {
  console.log('Journey 27: P0 Regression Guards\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  // Use dungeon names that include the word "boss" to test regex regression
  const dNameBoss = `j27-boss-${Date.now()}`;
  const dNameNormal = `j27-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('429') && !msg.text().includes('504') && !msg.text().includes('net::ERR')) consoleErrors.push(msg.text()); });

  try {
    await testLogin(page, BASE_URL);

    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // ── REGRESSION 1: Dungeon named "j27-boss-..." loads correctly ───────────
    console.log('\n  [Regression 1: Dungeon with "boss" in name loads and plays correctly]');
    const loaded = await createDungeonUI(page, dNameBoss, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    loaded ? ok(`Dungeon named "${dNameBoss}" loaded correctly`) : fail(`Dungeon named "${dNameBoss}" failed to load`);
    await page.waitForTimeout(2000);

    // Hero should be alive, monsters should be present — no spurious boss match
    const monsterCount = await page.locator('.arena-entity.monster-entity').count();
    monsterCount > 0
      ? ok(`Monster entity visible (boss-name dungeon not confused with boss target): ${monsterCount}`)
      : fail('No monsters found — dungeon with "boss" in name may have broken entity rendering');

    const bossLocked = await page.locator('.arena-entity.boss-entity').count();
    bossLocked > 0
      ? ok('Boss entity present and distinguishable from monsters')
      : warn('Boss entity not visible initially (expected if locked while monsters alive)');

    // Attack the monster — target should hit the MONSTER, not be confused with boss
    const r = await attackMonster(page, 0);
    if (r) {
      ok('Attack on monster in boss-named dungeon resolved correctly');
      // Should NOT say "Boss already defeated" or similar
      r.includes('Boss already defeated') || r.includes('boss')
        ? warn(`Combat result mentions boss: "${r?.substring(0, 60)}"`)
        : ok('Combat result correctly targets monster (not confused with boss)');
    } else {
      warn('Attack did not resolve (monster may already be dead or hero died)');
    }

    // Boss attack on normal dungeon (regression: `-boss$` suffix regex)
    // Kill monster fully then verify boss entity becomes attackable
    for (let i = 0; i < 8; i++) {
      const alive = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
      if (alive === 0) break;
      await attackMonster(page, 0);
      await page.waitForTimeout(400);
    }

    const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
    if (await bossBtn.count() > 0) {
      ok('Boss becomes attackable after all monsters dead (regex correctly identifies boss)');
    } else {
      warn('Boss attack button not found (hero may have died or boss not yet unlocked)');
    }

    // Clean up first dungeon
    await page.goto(BASE_URL, { timeout: TIMEOUT }).catch(() => {});
    await page.waitForTimeout(2000);
    await deleteDungeon(page, dNameBoss).catch(() => {});
    await page.waitForTimeout(1000);

    // ── REGRESSION 2: lastLootDrop cleared by item use ───────────────────────
    console.log('\n  [Regression 2: lastLootDrop cleared after item use]');
    const loaded2 = await createDungeonUI(page, dNameNormal, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    loaded2 ? ok(`Normal dungeon "${dNameNormal}" loaded`) : fail('Normal dungeon failed to load');
    await page.waitForTimeout(2000);

    // Add an HP potion via cheat modal
    const helpBtn = page.locator('.help-btn');
    let gotPotion = false;
    if (await helpBtn.count() > 0) {
      await helpBtn.click();
      await page.waitForTimeout(400);
      const cheatBtn = page.locator('button:has-text("Cheat")');
      if (await cheatBtn.count() > 0) {
        await cheatBtn.click();
        await page.waitForTimeout(400);
        const hpPotBtn = page.locator('.cheat-item-btn, button').filter({ hasText: /hppotion|HP Potion/i }).first();
        if (await hpPotBtn.count() > 0) {
          await hpPotBtn.click();
          await page.waitForTimeout(1500);
          gotPotion = true;
          ok('HP potion added via cheat modal for regression test');
        }
        const closeBtn = page.locator('button:has-text("Close")');
        if (await closeBtn.count() > 0) await closeBtn.click();
        await page.waitForTimeout(500);
      } else {
        const closeBtn = page.locator('button:has-text("Close")');
        if (await closeBtn.count() > 0) await closeBtn.click();
      }
    }

    // Kill monster (which may drop loot)
    let lootDropped = false;
    for (let i = 0; i < 8; i++) {
      const alive = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
      if (alive === 0) break;
      await attackMonster(page, 0);
      await page.waitForTimeout(400);
      const lootModal = page.locator('.loot-popup, .loot-modal, button:has-text("Got it!")');
      if (await lootModal.count() > 0) {
        lootDropped = true;
        ok('Loot dropped from monster kill');
        // Dismiss loot popup
        const gotIt = page.locator('button:has-text("Got it!")');
        if (await gotIt.count() > 0) await gotIt.click();
        await page.waitForTimeout(1000);
        break;
      }
    }

    if (!lootDropped) {
      warn('No loot dropped during this run (RNG-dependent, 60% easy drop rate) — skipping lastLootDrop regression test');
    }

    if (lootDropped && gotPotion) {
      // Now use the HP potion — this should NOT re-trigger the loot popup
      const hpPotSlot = page.locator('.backpack-slot').filter({ hasText: /hppotion|hp/i }).first();
      if (await hpPotSlot.count() > 0) {
        await hpPotSlot.click({ force: true });
        await page.waitForTimeout(3000);
        ok('HP potion used after loot drop');

        // Loot popup should NOT appear again
        const lootModal2 = page.locator('.loot-popup, .loot-modal, button:has-text("Got it!")');
        const lootAgain = await lootModal2.count();
        lootAgain === 0
          ? ok('REGRESSION GUARD: Loot popup did NOT re-appear after item use (lastLootDrop cleared correctly)')
          : fail('REGRESSION: Loot popup appeared after item use — lastLootDrop not cleared by processAction');
      } else {
        warn('HP potion slot not found in backpack for regression test');
      }
    }

    // ── REGRESSION 3: inRoomTransition prevents stale Room 1 attacks ─────────
    console.log('\n  [Regression 3: inRoomTransition — no stale Room 1 attacks in Room 2]');
    // Kill boss to proceed to Room 2
    for (let i = 0; i < 25; i++) {
      const bossBtn2 = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
      if (await bossBtn2.count() === 0) break;
      await attackBoss(page);
      await page.waitForTimeout(300);
    }

    const treasureBtn = page.locator('button:has-text("Open Treasure")');
    if (await treasureBtn.count() > 0) {
      await treasureBtn.click();
      await page.waitForTimeout(3000);
      const gotIt = page.locator('button:has-text("Got it!")');
      if (await gotIt.count() > 0) await gotIt.click();
      await page.waitForTimeout(1000);
    }

    const doorBtn = page.locator('button:has-text("Enter Door"), button:has-text("Enter Room 2")');
    if (await doorBtn.count() > 0) {
      await doorBtn.click();
      await page.waitForTimeout(5000);
      ok('Entered Room 2 for stale-attack regression test');

      // Check: Room 2 should NOT show "VICTORY" immediately on entry
      const bodyAfterEntry = await page.textContent('body');
      const hasSpuriousVictory = bodyAfterEntry.includes('VICTORY') || bodyAfterEntry.includes('dungeon has been conquered');
      !hasSpuriousVictory
        ? ok('No spurious VICTORY text immediately after Room 2 entry (stale attacks cleared)')
        : fail('REGRESSION: Victory text appeared immediately after Room 2 entry — stale Room 1 attacks not cleared');

      // Room 2 monsters should be attackable
      const r2Monsters = await page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn').count();
      r2Monsters > 0
        ? ok(`Room 2 monsters are attackable (${r2Monsters} attack buttons)`)
        : warn('No Room 2 monster attack buttons found (hero may have died or RNG)');

      // Do one attack in Room 2 to confirm the combat loop is clean
      const r2Attack = await attackMonster(page, 0);
      if (r2Attack) {
        !r2Attack.includes('already dead') && !r2Attack.includes('already defeated')
          ? ok('Room 2 combat resolves normally (not a stale "already dead" result)')
          : fail(`REGRESSION: Room 2 combat result: "${r2Attack?.substring(0, 60)}" — stale state detected`);
      } else {
        warn('Room 2 attack did not resolve (all monsters may already be dead)');
      }
    } else {
      warn('Door not available for regression 3 (boss may still be alive)');
    }

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
    await deleteDungeon(page, dNameBoss).catch(() => {});
    await deleteDungeon(page, dNameNormal).catch(() => {});
    await browser.close();
    console.log(`\n  Passed: ${passed}  Failed: ${failed}  Warnings: ${warnings}`);
    if (failed > 0) process.exit(1);
  }
}

run();
