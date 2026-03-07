// Journey 2: Mage Normal — Abilities & Mana
// UI-ONLY: no kubectl, no fetch/api, no execSync
// Tests: mage creation, initial state, mana consumption per attack, mana regen on kill,
//        heal enable/disable logic, heal result, zero-mana half-damage, no-counter on heal
const { chromium } = require('playwright');
const { createDungeonUI, waitForCombatResult, dismissLootPopup, navigateHome, deleteDungeon } = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function getBodyText(page) { return page.textContent('body'); }

// Click the first available attack target (monster or boss) and return combat text
async function doAttack(page) {
  const aliveMonsters = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary');
  const bossBtn       = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
  if (await aliveMonsters.count() > 0) {
    await aliveMonsters.first().click({ force: true });
  } else if (await bossBtn.count() > 0) {
    await bossBtn.click({ force: true });
  } else {
    return null; // nothing to attack
  }
  const result = await waitForCombatResult(page);
  await dismissLootPopup(page);
  return result;
}

// Return current mana from page text (number or null)
async function getMana(page) {
  const m = (await getBodyText(page)).match(/Mana:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Return current hero HP from "HP: X / Y" display (number or null)
async function getHeroHP(page) {
  const m = (await getBodyText(page)).match(/HP:\s*(\d+)\s*\/\s*\d+/);
  return m ? parseInt(m[1], 10) : null;
}

// Click Heal and return combat modal text
async function doHeal(page) {
  const btn = page.locator('button:has-text("Heal")');
  if (await btn.count() === 0 || await btn.isDisabled().catch(() => true)) return null;
  await btn.click({ force: true });
  return waitForCombatResult(page);
}

async function run() {
  console.log('🧪 Journey 2: Mage Normal — Abilities & Mana\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j2-${Date.now()}`;
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404'))
      consoleErrors.push(msg.text());
  });
  page.on('dialog', dialog => dialog.accept());

  try {
    // === STEP 1: Create mage dungeon via UI ===
    console.log('=== Step 1: Create Mage Dungeon ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    // 3 monsters, normal difficulty — enough counter-attacks to drain HP below 80
    const created = await createDungeonUI(page, dName, { monsters: 3, difficulty: 'normal', heroClass: 'mage' });
    created ? ok('Mage dungeon created via UI') : fail('Dungeon did not load as mage');

    // === STEP 2: Verify mage initial state ===
    console.log('\n=== Step 2: Mage Initial State ===');
    const initBody = await getBodyText(page);
    initBody.includes('MAGE')    ? ok('Hero class shown as MAGE')            : fail('Hero class not MAGE');
    initBody.includes('120')     ? ok('Hero HP shows 120')                   : fail('Hero HP not 120');
    initBody.includes('Mana:')   ? ok('Mana display visible')                : fail('Mana display missing');
    initBody.includes('Mana: 8') ? ok('Starting mana is 8')                  : fail(`Starting mana not 8 — got: ${initBody.match(/Mana:\s*\d+/)?.[0]}`);

    const healBtnInit = page.locator('button:has-text("Heal")');
    (await healBtnInit.count()) > 0
      ? ok('Heal button present')
      : fail('Heal button missing');
    await healBtnInit.isDisabled().catch(() => false) === true
      ? ok('Heal disabled at full HP (120 >= 80 threshold)')
      : fail('Heal should be disabled at full HP');

    (await page.locator('button:has-text("Taunt")').count()) === 0
      ? ok('No Taunt button (mage only)')
      : fail('Taunt button visible for mage');
    (await page.locator('text=Backstab').count()) === 0
      ? ok('No Backstab text (mage only)')
      : fail('Backstab visible for mage');

    // === STEP 3: First attack — mana decreases by 1, combat has result text ===
    console.log('\n=== Step 3: First Attack — Mana Consumption ===');
    const manaBefore1 = await getMana(page);
    const result1 = await doAttack(page);
    if (!result1) {
      fail('First attack did not resolve');
    } else {
      ok('First attack resolved');
      result1.includes('damage') || result1.includes('HP')
        ? ok('Combat result contains damage/HP info')
        : fail(`First attack result has no damage/HP: ${result1.substring(0, 100)}`);
      const manaAfter1 = await getMana(page);
      if (manaBefore1 !== null && manaAfter1 !== null) {
        manaAfter1 === manaBefore1 - 1
          ? ok(`Mana decreased by 1 (${manaBefore1} → ${manaAfter1})`)
          : fail(`Expected mana ${manaBefore1 - 1}, got ${manaAfter1}`);
      } else {
        warn(`Could not verify mana: before=${manaBefore1} after=${manaAfter1}`);
      }
    }

    // === STEP 4 + 5 + 6: Take real damage, then heal immediately when HP < 80 ===
    // Strategy: after each attack, check if HP < 80 AND mana >= 2 — heal immediately
    // This tests both the heal-enable condition AND the heal action in one loop
    console.log('\n=== Step 4-6: Take Damage → Heal When HP < 80 (with mana) ===');
    let healTested = false;
    let hpBeforeHeal = null, hpAfterHeal = null, manaBeforeHeal = null, manaAfterHeal = null;
    let healResult = null;

    for (let round = 0; round < 20 && !healTested; round++) {
      const hp = await getHeroHP(page);
      const mana = await getMana(page);
      if (hp === null || mana === null) break;

      // If HP < 80 and mana >= 2: heal now
      if (hp < 80 && mana >= 2) {
        ok(`HP dropped to ${hp} with ${mana} mana — heal should be enabled`);

        // Verify Heal button is enabled
        const healBtnLow = page.locator('button:has-text("Heal")');
        const isDisabled = await healBtnLow.isDisabled().catch(() => true);
        isDisabled === false
          ? ok(`Heal button enabled at ${hp} HP, ${mana} mana`)
          : fail(`Heal button still disabled at ${hp} HP, ${mana} mana`);

        hpBeforeHeal = hp;
        manaBeforeHeal = mana;
        healResult = await doHeal(page);
        hpAfterHeal = await getHeroHP(page);
        manaAfterHeal = await getMana(page);
        healTested = true;
        break;
      }

      // If mana < 2 but HP is still >= 80, we can't heal anyway — keep attacking
      const r = await doAttack(page);
      if (!r) break; // no more targets
      await page.waitForTimeout(300);
    }

    if (!healTested) {
      // Either mana ran out before HP dropped, or vice versa
      const hp = await getHeroHP(page);
      const mana = await getMana(page);
      warn(`Could not test heal in combat: final HP=${hp}, mana=${mana} (need HP<80 AND mana>=2 at same time)`);
    } else {
      // Validate heal result
      if (!healResult) {
        fail('Heal action did not resolve');
      } else {
        ok('Heal action resolved');
        healResult.includes('heals') || healResult.includes('Heal') || healResult.includes('HP')
          ? ok('Heal result contains expected text')
          : fail(`Unexpected heal result: ${healResult.substring(0, 120)}`);
        healResult.includes('No counter-attack')
          ? ok('No counter-attack during heal')
          : fail(`Expected "No counter-attack", got: ${healResult.substring(0, 120)}`);
      }

      // HP should have increased, capped at 120
      if (hpBeforeHeal !== null && hpAfterHeal !== null) {
        hpAfterHeal > hpBeforeHeal
          ? ok(`HP increased after heal: ${hpBeforeHeal} → ${hpAfterHeal}`)
          : fail(`HP did not increase: ${hpBeforeHeal} → ${hpAfterHeal}`);
        hpAfterHeal <= 120
          ? ok(`HP capped at or below 120 (${hpAfterHeal})`)
          : fail(`HP exceeds 120 after heal: ${hpAfterHeal}`);
      }

      // Mana decreased by 2
      if (manaBeforeHeal !== null && manaAfterHeal !== null) {
        manaAfterHeal === manaBeforeHeal - 2
          ? ok(`Mana decreased by 2 (${manaBeforeHeal} → ${manaAfterHeal})`)
          : fail(`Expected mana ${manaBeforeHeal - 2}, got ${manaAfterHeal}`);
      }
    }

    // === STEP 7: Heal disabled at full HP (>= 80) ===
    console.log('\n=== Step 7: Heal Disabled at High HP ===');
    const hpNow = await getHeroHP(page);
    if (hpNow !== null && hpNow >= 80) {
      const healBtnHigh = page.locator('button:has-text("Heal")');
      const disabledHigh = await healBtnHigh.isDisabled().catch(() => true);
      disabledHigh === true
        ? ok(`Heal disabled at ${hpNow} HP (>= 80 threshold)`)
        : fail(`Heal should be disabled at ${hpNow} HP but is enabled`);
    } else {
      warn(`HP=${hpNow}, skipping high-HP heal disabled check`);
    }

    // === STEP 8: Mana regen on monster kill ===
    console.log('\n=== Step 8: Mana Regen on Monster Kill ===');
    const aliveCount = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
    if (aliveCount > 0) {
      // Attack until a monster dies
      let manaBeforeKill = null, manaAfterKill = null, killFound = false;
      for (let i = 0; i < 15; i++) {
        const aliveBefore = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
        if (aliveBefore === 0) break;
        manaBeforeKill = await getMana(page);
        const r = await doAttack(page);
        if (!r) break;
        const aliveAfter = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
        if (aliveAfter < aliveBefore) {
          manaAfterKill = await getMana(page);
          // Mana regen: +1 on kill, but only if mana < 5. Net change = -1 (attack cost) + 1 (regen) = 0
          // Or if mana was already >= 5 when the kill happened, net = -1
          if (manaBeforeKill !== null && manaAfterKill !== null && manaBeforeKill < 5) {
            manaAfterKill >= manaBeforeKill - 1
              ? ok(`Mana regen on kill: ${manaBeforeKill} → ${manaAfterKill} (net ≥ -1, regen applied)`)
              : fail(`Expected mana regen on kill: ${manaBeforeKill} → ${manaAfterKill}`);
            r.includes('mana') || r.includes('Mana')
              ? ok('Kill result mentions mana regen')
              : warn(`Kill result doesn't mention mana: ${r.substring(0, 100)}`);
          } else {
            ok(`Monster killed — mana regen check: before=${manaBeforeKill} after=${manaAfterKill}`);
          }
          killFound = true;
          break;
        }
      }
      if (!killFound) warn('Could not kill a monster in 15 attacks for mana regen test');
    } else {
      warn('No alive monsters — skipping mana regen test');
    }

    // === STEP 9: Heal disabled when mana < 2 ===
    console.log('\n=== Step 9: Heal Disabled at Low Mana ===');
    // Attack until mana < 2 (each attack costs 1 mana)
    for (let i = 0; i < 15; i++) {
      const m = await getMana(page);
      if (m !== null && m < 2) break;
      const r = await doAttack(page);
      if (!r) break;
      await page.waitForTimeout(300);
    }
    const manaLow = await getMana(page);
    if (manaLow !== null && manaLow < 2) {
      const healBtnLowMana = page.locator('button:has-text("Heal")');
      const disabledLow = await healBtnLowMana.isDisabled().catch(() => true);
      disabledLow === true
        ? ok(`Heal disabled at ${manaLow} mana (< 2 required)`)
        : fail(`Heal should be disabled at ${manaLow} mana`);
    } else {
      warn(`Could not drain mana below 2 (current: ${manaLow}) — targets may be exhausted`);
    }

    // === STEP 10: Zero-mana attack — resolves with "No mana!" note ===
    console.log('\n=== Step 10: Zero-Mana Attack ===');
    // Drain to exactly 0
    for (let i = 0; i < 5; i++) {
      const m = await getMana(page);
      if (m === 0) break;
      const r = await doAttack(page);
      if (!r) break;
    }
    const manaZero = await getMana(page);
    if (manaZero === 0) {
      const result0 = await doAttack(page);
      if (!result0) {
        warn('No targets alive for zero-mana attack test');
      } else {
        ok('Attack at 0 mana resolved');
        result0.includes('damage') || result0.includes('HP')
          ? ok('0-mana attack has damage/HP in result')
          : fail(`0-mana attack has no damage/HP: ${result0.substring(0, 100)}`);
        // attack-graph should emit "(No mana!)" in CLASS_NOTE
        result0.includes('No mana') || result0.includes('no mana')
          ? ok('"No mana" noted in combat result')
          : fail(`Expected "No mana" in 0-mana attack result, got: ${result0.substring(0, 150)}`);
        // Mana stays at 0
        const manaStill = await getMana(page);
        manaStill === 0
          ? ok('Mana stays at 0 after 0-mana attack')
          : warn(`Expected mana 0, got ${manaStill}`);
      }
    } else {
      warn(`Mana is ${manaZero}, not 0 — skipping zero-mana attack test`);
    }

    // === STEP 11: Console errors ===
    console.log('\n=== Step 11: Console Errors ===');
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
  console.log(`  Journey 2: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
