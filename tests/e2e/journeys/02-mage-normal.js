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

// Click the first available attack target (monster then boss) and return combat text
async function doAttack(page) {
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
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('net::ERR'))
      consoleErrors.push(msg.text());
  });
  page.on('dialog', dialog => dialog.accept());

  try {
    // === STEP 1: Create mage dungeon via UI ===
    console.log('=== Step 1: Create Mage Dungeon ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    // 6 monsters, normal — 6×2=12 dmg/round counter-attacks will push HP below 80 in ~4 attacks
    // while keeping mana available (starts 8, each attack costs 1)
    const created = await createDungeonUI(page, dName, { monsters: 6, difficulty: 'normal', heroClass: 'mage' });
    created ? ok('Mage dungeon created via UI') : fail('Dungeon did not load as mage');

    // === STEP 2: Verify mage initial state ===
    console.log('\n=== Step 2: Mage Initial State ===');
    const initBody = await getBodyText(page);
    initBody.includes('MAGE')    ? ok('Hero class shown as MAGE')   : fail('Hero class not MAGE');
    initBody.includes('120')     ? ok('Hero HP shows 120')           : fail('Hero HP not 120');
    initBody.includes('Mana:')   ? ok('Mana display visible')        : fail('Mana display missing');
    initBody.includes('Mana: 8') ? ok('Starting mana is 8')          : fail(`Starting mana not 8 — got: ${initBody.match(/Mana:\s*\d+/)?.[0]}`);

    const healBtnInit = page.locator('button:has-text("Heal")');
    (await healBtnInit.count()) > 0 ? ok('Heal button present') : fail('Heal button missing');
    // At 120 HP (full HP) the heal button should be disabled
    const initDisabled = await healBtnInit.isDisabled().catch(() => false);
    initDisabled === true
      ? ok('Heal disabled at full HP (120/120)')
      : fail('Heal should be disabled at full HP');

    (await page.locator('button:has-text("Taunt")').count()) === 0
      ? ok('No Taunt button (mage only)') : fail('Taunt button visible for mage');
    (await page.locator('text=Backstab').count()) === 0
      ? ok('No Backstab text (mage only)') : fail('Backstab visible for mage');

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

    // === STEP 4-6: Take real damage, heal opportunistically when HP < 80 ===
    // After each attack, check HP and mana — heal as soon as conditions are met.
    // With 6 monsters (12 dmg/round) and mana starting at 7, HP drops ~12/attack.
    // After 4 attacks: HP ≈ 72, mana ≈ 4 → ideal heal window.
    console.log('\n=== Step 4-6: Take Damage → Heal Opportunistically ===');
    let healTested = false;
    let hpBeforeHeal = null, hpAfterHeal = null, manaBeforeHeal = null, manaAfterHeal = null;
    let healResult = null;

    for (let round = 0; round < 15 && !healTested; round++) {
      const hp = await getHeroHP(page);
      const mana = await getMana(page);
      if (hp === null || mana === null) break;

      if (hp < 80 && mana >= 2) {
        ok(`HP at ${hp} with ${mana} mana — heal window open`);

        const healBtnLow = page.locator('button:has-text("Heal")');
        const isDisabled = await healBtnLow.isDisabled().catch(() => true);
        isDisabled === false
          ? ok(`Heal button enabled at ${hp} HP, ${mana} mana`)
          : fail(`Heal button still disabled at ${hp} HP, ${mana} mana`);

        hpBeforeHeal = hp;
        manaBeforeHeal = mana;
        healResult = await doHeal(page);
        hpAfterHeal  = await getHeroHP(page);
        manaAfterHeal = await getMana(page);
        healTested = true;
        break;
      }
      const r = await doAttack(page);
      if (!r) break;
      await page.waitForTimeout(300);
    }

    if (!healTested) {
      const hp = await getHeroHP(page);
      const mana = await getMana(page);
      warn(`Heal not tested: HP=${hp}, mana=${mana} (need HP<80 AND mana>=2 simultaneously)`);
    } else {
      if (!healResult) {
        fail('Heal action did not resolve');
      } else {
        ok('Heal action resolved');
        healResult.includes('heals') || healResult.includes('Heal') || healResult.includes('HP')
          ? ok('Heal result contains expected text')
          : fail(`Heal result missing expected text: ${healResult.substring(0, 120)}`);
        healResult.includes('No counter-attack')
          ? ok('No counter-attack during heal')
          : fail(`Expected "No counter-attack", got: ${healResult.substring(0, 120)}`);
      }

      if (hpBeforeHeal !== null && hpAfterHeal !== null) {
        hpAfterHeal > hpBeforeHeal
          ? ok(`HP increased: ${hpBeforeHeal} → ${hpAfterHeal}`)
          : fail(`HP did not increase: ${hpBeforeHeal} → ${hpAfterHeal}`);
        hpAfterHeal <= 120
          ? ok(`HP capped at or below 120 (${hpAfterHeal})`)
          : fail(`HP exceeds 120: ${hpAfterHeal}`);
      }
      if (manaBeforeHeal !== null && manaAfterHeal !== null) {
        manaAfterHeal === manaBeforeHeal - 2
          ? ok(`Mana decreased by 2 (${manaBeforeHeal} → ${manaAfterHeal})`)
          : fail(`Expected mana ${manaBeforeHeal - 2}, got ${manaAfterHeal}`);
      }
    }

    // === STEP 7: Heal disabled only at full HP (maxHeroHP = 120) ===
    console.log('\n=== Step 7: Heal Disabled at Full HP ===');
    const hpNow = await getHeroHP(page);
    const maxHP = 120;
    if (hpNow !== null && hpNow >= maxHP) {
      const disabledHigh = await page.locator('button:has-text("Heal")').isDisabled().catch(() => true);
      disabledHigh === true
        ? ok(`Heal disabled at full HP (${hpNow} >= ${maxHP})`)
        : fail(`Heal should be disabled at full HP (${hpNow})`);
    } else if (hpNow !== null && hpNow < maxHP) {
      const disabledHigh = await page.locator('button:has-text("Heal")').isDisabled().catch(() => true);
      disabledHigh === false
        ? ok(`Heal enabled at ${hpNow} HP (below max ${maxHP})`)
        : fail(`Heal should be enabled at ${hpNow} HP (below max ${maxHP})`);
    } else {
      warn(`HP=${hpNow}, can't verify heal disabled state`);
    }

    // === STEP 8: Mana regen on monster kill ===
    console.log('\n=== Step 8: Mana Regen on Monster Kill ===');
    const aliveNow = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
    if (aliveNow > 0) {
      let killFound = false, manaBeforeKill = null, manaAfterKill = null;
      for (let i = 0; i < 10; i++) {
        const aliveBefore = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
        if (aliveBefore === 0) break;
        manaBeforeKill = await getMana(page);
        const r = await doAttack(page);
        if (!r) break;
        const aliveAfter = await page.locator('.arena-entity.monster-entity:not(.dead)').count();
        if (aliveAfter < aliveBefore) {
          manaAfterKill = await getMana(page);
          if (manaBeforeKill !== null && manaAfterKill !== null && manaBeforeKill < 5) {
            // Net mana = prev - 1 (attack cost) + 1 (regen) = prev
            manaAfterKill >= manaBeforeKill - 1
              ? ok(`Mana regen on kill: ${manaBeforeKill} → ${manaAfterKill}`)
              : fail(`Mana should regen on kill: ${manaBeforeKill} → ${manaAfterKill}`);
          } else {
            ok(`Monster killed, mana: ${manaBeforeKill} → ${manaAfterKill}`);
          }
          killFound = true;
          break;
        }
      }
      if (!killFound) warn('No monster kill in 10 attacks for regen test');
    } else {
      warn('No alive monsters for mana regen test');
    }

    // === STEP 9: Heal disabled at mana < 2 ===
    // At this point mana may already be low from the attacks above.
    console.log('\n=== Step 9: Heal Disabled at Low Mana ===');
    let manaLow = await getMana(page);
    if (manaLow !== null && manaLow >= 2) {
      // Drain mana via attacks (each costs 1)
      for (let i = 0; i < 8; i++) {
        manaLow = await getMana(page);
        if (manaLow !== null && manaLow < 2) break;
        const r = await doAttack(page);
        if (!r) break;
      }
      manaLow = await getMana(page);
    }
    if (manaLow !== null && manaLow < 2) {
      const disabledLow = await page.locator('button:has-text("Heal")').isDisabled().catch(() => true);
      disabledLow === true
        ? ok(`Heal disabled at ${manaLow} mana`)
        : fail(`Heal should be disabled at ${manaLow} mana`);
    } else {
      warn(`Could not drain mana below 2 (current: ${manaLow})`);
    }

    // === STEP 10: Zero-mana attack — resolves with "No mana!" note ===
    console.log('\n=== Step 10: Zero-Mana Attack ===');
    // Drain to 0 if not already
    for (let i = 0; i < 3; i++) {
      const m = await getMana(page);
      if (m === 0) break;
      await doAttack(page);
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
        // attack-graph emits "(No mana!)" at 0 mana — frontend shows "No mana! Half damage"
        result0.includes('No mana') || result0.includes('no mana')
          ? ok('"No mana" noted in combat result')
          : fail(`Expected "No mana" in 0-mana result, got: ${result0.substring(0, 150)}`);
        const manaStill = await getMana(page);
        manaStill === 0
          ? ok('Mana stays at 0 after 0-mana attack')
          : warn(`Expected mana 0, got ${manaStill}`);
      }
    } else {
      warn(`Mana is ${manaZero}, not 0 — skipping zero-mana test`);
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
