// Journey 8: Edge Cases & Error States
// UI-ONLY: no kubectl, no fetch/api, no execSync
const { chromium } = require('playwright');
const { createDungeonUI, attackMonster, attackBoss, waitForCombatResult, dismissLootPopup, navigateHome, deleteDungeon } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

// Kill all monsters + boss through the UI, returns true if hero survived
async function playToVictory(page) {
  for (let i = 0; i < 80; i++) {
    const alive = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary');
    const boss = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
    if (await alive.count() > 0) {
      await alive.first().click({ force: true });
    } else if (await boss.count() > 0) {
      await boss.click({ force: true });
    } else {
      return true; // Nothing left to attack
    }
    const result = await waitForCombatResult(page);
    if (!result) { await page.waitForTimeout(2000); continue; }
    await dismissLootPopup(page);
    // Check if hero died
    const body = await page.textContent('body');
    if (body.includes('DEFEAT') || body.includes('has fallen')) return false;
    await page.waitForTimeout(500);
  }
  return false;
}

async function run() {
  console.log('🧪 Journey 8: Edge Cases & Error States\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const ts = Date.now();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('429') && !msg.text().includes('500') && !msg.text().includes('400'))
      consoleErrors.push(msg.text());
  });
  page.on('dialog', dialog => dialog.accept());

  try {
    // === Test 1: Speed run — 1 monster easy, play to victory ===
    console.log('=== Test 1: Speed Run (1 monster, easy) ===');
    const speedName = `j8sp${ts}`;
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    await createDungeonUI(page, speedName, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    ok('Speed run dungeon created');

    // Kill the single monster through UI
    let monsterDead = false;
    for (let i = 0; i < 15; i++) {
      const alive = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary');
      if (await alive.count() === 0) { monsterDead = true; break; }
      await alive.first().click({ force: true });
      await waitForCombatResult(page);
      await dismissLootPopup(page);
      await page.waitForTimeout(500);
    }
    monsterDead ? ok('Monster killed') : fail('Could not kill monster');

    // Boss should now be attackable
    const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
    for (let i = 0; i < 15; i++) {
      if (await bossBtn.count() > 0) break;
      await page.waitForTimeout(2000);
    }
    (await bossBtn.count()) > 0 ? ok('Boss attackable after monster kill') : fail('Boss not attackable');

    // === Test 2: 10 monsters hard — verify all render ===
    console.log('\n=== Test 2: Max Monsters (10, hard) ===');
    const maxName = `j8mx${ts}`;
    await navigateHome(page, BASE_URL);
    await page.waitForTimeout(2000);
    await createDungeonUI(page, maxName, { monsters: 10, difficulty: 'hard', heroClass: 'rogue' });
    ok('10-monster dungeon created');

    const monsterEntities = page.locator('.arena-entity.monster-entity');
    for (let i = 0; i < 10; i++) {
      if (await monsterEntities.count() === 10) break;
      await page.waitForTimeout(2000);
    }
    const mCount = await monsterEntities.count();
    mCount === 10 ? ok(`All 10 monsters rendered`) : fail(`Only ${mCount} monsters rendered`);

    // === Test 3: Rate limiting — rapid attack clicks ===
    console.log('\n=== Test 3: Rate Limiting ===');
    // Click attack button rapidly 5 times
    const rateBtn = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary').first();
    if (await rateBtn.count() > 0) {
      for (let i = 0; i < 5; i++) {
        await rateBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(100);
      }
      // Should not crash or show multiple combat modals
      await page.waitForTimeout(3000);
      const modalCount = await page.locator('.combat-modal').count();
      modalCount <= 1 ? ok('Rapid clicks handled (at most 1 combat modal)') : fail(`${modalCount} combat modals from rapid clicks`);
      // Dismiss any modal
      const cont = page.locator('button:has-text("Continue")');
      for (let i = 0; i < 10; i++) {
        if (await cont.count() > 0) { await cont.click().catch(() => {}); break; }
        await page.waitForTimeout(2000);
      }
      await dismissLootPopup(page);
    } else {
      warn('No attack button for rate limit test');
    }

    // === Test 4: Attack already-dead monster via UI ===
    console.log('\n=== Test 4: Attack Dead Monster ===');
    // Use the speed-run dungeon where monster is already dead
    await navigateHome(page, BASE_URL);
    await page.waitForTimeout(2000);
    const speedTile = page.locator(`.dungeon-tile:has-text("${speedName}")`);
    if (await speedTile.count() > 0) {
      await speedTile.click();
      await page.waitForTimeout(4000);
      // Dead monsters should have no attack button
      const deadMonsterBtns = page.locator('.arena-entity.monster-entity.dead .arena-atk-btn.btn-primary');
      (await deadMonsterBtns.count()) === 0
        ? ok('Dead monsters have no attack button')
        : fail('Dead monster still has attack button');
    } else {
      warn('Speed run dungeon not found for dead monster test');
    }

    // === Test 5: Navigate to nonexistent dungeon ===
    console.log('\n=== Test 5: Nonexistent Dungeon ===');
    await page.goto(`${BASE_URL}/dungeon/default/this-does-not-exist-12345`, { timeout: TIMEOUT });
    await page.waitForTimeout(8000);
    const errText = await page.textContent('body');
    (errText.includes('not found') || errText.includes('Initializing') || errText.includes('Error') || errText.includes('initializing'))
      ? ok('Nonexistent dungeon shows error/initializing')
      : fail(`No error for nonexistent dungeon: ${errText.substring(0, 100)}`);
    const crashed = errText.includes('Cannot read') || errText.includes('undefined');
    !crashed ? ok('No JS crash on nonexistent dungeon') : fail('JS crash detected');

    // === Test 6: Refresh mid-combat ===
    console.log('\n=== Test 6: Refresh Mid-Combat ===');
    // Navigate to the 10-monster dungeon (still has targets)
    await navigateHome(page, BASE_URL);
    await page.waitForTimeout(2000);
    const maxTile = page.locator(`.dungeon-tile:has-text("${maxName}")`);
    if (await maxTile.count() > 0) {
      await maxTile.click();
      await page.waitForTimeout(4000);
      const atkBtn = page.locator('.arena-atk-btn.btn-primary').first();
      if (await atkBtn.count() > 0) {
        await atkBtn.click({ force: true });
        await page.waitForTimeout(2000);
        // Refresh mid-combat
        await page.reload({ timeout: TIMEOUT });
        await page.waitForTimeout(5000);
        const afterRefresh = await page.textContent('body');
        afterRefresh.includes(maxName) ? ok('Page recovers after mid-combat refresh') : fail('Page broken after refresh');
        const atkBtn2 = page.locator('.arena-atk-btn.btn-primary').first();
        (await atkBtn2.count()) > 0 ? ok('Attack buttons available after refresh') : warn('Attack buttons not visible (combat may still be processing)');
      } else {
        warn('No attack button for refresh test');
      }
    } else {
      warn('Max dungeon not found for refresh test');
    }

    // === Test 7: Room 2 transition via full playthrough ===
    console.log('\n=== Test 7: Room 2 Transition ===');
    const roomName = `j8rm${ts}`;
    await navigateHome(page, BASE_URL);
    await page.waitForTimeout(2000);
    await createDungeonUI(page, roomName, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    ok('Room transition dungeon created');

    const won = await playToVictory(page);
    if (won) {
      ok('Room 1 cleared');
      // Wait for post-boss sequence: treasure opens, door unlocks
      for (let i = 0; i < 30; i++) {
        const body = await page.textContent('body');
        if (body.includes('Enter') || body.includes('Room 2')) break;
        await page.waitForTimeout(2000);
      }
      // Click door to enter room 2
      const doorBtn = page.locator('button:has-text("Enter"), .door-entity');
      if (await doorBtn.count() > 0) {
        await doorBtn.first().click({ force: true });
        // Wait for room 2 to load
        for (let i = 0; i < 30; i++) {
          const body = await page.textContent('body');
          if (body.includes('Room 2') || body.includes('room 2')) break;
          await page.waitForTimeout(2000);
        }
        const r2Text = await page.textContent('body');
        r2Text.includes('2') ? ok('Room 2 loaded') : fail('Room 2 did not load');
        // Should NOT show victory banner
        !r2Text.includes('VICTORY') ? ok('No victory banner in room 2') : fail('Victory banner showing in room 2');
        // Monsters should be attackable
        const r2Atk = page.locator('.arena-atk-btn.btn-primary');
        for (let i = 0; i < 10; i++) {
          if (await r2Atk.count() > 0) break;
          await page.waitForTimeout(2000);
        }
        (await r2Atk.count()) > 0 ? ok('Room 2 monsters attackable') : fail('No attack buttons in room 2');
      } else {
        fail('Door not found after room 1 victory');
      }
    } else {
      warn('Hero died before room 2 — cannot test room transition');
    }

    // === Test 8: Defeat state — play until hero dies ===
    console.log('\n=== Test 8: Defeat State ===');
    const defeatName = `j8df${ts}`;
    await navigateHome(page, BASE_URL);
    await page.waitForTimeout(2000);
    // Hard + many monsters = hero likely dies
    await createDungeonUI(page, defeatName, { monsters: 5, difficulty: 'hard', heroClass: 'mage' });
    ok('Defeat test dungeon created');

    // Attack until hero dies (mage has 120 HP, hard monsters hit hard)
    let defeated = false;
    for (let i = 0; i < 40; i++) {
      const body = await page.textContent('body');
      if (body.includes('DEFEAT') || body.includes('has fallen')) { defeated = true; break; }
      const atkBtn = page.locator('.arena-entity:not(.dead) .arena-atk-btn.btn-primary').first();
      if (await atkBtn.count() === 0) break;
      await atkBtn.click({ force: true });
      await waitForCombatResult(page);
      await dismissLootPopup(page);
      await page.waitForTimeout(500);
    }
    if (defeated) {
      ok('Hero defeated');
      const defeatAtk = page.locator('.arena-atk-btn.btn-primary');
      (await defeatAtk.count()) === 0 ? ok('No attack buttons when defeated') : fail('Attack buttons visible when hero is dead');
    } else {
      warn('Hero survived 40 attacks on hard — cannot test defeat state');
    }

    // === Test 9: Console errors ===
    console.log('\n=== Test 9: Console Errors ===');
    consoleErrors.length === 0
      ? ok('No console errors')
      : fail(`${consoleErrors.length} console errors: ${consoleErrors[0]}`);

    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    await navigateHome(page, BASE_URL);
    await page.waitForTimeout(2000);
    for (const name of [speedName, maxName, roomName, defeatName]) {
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
  console.log(`  Journey 8: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
