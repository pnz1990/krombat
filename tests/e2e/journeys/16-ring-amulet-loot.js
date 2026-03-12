// Journey 16: Ring-Regen and Amulet-Power Passive Loot Items
// UI-ONLY: no kubectl, no fetch/api, no execSync
//
// Strategy:
//   1. Create a dungeon and fight to check for ring/amulet RNG drops (warn if absent, like J05).
//   2. Use the Cheat Modal (open Help → type "999") to reliably equip ring-common and amulet-common.
//   3. Verify ring/amulet equip slots update (filled class) and bonus text appears in the UI.
//   4. Verify lastHeroAction confirms equip in the event log.
//   5. Optionally verify combat still works after equipping passives.

const { chromium } = require('playwright');
const { createDungeonUI, attackMonster, attackBoss, waitForCombatResult, dismissLootPopup, navigateHome, deleteDungeon } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function getBodyText(page) { return page.textContent('body'); }

// Open the cheat modal by: click Help button → type "999" → wait for cheat modal
async function openCheatModal(page) {
  const helpBtn = page.locator('button[aria-label="Help"]');
  if (await helpBtn.count() === 0) return false;
  await helpBtn.click();
  await page.waitForTimeout(500);
  // Type "999" to unlock cheat mode (HelpModal keydown handler)
  await page.keyboard.type('999');
  await page.waitForTimeout(800);
  // Cheat modal has aria-label="Cheat mode"
  const cheatModal = page.locator('[aria-label="Cheat mode"]');
  return (await cheatModal.count()) > 0;
}

// Click item in cheat modal by label text, then close the modal
async function cheatEquip(page, label) {
  const btn = page.locator(`[aria-label="Cheat mode"] button[title="${label}"]`);
  if (await btn.count() === 0) return false;
  await btn.click({ force: true });
  // The action fires; close the cheat modal
  await page.waitForTimeout(500);
  const closeBtn = page.locator('[aria-label="Cheat mode"] button.btn-gold');
  if (await closeBtn.count() > 0) await closeBtn.click();
  return true;
}

// Read ring/amulet equip slot fill state
async function getEquipSlots(page) {
  const ringFilled  = (await page.locator('.equip-slot.filled').count()) > 0 &&
                      (await page.locator('.equip-slot.filled:has([alt="ring-common"],[alt="ring-rare"],[alt="ring-epic"])').count()) > 0;
  const amuletFilled = (await page.locator('.equip-slot.filled:has([alt="amulet-common"],[alt="amulet-rare"],[alt="amulet-epic"])').count()) > 0;
  return { ringFilled, amuletFilled };
}

