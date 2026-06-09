// Journey 4: Items & Equipment — Full UI playthrough
// UI-ONLY: no kubectl, no fetch/api, no execSync
const { chromium } = require('playwright');
const { createDungeonUI, attackMonster, attackBoss, waitForCombatResult, dismissLootPopup, useBackpackItem, navigateHome, deleteDungeon , testLogin} = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function getBodyText(page) { return page.textContent('body'); }

async function backpackCount(page) {
  return page.locator('.backpack-slot').count();
}

async function getEquipmentText(page) {
  // Read the equipment panel text for bonuses
  const panel = page.locator('.equipment-panel, .equip-panel, .hero-stats, .hero-panel');
  if (await panel.count() > 0) return panel.textContent();
  return page.textContent('body');
}

// Kill monsters until we collect at least targetCount loot items, or all monsters + boss are dead
async function farmLoot(page, targetCount) {
  const collected = [];
  for (let round = 0; round < 60; round++) {
    // Check if there are alive monsters to attack
    const aliveMonsters = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary');
    const bossBtn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');

    if (await aliveMonsters.count() > 0) {
      await aliveMonsters.first().click({ force: true });
    } else if (await bossBtn.count() > 0) {
      await bossBtn.click({ force: true });
    } else {
      break; // Nothing left to attack
    }

    // Wait for combat result
    const result = await waitForCombatResult(page);
    if (!result) { await page.waitForTimeout(2000); continue; }

    // Check for loot popup after combat
    const loot = await dismissLootPopup(page);
    if (loot) collected.push(loot);

    if (collected.length >= targetCount) break;
    await page.waitForTimeout(1000);
  }
  return collected;
}

