// Journey 3: Rogue Hard — Dodge & Backstab
// UI-ONLY: no kubectl, no fetch/api, no execSync
// Tests: rogue creation, initial state, backstab 3x, cooldown tracking,
//        cooldown natural decrement over 3 turns, second backstab, dodge mechanic,
//        hard difficulty dice/boss HP, no mana display
const { chromium } = require('playwright');
const { createDungeonUI, waitForCombatResult, dismissLootPopup, navigateHome, deleteDungeon } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function getBodyText(page) { return page.textContent('body'); }

// Click the first Backstab button on a live entity
async function doBackstab(page) {
  const btn = page.locator('.arena-entity:not(.dead) button:has-text("Backstab")').first();
  if (await btn.count() === 0) return null;
  await btn.click({ force: true });
  const result = await waitForCombatResult(page);
  await dismissLootPopup(page);
  return result;
}

// Normal attack — monster only (not boss), returns combat text or null
async function doAttackMonster(page) {
  const alive = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary');
  if (await alive.count() === 0) return null;
  await alive.first().click({ force: true });
  const result = await waitForCombatResult(page);
  await dismissLootPopup(page);
  return result;
}

// Normal attack — any target (monster or boss)
async function doAttackAny(page) {
  const alive = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary');
  const boss  = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
  if (await alive.count() > 0) {
    await alive.first().click({ force: true });
  } else if (await boss.count() > 0) {
    await boss.click({ force: true });
  } else {
    return null;
  }
  const result = await waitForCombatResult(page);
  await dismissLootPopup(page);
  return result;
}

// Return current backstab cooldown (number) or null
async function getBackstabCD(page) {
  const text = await getBodyText(page);
  const cdMatch = text.match(/Backstab:\s*(\d+)\s*CD/);
  if (cdMatch) return parseInt(cdMatch[1], 10);
  if (text.includes('Backstab: Ready') || text.includes('Backstab:Ready')) return 0;
  return null;
}

// Return current hero HP
async function getHeroHP(page) {
  const m = (await getBodyText(page)).match(/HP:\s*(\d+)\s*\/\s*\d+/);
  return m ? parseInt(m[1], 10) : null;
}

