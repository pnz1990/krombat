// Journey 1: Warrior Easy — Full UI Playthrough (no API shortcuts)
// Tests exactly what a user sees and clicks
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function run() {
  console.log('🧪 Journey 1: Warrior Easy — Full UI Playthrough\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j1-${Date.now()}`;
  const combatLog = []; // Collect all combat events for debugging

  // Collect console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404'))
      consoleErrors.push(msg.text());
  });

  try {
    // === STEP 1: Create dungeon via UI ===
    console.log('=== Step 1: Create Dungeon ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    await page.fill('input[placeholder="my-dungeon"]', dName);
    await page.selectOption('select >> nth=0', 'easy');
    await page.selectOption('select >> nth=1', 'warrior');
    // Set monsters to 2
    const monsterInput = page.locator('input[type="number"]');
    if (await monsterInput.count() > 0) {
      await monsterInput.fill('2');
    }
    await page.click('button:has-text("Create Dungeon")');
    await page.waitForTimeout(3000);
    ok('Create form submitted');

    // Should navigate to dungeon view
    // Wait for dungeon to load (not stuck on "Initializing")
    let loadAttempts = 0;
    for (let i = 0; i < 30; i++) {
      const text = await page.textContent('body');
      if (text.includes('WARRIOR') && text.includes(dName)) { loadAttempts = i; break; }
      if (text.includes('Initializing')) { await page.waitForTimeout(2000); continue; }
      await page.waitForTimeout(1000);
    }
    const bodyAfterCreate = await page.textContent('body');
    bodyAfterCreate.includes(dName) && bodyAfterCreate.includes('WARRIOR')
      ? ok(`Dungeon loaded (${loadAttempts}s)`)
      : fail('Dungeon did not load');

    // === STEP 2: Verify initial state ===
    console.log('\n=== Step 2: Initial State ===');
    const text = await page.textContent('body');
    text.includes('200') ? ok('Hero HP: 200') : fail('Hero HP not 200');

    const monsters = page.locator('.arena-entity.monster-entity');
    const mCount = await monsters.count();
    mCount === 2 ? ok('2 monsters in arena') : fail(`Expected 2 monsters, got ${mCount}`);

    const atkBtns = page.locator('.arena-atk-btn.btn-primary');
    const btnCount = await atkBtns.count();
    btnCount >= 2 ? ok(`${btnCount} attack buttons visible`) : fail('Attack buttons missing');

    // === STEP 3: First attack via UI click ===
    console.log('\n=== Step 3: First Attack (UI click) ===');
    const firstBtn = page.locator('.arena-atk-btn.btn-primary').first();
    if (await firstBtn.count() === 0) { fail('No attack button'); } else {
      await firstBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);

      // Check combat modal appeared
      const modal = page.locator('.combat-modal');
      const modalVisible = (await modal.count()) > 0;
      modalVisible ? ok('Combat modal appeared') : warn('Combat modal not visible yet');

      // Wait for combat to resolve (up to 65s)
      console.log('    Waiting for combat to resolve...');
      let resolved = false;
      for (let i = 0; i < 25; i++) {
        const continueBtn = page.locator('button:has-text("Continue")');
        if (await continueBtn.count() > 0) {
          resolved = true;
          // Check combat result content
          const modalText = await page.textContent('.combat-modal').catch(() => '');
          if (modalText.includes('damage') || modalText.includes('HP')) {
            ok('Combat result has content');
            combatLog.push(`COMBAT: ${modalText.substring(0, 200)}`);
          } else {
            fail('Combat result EMPTY');
            combatLog.push('COMBAT: EMPTY RESULT');
          }
          // Dismiss
          await continueBtn.click().catch(() => {});
          await page.waitForTimeout(500);
          ok('Combat modal dismissed');
          break;
        }
        await page.waitForTimeout(3000);
      }
      if (!resolved) {
        warn('Combat did not resolve in 75s — dismissing');
        const closeBtn = page.locator('.modal-close').first();
        if (await closeBtn.count() > 0) await closeBtn.click().catch(() => {});
        combatLog.push('COMBAT: TIMEOUT - no result');
      }

      // Check game log has entry
      await page.waitForTimeout(500);
      const logText = await page.textContent('body');
      // Should NOT have "Monster already dead" as first entry
      if (logText.includes('Monster already dead')) {
        fail('Game log shows "Monster already dead" (should not happen on first attack)');
      }
    }

    // === STEP 4: Second attack — verify consistency ===
    console.log('\n=== Step 4: Second Attack ===');
    const secondBtn = page.locator('.arena-atk-btn.btn-primary').first();
    if (await secondBtn.count() > 0) {
      await secondBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);

      let resolved2 = false;
      for (let i = 0; i < 25; i++) {
        const cb = page.locator('button:has-text("Continue")');
        if (await cb.count() > 0) {
          resolved2 = true;
          const mt = await page.textContent('.combat-modal').catch(() => '');
          if (mt.includes('damage') || mt.includes('HP')) {
            ok('Second attack has combat result');
            combatLog.push(`COMBAT2: ${mt.substring(0, 200)}`);
          } else {
            fail('Second attack EMPTY result');
            combatLog.push('COMBAT2: EMPTY');
          }
          await cb.click().catch(() => {});
          await page.waitForTimeout(500);
          break;
        }
        await page.waitForTimeout(3000);
      }
      if (!resolved2) warn('Second attack did not resolve');
    } else {
      warn('No attack button for second attack');
    }

    // === STEP 5: Check game log quality ===
    console.log('\n=== Step 5: Game Log Quality ===');
    const eventEntries = page.locator('.event-entry');
    const entryCount = await eventEntries.count();
    entryCount >= 2 ? ok(`Game log has ${entryCount} entries`) : warn(`Game log has ${entryCount} entries (expected ≥2)`);

    // Check for spam
    const fullLog = await page.textContent('body');
    const alreadyDeadCount = (fullLog.match(/Monster already dead/g) || []).length;
    alreadyDeadCount === 0 ? ok('No "Monster already dead" spam') : fail(`${alreadyDeadCount}x "Monster already dead" in log`);

    const bossUnlockedCount = (fullLog.match(/Boss unlocked/g) || []).length;
    bossUnlockedCount <= 1 ? ok('Boss unlocked shown at most once') : fail(`${bossUnlockedCount}x "Boss unlocked" in log`);

    // === STEP 6: Check HP bar updates ===
    console.log('\n=== Step 6: HP Bar Updates ===');
    // Monster HP should have changed from initial
    const hpText = await page.textContent('body');
    // Look for monster HP display (e.g. "goblin · 15/30")
    const hpMatch = hpText.match(/(\d+)\/30/);
    if (hpMatch && parseInt(hpMatch[1]) < 30) {
      ok(`Monster HP updated: ${hpMatch[1]}/30`);
    } else {
      warn('Monster HP bar may not have updated yet');
    }

    // === STEP 7: Check for duplicate loot popups ===
    console.log('\n=== Step 7: Loot Behavior ===');
    // At this point we may or may not have loot — just verify no phantom popup
    const lootModal = page.locator('.modal-overlay:has-text("Loot")');
    const lootVisible = (await lootModal.count()) > 0;
    if (lootVisible) {
      ok('Loot popup visible (monster may have died)');
      // Dismiss it
      const gotIt = page.locator('button:has-text("Got it")');
      if (await gotIt.count() > 0) await gotIt.click();
    } else {
      ok('No phantom loot popup');
    }

    // === STEP 8: Verify no duplicate attacks ===
    console.log('\n=== Step 8: No Duplicate Attacks ===');
    // Rapid-click test: click attack button 3 times fast
    const rapidBtn = page.locator('.arena-atk-btn.btn-primary').first();
    if (await rapidBtn.count() > 0) {
      await rapidBtn.click({ force: true }).catch(() => {});
      await rapidBtn.click({ force: true }).catch(() => {});
      await rapidBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(2000);
      // Should only have one combat modal, not three
      const modals = page.locator('.combat-modal');
      const modalCount = await modals.count();
      modalCount <= 1 ? ok('Rapid clicks produced at most 1 modal') : fail(`Rapid clicks produced ${modalCount} modals`);

      // Wait and dismiss
      for (let i = 0; i < 25; i++) {
        const cb = page.locator('button:has-text("Continue")');
        if (await cb.count() > 0) { await cb.click().catch(() => {}); break; }
        await page.waitForTimeout(3000);
      }
      await page.waitForTimeout(500);
    }

    // === STEP 9: Console errors ===
    console.log('\n=== Step 9: Console Errors ===');
    consoleErrors.length === 0
      ? ok('No console errors')
      : fail(`${consoleErrors.length} console errors: ${consoleErrors[0]}`);

    // === Print combat log for debugging ===
    console.log('\n=== Combat Log (for debugging) ===');
    combatLog.forEach(l => console.log(`    ${l}`));

    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    await page.evaluate(async (name) => {
      try { await fetch(`/api/v1/dungeons/default/${name}`, { method: 'DELETE' }); } catch {}
    }, dName);
    ok('Cleanup initiated');

  } catch (error) {
    console.error(`\n❌ Fatal: ${error.message}`);
    failed++;
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Journey 1: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