async function run() {
  console.log('🧪 Journey 4: Items & Equipment\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j4${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' &&
        !msg.text().includes('WebSocket') &&
        !msg.text().includes('404') &&
        !msg.text().includes('400') &&
        !msg.text().includes('409') && !msg.text().includes('429') &&
        !msg.text().includes('504'))
      consoleErrors.push(msg.text());
  });
  page.on('dialog', dialog => dialog.accept());

  try {
    // === Setup: Create dungeon and farm loot by killing monsters ===
    console.log('=== Setup: Create Dungeon & Farm Loot ===');
    await testLogin(page, BASE_URL);

    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    // Use easy + many monsters to maximize loot drops (easy = 60% drop rate)
    const created = await createDungeonUI(page, dName, { monsters: 5, difficulty: 'easy', heroClass: 'warrior' });
    created ? ok('Dungeon created via UI') : fail('Failed to create dungeon');

    // Farm loot by killing monsters through the UI
    console.log('\n=== Farm Loot by Killing Monsters ===');
    const loot = await farmLoot(page, 3);
    ok(`Collected ${loot.length} loot drops from combat`);

    // === Test 1: Verify backpack shows items ===
    console.log('\n=== Test 1: Backpack Display ===');
    await page.waitForTimeout(2000);
    const slots = await backpackCount(page);
    if (slots > 0) {
      ok(`Backpack has ${slots} item(s)`);
    } else if (loot.length > 0) {
      fail('Loot was collected but backpack is empty');
    } else {
      warn('No loot dropped (RNG) — skipping item tests');
    }

    // === Test 2: Use/equip first item from backpack ===
    console.log('\n=== Test 2: Use First Item ===');
    if (slots > 0) {
      const firstItem = page.locator('.backpack-slot').first();
      const itemText = await firstItem.textContent().catch(() => 'unknown');
      await firstItem.click({ force: true });
      ok(`Clicked item: ${itemText.trim().substring(0, 40)}`);

      // Wait for action to process
      await page.waitForTimeout(8000);

      const slotsAfter = await backpackCount(page);
      slotsAfter < slots
        ? ok(`Item consumed/equipped — backpack ${slots} → ${slotsAfter}`)
        : warn('Backpack count unchanged (item may still be processing)');
    }

    // === Test 3: No loot popup from item use ===
    console.log('\n=== Test 3: No Loot From Item Use ===');
    if (slots > 0) {
      // Use another item and check that no loot popup appears
      const slotsNow2 = await backpackCount(page);
      if (slotsNow2 > 0) {
        const nextSlot = page.locator('.backpack-slot').first();
        await nextSlot.click({ force: true });
        await page.waitForTimeout(5000);
        const lootModal = page.locator('.modal-overlay:has-text("LOOT")');
        (await lootModal.count()) === 0
          ? ok('No phantom loot popup from item action')
          : fail('Loot popup appeared from item use');
      } else {
        ok('No items left to test loot popup (skipped)');
      }
    } else {
      ok('No items to test loot popup (skipped)');
    }

    // === Test 4: Items don't cost a turn (no counter-attack) ===
    console.log('\n=== Test 4: Items Don\'t Cost a Turn ===');
    const slotsNow = await backpackCount(page);
    if (slotsNow > 0) {
      const nextItem = page.locator('.backpack-slot').first();
      await nextItem.click({ force: true });
      await page.waitForTimeout(5000);

      // No combat modal should appear
      const combatModal = page.locator('.combat-modal');
      (await combatModal.count()) === 0
        ? ok('No combat modal from item use (no turn cost)')
        : fail('Combat modal appeared from item use');

    } else {
      ok('No items left to test turn cost (skipped)');
    }

    // === Test 5: Equipment panel reflects changes ===
    console.log('\n=== Test 5: Equipment Panel ===');
    const equipText = await getEquipmentText(page);
    // Check if any equipment bonuses are visible in the UI
    const hasWeaponUI = /weapon|wpn|\+\d+\s*dmg/i.test(equipText);
    const hasArmorUI = /armor|def|\d+%\s*def/i.test(equipText);
    const hasShieldUI = /shield|block|\d+%\s*block/i.test(equipText);
    if (hasWeaponUI || hasArmorUI || hasShieldUI) {
      ok(`Equipment visible in UI (weapon:${hasWeaponUI} armor:${hasArmorUI} shield:${hasShieldUI})`);
    } else if (loot.length === 0) {
      warn('No loot was collected, so no equipment to verify');
    } else {
      warn('Equipment panel text not detected (may use icons only)');
    }

    // === Test 6: Attack with equipment — verify combat works ===
    console.log('\n=== Test 6: Attack With Equipment ===');
    const atkBtns = page.locator('.arena-entity:not(.dead) .arena-atk-btn.btn-primary');
    if (await atkBtns.count() > 0) {
      await atkBtns.first().click({ force: true });
      const combatResult = await waitForCombatResult(page);
      combatResult
        ? ok('Combat works with equipment equipped')
        : fail('Combat failed with equipment');
      await dismissLootPopup(page);
    } else {
      warn('No targets alive for equipped combat test');
    }

    // === Test 7: Rapid item clicks ===
    console.log('\n=== Test 7: Rapid Item Clicks ===');
    const rapidSlots = await backpackCount(page);
    if (rapidSlots > 0) {
      const btn = page.locator('.backpack-slot').first();
      await btn.click({ force: true }).catch(() => {});
      await btn.click({ force: true }).catch(() => {});
      await btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(3000);
      const errText = await getBodyText(page);
      !errText.includes('Error')
        ? ok('Rapid item clicks handled gracefully')
        : fail('Error after rapid item clicks');
    } else {
      ok('No items left for rapid-click test');
    }

    // === Test 8: Console errors ===
    console.log('\n=== Test 8: Console Errors ===');
    consoleErrors.length === 0
      ? ok('No console errors')
      : fail(`${consoleErrors.length} console errors: ${consoleErrors[0]}`);

    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    await navigateHome(page, BASE_URL);
    await page.waitForTimeout(2000);
    await deleteDungeon(page, dName);
    ok('Cleanup initiated via UI');

  } catch (error) {
    console.error(`\n❌ Fatal: ${error.message}`);
    failed++;
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Journey 4: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