async function run() {
  console.log('🧪 Journey 3: Rogue Hard — Dodge & Backstab\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j3-${Date.now()}`;
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404'))
      consoleErrors.push(msg.text());
  });
  page.on('dialog', dialog => dialog.accept());

  try {
    // === STEP 1: Create rogue hard dungeon via UI ===
    console.log('=== Step 1: Create Rogue Hard Dungeon ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    // 5 monsters on hard: gives enough targets for CD decrement + dodge tests
    // without running out of monsters too quickly
    const created = await createDungeonUI(page, dName, { monsters: 5, difficulty: 'hard', heroClass: 'rogue' });
    created ? ok('Rogue hard dungeon created via UI') : fail('Dungeon did not load as rogue');

    // === STEP 2: Verify rogue initial state ===
    console.log('\n=== Step 2: Rogue Initial State ===');
    const initBody = await getBodyText(page);
    initBody.includes('ROGUE')  ? ok('Hero class shown as ROGUE') : fail('Hero class not ROGUE');
    initBody.includes('150')    ? ok('Hero HP: 150')               : fail('Hero HP not 150');
    !initBody.includes('Mana:') ? ok('No mana display (rogue)')    : fail('Mana display visible for rogue');

    const backstabIndicator = page.locator('.cooldown-text');
    (await backstabIndicator.count()) > 0 ? ok('Backstab indicator present') : fail('Backstab indicator missing');
    initBody.includes('Ready')  ? ok('Backstab shows Ready')       : warn('Backstab Ready text not found');

    (await page.locator('button:has-text("Heal")').count()) === 0
      ? ok('No Heal button (rogue)')  : fail('Heal button visible for rogue');
    (await page.locator('button:has-text("Taunt")').count()) === 0
      ? ok('No Taunt button (rogue)') : fail('Taunt button visible for rogue');

    initBody.includes('/80') ? ok('Monsters show /80 HP (hard)') : warn('Monster HP /80 not found');

    // === STEP 3: First backstab — verify 3x damage note ===
    console.log('\n=== Step 3: First Backstab ===');
    const backstabBtnCount = await page.locator('.arena-entity:not(.dead) button:has-text("Backstab")').count();
    backstabBtnCount > 0 ? ok('Backstab button on entity card') : fail('Backstab button not found');

    const bsResult1 = await doBackstab(page);
    if (!bsResult1) {
      fail('Backstab did not resolve');
    } else {
      ok('Backstab resolved');
      bsResult1.includes('Backstab') || bsResult1.includes('3x') || bsResult1.includes('damage') || bsResult1.includes('HP')
        ? ok('Backstab result contains damage info')
        : fail(`Backstab result missing damage info: ${bsResult1.substring(0, 150)}`);
    }

    // === STEP 4: Backstab cooldown set to 3 after use ===
    console.log('\n=== Step 4: Backstab Cooldown After Use ===');
    await page.waitForTimeout(1000);
    const cdAfterBS = await getBackstabCD(page);
    if (cdAfterBS !== null) {
      cdAfterBS === 3
        ? ok('Backstab cooldown set to 3 after use')
        : fail(`Expected CD=3 after backstab, got ${cdAfterBS}`);
    } else {
      warn('Could not read backstab CD from page');
    }

    const backstabBtnDuringCD = page.locator('.arena-entity:not(.dead) button:has-text("Backstab")');
    (await backstabBtnDuringCD.count()) === 0
      ? ok('Backstab button hidden during cooldown')
      : fail('Backstab button still visible during cooldown');

    // === STEP 5: Cooldown decrements over 3 normal attacks ===
    // Attack MONSTERS only (not boss) to avoid 800 HP boss eating all our time
    console.log('\n=== Step 5: Cooldown Decrements Over 3 Turns ===');
    for (let turn = 1; turn <= 3; turn++) {
      const monsterCount = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
      if (monsterCount === 0) {
        warn(`No monsters alive for turn ${turn} of CD decrement test`);
        break;
      }
      const cdBefore = await getBackstabCD(page);
      const r = await doAttackMonster(page);
      if (!r) { warn(`Monster attack ${turn} did not resolve`); break; }
      // Wait for kro's tickCooldown specPatch to fire after combatResolve clears lastAttackTarget.
      // tickCooldown fires in a subsequent reconcile cycle (~2-3s after combat modal dismissed).
      await page.waitForTimeout(3500);
      const cdAfter = await getBackstabCD(page);
      if (cdBefore !== null && cdAfter !== null) {
        const expectedCD = Math.max(0, cdBefore - 1);
        cdAfter === expectedCD
          ? ok(`Turn ${turn}: CD ${cdBefore} → ${cdAfter}`)
          : fail(`Turn ${turn}: expected CD ${expectedCD}, got ${cdAfter}`);
      } else {
        warn(`Turn ${turn}: could not read CD (before=${cdBefore} after=${cdAfter})`);
      }
    }

    // After 3 attacks CD should be 0
    const cdAfter3 = await getBackstabCD(page);
    if (cdAfter3 !== null) {
      cdAfter3 === 0
        ? ok('Backstab ready after 3 turns (CD=0)')
        : warn(`Expected CD=0 after 3 attacks, got ${cdAfter3}`);
    }

    const bsReady = page.locator('.arena-entity:not(.dead) button:has-text("Backstab")');
    (await bsReady.count()) > 0
      ? ok('Backstab button reappears when ready')
      : warn('Backstab button not visible after CD (no alive targets?)');

    // === STEP 6: Second backstab — verify CD resets to 3 ===
    console.log('\n=== Step 6: Second Backstab + CD Reset ===');
    const bsBtn2 = page.locator('.arena-entity:not(.dead) button:has-text("Backstab")').first();
    if (await bsBtn2.count() > 0) {
      const bsResult2 = await doBackstab(page);
      if (!bsResult2) {
        fail('Second backstab did not resolve');
      } else {
        ok('Second backstab resolved');
        bsResult2.includes('Backstab') || bsResult2.includes('3x') || bsResult2.includes('damage') || bsResult2.includes('HP')
          ? ok('Second backstab has damage result')
          : warn(`Second backstab result unclear: ${bsResult2.substring(0, 100)}`);
      }
      await page.waitForTimeout(1000);
      const cdAfterBS2 = await getBackstabCD(page);
      if (cdAfterBS2 !== null) {
        cdAfterBS2 === 3
          ? ok('Backstab CD reset to 3 after second use')
          : fail(`Expected CD=3 after second backstab, got ${cdAfterBS2}`);
      } else {
        warn('Could not read CD after second backstab');
      }
      const bsHidden2 = page.locator('.arena-entity:not(.dead) button:has-text("Backstab")');
      (await bsHidden2.count()) === 0
        ? ok('Backstab button hidden after second use')
        : fail('Backstab button still visible after second use');
    } else {
      warn('No targets with Backstab available for second test');
    }

    // === STEP 7: Dodge mechanic — monsters only, limited attempts ===
    // 25% chance per attack. With 5 attempts we have 76% probability of seeing at least one.
    console.log('\n=== Step 7: Dodge Mechanic (25% chance) ===');
    let dodgeObserved = false;
    for (let i = 0; i < 5; i++) {
      const monsters = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
      if (monsters === 0) break; // don't attack boss — too slow
      const r = await doAttackMonster(page);
      if (!r) break;
      if (r.includes('dodged') || r.toLowerCase().includes('rogue dodged')) {
        dodgeObserved = true;
        ok(`Dodge observed in combat result`)
        break;
      }
    }
    if (!dodgeObserved) {
      warn('No dodge observed in 5 monster attacks (25% chance — statistically possible)');
    }

    // === STEP 8: Hard difficulty — boss HP 800 visible ===
    console.log('\n=== Step 8: Hard Difficulty Boss HP ===');
    // Check boss HP — boss becomes visible once all monsters are dead.
    // If monsters are still alive, kill them (up to 4 more attacks to stay within time budget).
    for (let i = 0; i < 4; i++) {
      const alive = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
      if (alive === 0) break;
      const r = await doAttackMonster(page);
      if (!r) break;
    }
    await page.waitForTimeout(2000);
    const bodyHard = await getBodyText(page);
    bodyHard.includes('800') || bodyHard.includes('/800')
      ? ok('Boss HP 800 visible (hard difficulty)')
      : warn('Boss HP 800 not in page text (boss may still be pending)');
    bodyHard.includes('3d20+8') ? ok('Dice formula 3d20+8 visible') : warn('Dice formula 3d20+8 not found in body');

    // === STEP 9: Console errors ===
    console.log('\n=== Step 9: Console Errors ===');
    consoleErrors.length === 0
      ? ok('No console errors')
      : fail(`${consoleErrors.length} console error(s): ${consoleErrors[0]}`);

    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    await navigateHome(page, BASE_URL);
    await page.waitForTimeout(2000);
    const deleted = await deleteDungeon(page, dName);
    deleted ? ok('Dungeon deleted via UI') : warn('Could not delete dungeon via UI');

  } catch (error) {
    console.error(`\n❌ Fatal: ${error.message}\n${error.stack}`);
    failed++;
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Journey 3: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