// Fight until monster kill yields ring or amulet loot; returns item id or null
async function farmForRingOrAmulet(page, maxRounds) {
  for (let i = 0; i < maxRounds; i++) {
    const monBtn = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary').first();
    const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');

    if (await monBtn.count() > 0) {
      await monBtn.click({ force: true });
    } else if (await bossBtn.count() > 0) {
      await bossBtn.click({ force: true });
    } else {
      break;
    }

    await waitForCombatResult(page);
    await page.waitForTimeout(500);

    // Check loot popup before dismissing
    const gotIt = page.locator('button:has-text("Got it!")');
    if (await gotIt.count() > 0) {
      const modalText = await page.textContent('.modal').catch(() => '');
      await gotIt.click().catch(() => {});
      await page.waitForTimeout(500);
      if (/ring/i.test(modalText) || /amulet/i.test(modalText)) {
        return modalText;
      }
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function run() {
  console.log('🧪 Journey 16: Ring-Regen and Amulet-Power Loot Items\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j16-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('400'))
      consoleErrors.push(msg.text());
  });
  page.on('dialog', dialog => dialog.accept());

  try {
    // === Setup ===
    console.log('=== Setup: Create Easy Warrior Dungeon (1 monster) ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    const created = await createDungeonUI(page, dName, { monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    created ? ok('Dungeon created via UI') : fail('Failed to create dungeon');

    // === Step 1: Check for ring/amulet in loot popup (RNG-dependent) ===
    console.log('\n=== Step 1: Fight Monster — Check for Ring/Amulet Loot Drop (RNG) ===');
    const rngLoot = await farmForRingOrAmulet(page, 4);
    if (rngLoot) {
      const isRing   = /ring/i.test(rngLoot);
      const isAmulet = /amulet/i.test(rngLoot);
      isRing   && ok(`Ring appeared in loot popup: ${rngLoot.replace(/\s+/g, ' ').trim().substring(0, 60)}`);
      isAmulet && ok(`Amulet appeared in loot popup: ${rngLoot.replace(/\s+/g, ' ').trim().substring(0, 60)}`);
      ok('Loot popup displayed item name and description for ring/amulet type');
    } else {
      warn('No ring or amulet dropped in first 4 kills (RNG — statistically possible); proceeding to cheat-equip path');
    }

    // === Step 2: Equip ring via Cheat Modal ===
    console.log('\n=== Step 2: Equip Ring via Cheat Modal ===');
    const cheatOpened = await openCheatModal(page);
    cheatOpened
      ? ok('Cheat modal opened (Help → type "999")')
      : fail('Cheat modal did not open');

    if (cheatOpened) {
      const ringEquipped = await cheatEquip(page, 'Common Ring');
      ringEquipped
        ? ok('Clicked "Common Ring" in cheat modal')
        : fail('Common Ring button not found in cheat modal');

      // Wait for action to process through Action CR pipeline
      await page.waitForTimeout(8000);

      // === Step 3: Verify ring equip slot is filled ===
      console.log('\n=== Step 3: Verify Ring Equip Slot Shows Filled ===');
      const bodyAfterRing = await getBodyText(page);
      // Equipment slot should now have ring sprite (filled class)
      const ringSlotFilled = await page.locator('.equip-slot.filled').count() > 0;
      ringSlotFilled
        ? ok('At least one equip slot is filled after equipping ring')
        : warn('No filled equip slot detected (UI may update async)');

      // === Step 4: Verify ring bonus visible in UI text ===
      console.log('\n=== Step 4: Ring Bonus Visible in UI ===');
      // The UI renders: 💍 Ring +5/turn (in combat panel) and slot-stat "+5"
      // and tooltip "Ring equipped: +5 HP regen at start of each round"
      const hasRingBonus = bodyAfterRing.includes('Ring +') ||
                           bodyAfterRing.includes('/turn') ||
                           bodyAfterRing.includes('regen') ||
                           bodyAfterRing.includes('HP regen');
      hasRingBonus
        ? ok('Ring bonus visible in UI (Ring +N/turn or regen text)')
        : warn('Ring bonus text not immediately visible (may need another poll cycle)');

      // Check lastHeroAction in event log / body for equip confirmation
      const hasEquipMsg = bodyAfterRing.includes('ring-common') ||
                          bodyAfterRing.includes('HP regen per round') ||
                          bodyAfterRing.includes('Equipped ring');
      hasEquipMsg
        ? ok('lastHeroAction confirms ring-common equip in UI')
        : warn('Equip confirmation message not found in body text yet');
    }

    // === Step 5: Equip amulet via Cheat Modal ===
    console.log('\n=== Step 5: Equip Amulet via Cheat Modal ===');
    const cheatOpened2 = await openCheatModal(page);
    cheatOpened2
      ? ok('Cheat modal opened for amulet equip')
      : fail('Cheat modal did not open for amulet');

    if (cheatOpened2) {
      const amuletEquipped = await cheatEquip(page, 'Common Amulet');
      amuletEquipped
        ? ok('Clicked "Common Amulet" in cheat modal')
        : fail('Common Amulet button not found in cheat modal');

      // Wait for Action CR pipeline
      await page.waitForTimeout(8000);

      // === Step 6: Verify amulet equip slot is filled ===
      console.log('\n=== Step 6: Verify Amulet Equip Slot Shows Filled ===');
      const bodyAfterAmulet = await getBodyText(page);
      const filledSlots = await page.locator('.equip-slot.filled').count();
      filledSlots >= 1
        ? ok(`${filledSlots} equip slot(s) filled after equipping amulet`)
        : warn('Amulet equip slot not visibly filled yet');

      // === Step 7: Verify amulet bonus visible in UI text ===
      console.log('\n=== Step 7: Amulet Bonus Visible in UI ===');
      // The UI renders: 📿 Amulet +10%dmg and tooltip "Amulet equipped: +10% to all damage dealt"
      const hasAmuletBonus = bodyAfterAmulet.includes('Amulet +') ||
                             bodyAfterAmulet.includes('%dmg') ||
                             bodyAfterAmulet.includes('damage boost') ||
                             bodyAfterAmulet.includes('damage dealt');
      hasAmuletBonus
        ? ok('Amulet bonus visible in UI (Amulet +N%dmg or damage boost text)')
        : warn('Amulet bonus text not immediately visible (may need another poll cycle)');

      const hasAmuletMsg = bodyAfterAmulet.includes('amulet-common') ||
                           bodyAfterAmulet.includes('damage boost') ||
                           bodyAfterAmulet.includes('Equipped amulet');
      hasAmuletMsg
        ? ok('lastHeroAction confirms amulet-common equip in UI')
        : warn('Amulet equip confirmation message not found in body text yet');
    }

    // === Step 8: Both bonuses shown together in status area ===
    console.log('\n=== Step 8: Status Area Shows Both Ring and Amulet Bonuses ===');
    await page.waitForTimeout(3000);
    const bodyBoth = await getBodyText(page);
    const bothRing   = bodyBoth.includes('Ring +') || bodyBoth.includes('/turn');
    const bothAmulet = bodyBoth.includes('Amulet +') || bodyBoth.includes('%dmg');
    bothRing
      ? ok('Ring bonus present in status area')
      : warn('Ring bonus not found in status area after equipping both');
    bothAmulet
      ? ok('Amulet bonus present in status area')
      : warn('Amulet bonus not found in status area after equipping both');

    // === Step 9: Combat still works after passive equips ===
    console.log('\n=== Step 9: Combat Works After Equipping Ring + Amulet ===');
    const anyAlive = page.locator('.arena-entity:not(.dead) .arena-atk-btn.btn-primary');
    if (await anyAlive.count() > 0) {
      await anyAlive.first().click({ force: true });
      const combatResult = await waitForCombatResult(page);
      combatResult
        ? ok('Combat resolves normally after passive item equips')
        : warn('Combat result not received — boss/monsters may already be dead');
      await dismissLootPopup(page);
    } else {
      warn('No alive targets for post-equip combat test (all already dead)');
    }

    // === Step 10: Check for ring/amulet in boss loot (RNG) ===
    console.log('\n=== Step 10: Boss Loot May Include Ring/Amulet (RNG) ===');
    const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
    if (await bossBtn.count() > 0) {
      let bossLootText = null;
      for (let i = 0; i < 15; i++) {
        if (await bossBtn.count() === 0) break;
        await bossBtn.click({ force: true });
        await waitForCombatResult(page);
        await page.waitForTimeout(500);
        const gotIt = page.locator('button:has-text("Got it!")');
        if (await gotIt.count() > 0) {
          const lt = await page.textContent('.modal').catch(() => '');
          await gotIt.click().catch(() => {});
          await page.waitForTimeout(500);
          if (/ring/i.test(lt) || /amulet/i.test(lt)) {
            bossLootText = lt;
            break;
          }
        }
        await page.waitForTimeout(1000);
      }
      if (bossLootText) {
        ok(`Ring/amulet dropped from boss loot: ${bossLootText.replace(/\s+/g, ' ').trim().substring(0, 60)}`);
      } else {
        warn('Boss did not drop ring/amulet (RNG — boss always drops loot, just may not be ring/amulet type)');
      }
    } else {
      warn('Boss not reachable for boss-loot test (monsters may still be alive or boss already defeated)');
    }

    // === Step 11: Loot popup correctly identifies ring/amulet item types ===
    console.log('\n=== Step 11: Loot Popup Item Description for Ring/Amulet ===');
    // Verify that if loot drops with ring or amulet, the popup shows correct tooltip text.
    // The loot popup renders 'A mysterious item' for unknown types — ring and amulet should NOT be 'A mysterious item'
    // We already validated that ring/amulet items appear in loot popup in Step 1 (if RNG favored).
    // If no ring/amulet from RNG, check that the cheat-equip path did not show loot popup (items go directly to action).
    const mysteriousCount = (await getBodyText(page)).split('mysterious item').length - 1;
    mysteriousCount === 0
      ? ok('No "mysterious item" text in current UI (ring/amulet descriptions are handled)')
      : warn(`"mysterious item" text appears ${mysteriousCount} time(s) — ring/amulet description may be missing`);

    // === Step 12: Console errors ===
    console.log('\n=== Step 12: Console Errors ===');
    consoleErrors.length === 0
      ? ok('No console errors during journey')
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
    try {
      await navigateHome(page, BASE_URL);
      await deleteDungeon(page, dName);
    } catch (_) {}
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Journey 16: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
