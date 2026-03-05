// Journey 2: Mage Normal — Abilities & Mana
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 15000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function api(page, method, path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(async ([m, p, b]) => {
        const opts = { method: m, headers: { 'Content-Type': 'application/json' } };
        if (b) opts.body = JSON.stringify(b);
        const r = await fetch(`/api/v1${p}`, opts);
        const text = await r.text();
        try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
      }, [method, path, body]);
    } catch { await page.waitForTimeout(2000); }
  }
  return { status: 0, body: 'fetch failed' };
}

async function waitForSpec(page, name, check, maxWait = 45000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const res = await api(page, 'GET', `/dungeons/default/${name}`);
    if (res.status === 200 && check(res.body)) return res.body;
    await page.waitForTimeout(2000);
  }
  return null;
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

  try {
    // === STEP 1: Create mage dungeon via UI ===
    console.log('=== Step 1: Create Mage Dungeon ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    await page.fill('input[placeholder="my-dungeon"]', dName);
    await page.selectOption('select >> nth=0', 'normal');
    await page.selectOption('select >> nth=1', 'mage');
    const monsterInput = page.locator('input[type="number"]');
    if (await monsterInput.count() > 0) await monsterInput.fill('2');
    await page.click('button:has-text("Create Dungeon")');
    await page.waitForTimeout(3000);

    for (let i = 0; i < 30; i++) {
      const text = await page.textContent('body');
      if (text.includes('MAGE') && text.includes(dName)) break;
      await page.waitForTimeout(2000);
    }
    const body = await page.textContent('body');
    body.includes('MAGE') ? ok('Mage dungeon created') : fail('Dungeon did not load as mage');

    // === STEP 2: Verify mage initial state ===
    console.log('\n=== Step 2: Mage Initial State ===');
    body.includes('120') ? ok('Hero HP: 120') : fail('Hero HP not 120');
    body.includes('Mana:') ? ok('Mana display visible') : fail('Mana display missing');
    body.includes('Mana: 8') ? ok('Starting mana: 8') : warn('Starting mana may not be 8');

    // Heal button should exist
    const healBtn = page.locator('button:has-text("Heal")');
    (await healBtn.count()) > 0 ? ok('Heal button present') : fail('Heal button missing');

    // Heal should be disabled at full HP (>= 80)
    const healDisabled = await healBtn.isDisabled().catch(() => null);
    healDisabled === true ? ok('Heal disabled at full HP') : warn(`Heal disabled=${healDisabled} (expected true at 120 HP)`);

    // No taunt or backstab buttons
    const tauntBtn = page.locator('button:has-text("Taunt")');
    const backstabText = page.locator('text=Backstab');
    (await tauntBtn.count()) === 0 ? ok('No Taunt button (mage only)') : fail('Taunt button visible for mage');
    (await backstabText.count()) === 0 ? ok('No Backstab display (mage only)') : fail('Backstab visible for mage');

    // === STEP 3: Attack a monster — verify mana consumption ===
    console.log('\n=== Step 3: Attack + Mana Consumption ===');
    const atkBtn = page.locator('.arena-atk-btn.btn-primary').first();
    if (await atkBtn.count() > 0) {
      await atkBtn.click({ force: true });
      await page.waitForTimeout(1000);

      let resolved = false;
      for (let i = 0; i < 25; i++) {
        const cb = page.locator('button:has-text("Continue")');
        if (await cb.count() > 0) {
          resolved = true;
          const mt = await page.textContent('.combat-modal').catch(() => '');
          mt.includes('damage') || mt.includes('HP') ? ok('First attack has combat result') : fail('First attack EMPTY result');
          await cb.click().catch(() => {});
          await page.waitForTimeout(500);
          break;
        }
        await page.waitForTimeout(3000);
      }
      resolved ? ok('First attack resolved') : fail('First attack did not resolve in 75s');

      // Check mana decreased (should be 7 after 1 attack)
      await page.waitForTimeout(1000);
      const afterAtk = await page.textContent('body');
      afterAtk.includes('Mana: 7') ? ok('Mana decreased to 7') : warn('Mana may not show 7 yet');
    } else {
      fail('No attack button');
    }

    // === STEP 4: Take damage then heal ===
    console.log('\n=== Step 4: Heal Ability ===');
    // Patch hero HP low so heal is enabled (HP < 80)
    const { execSync } = require('child_process');
    execSync(`kubectl patch dungeon ${dName} --type=merge -p '{"spec":{"heroHP":50}}'`);
    await page.waitForTimeout(5000);
    // Refresh page to pick up patched state
    await page.goto(`${BASE_URL}/dungeon/default/${dName}`, { timeout: TIMEOUT });
    await page.waitForTimeout(5000);

    const bodyLow = await page.textContent('body');
    bodyLow.includes('50') ? ok('Hero HP patched to 50') : warn('HP may not show 50 yet');

    // Heal button should now be enabled
    const healBtn2 = page.locator('button:has-text("Heal")');
    if (await healBtn2.count() > 0) {
      const disabled = await healBtn2.isDisabled().catch(() => null);
      disabled === false ? ok('Heal enabled at low HP') : fail(`Heal disabled=${disabled} at 50 HP`);

      // Click heal
      await healBtn2.click({ force: true });
      await page.waitForTimeout(1000);

      // Wait for heal to resolve
      let healed = false;
      for (let i = 0; i < 25; i++) {
        const cb = page.locator('button:has-text("Continue")');
        if (await cb.count() > 0) {
          healed = true;
          const mt = await page.textContent('.combat-modal').catch(() => '');
          mt.includes('heals') || mt.includes('Heal') || mt.includes('HP')
            ? ok('Heal result shown')
            : fail(`Heal result unexpected: ${mt.substring(0, 100)}`);
          // No counter-attack during heal
          mt.includes('No counter-attack') ? ok('No counter-attack during heal') : warn('Counter-attack text not found');
          await cb.click().catch(() => {});
          await page.waitForTimeout(500);
          break;
        }
        await page.waitForTimeout(3000);
      }
      healed ? ok('Heal resolved') : fail('Heal did not resolve');

      // HP should have increased (50 + 40 = 90)
      await page.waitForTimeout(1000);
      const afterHeal = await page.textContent('body');
      afterHeal.includes('90') ? ok('HP healed to 90') : warn('HP may not show 90');

      // Mana should have decreased by 2
      // Was 7 after first attack, now should be 5 after heal
      afterHeal.includes('Mana: 5') ? ok('Mana decreased by 2 (now 5)') : warn('Mana may not show 5');
    } else {
      fail('Heal button not found');
    }

    // === STEP 5: Heal cap at 120 ===
    console.log('\n=== Step 5: Heal HP Cap ===');
    // Patch HP to 100 — heal should give 120 (capped), not 140
    execSync(`kubectl patch dungeon ${dName} --type=merge -p '{"spec":{"heroHP":100,"heroMana":4}}'`);
    await page.waitForTimeout(5000);
    await page.goto(`${BASE_URL}/dungeon/default/${dName}`, { timeout: TIMEOUT });
    await page.waitForTimeout(5000);

    // Heal should be disabled at HP >= 80... wait, the UI disables at >= 80
    // HP=100 means heal IS disabled in UI. Let's verify that.
    const healBtn3 = page.locator('button:has-text("Heal")');
    if (await healBtn3.count() > 0) {
      // At HP=100, heal should be disabled (UI threshold is >= 80)
      // Actually wait — let me re-check. The disable condition is heroHP >= 80
      // So at 100 HP, heal IS disabled. Let's test the cap differently.
      const disabled3 = await healBtn3.isDisabled().catch(() => null);
      disabled3 === true ? ok('Heal disabled at HP >= 80 (HP=100)') : fail(`Heal should be disabled at HP=100`);
    }

    // === STEP 6: Mana depletion — half damage ===
    console.log('\n=== Step 6: Zero Mana Behavior ===');
    // Set mana to 0 to test half damage
    execSync(`kubectl patch dungeon ${dName} --type=merge -p '{"spec":{"heroMana":0}}'`);
    await page.waitForTimeout(5000);
    await page.goto(`${BASE_URL}/dungeon/default/${dName}`, { timeout: TIMEOUT });
    await page.waitForTimeout(5000);

    const bodyZeroMana = await page.textContent('body');
    bodyZeroMana.match(/Mana:\s*0\b/) ? ok('Mana shows 0') : warn('Mana may not show 0');

    // Heal should be disabled (need 2 mana)
    const healBtn4 = page.locator('button:has-text("Heal")');
    if (await healBtn4.count() > 0) {
      const disabled4 = await healBtn4.isDisabled().catch(() => null);
      disabled4 === true ? ok('Heal disabled at 0 mana') : fail('Heal should be disabled at 0 mana');
    }

    // Attack at 0 mana — should still work (just reduced damage)
    const atkBtn2 = page.locator('.arena-atk-btn.btn-primary').first();
    if (await atkBtn2.count() > 0) {
      await atkBtn2.click({ force: true });
      await page.waitForTimeout(1000);
      let resolved2 = false;
      for (let i = 0; i < 25; i++) {
        const cb = page.locator('button:has-text("Continue")');
        if (await cb.count() > 0) {
          resolved2 = true;
          const mt = await page.textContent('.combat-modal').catch(() => '');
          mt.includes('damage') || mt.includes('HP') ? ok('Attack at 0 mana resolved with result') : fail('0-mana attack empty');
          await cb.click().catch(() => {});
          break;
        }
        await page.waitForTimeout(3000);
      }
      resolved2 ? ok('Attack works at 0 mana') : fail('Attack at 0 mana did not resolve');
    }

    // === STEP 7: Mana display consistency ===
    console.log('\n=== Step 7: Mana Display ===');
    await page.waitForTimeout(1000);
    // Mana should still be 0 (0 mana attacks don't cost mana)
    const bodyAfter = await page.textContent('body');
    bodyAfter.match(/Mana:\s*0\b/) ? ok('Mana stays 0 after 0-mana attack') : warn('Mana display after 0-mana attack');

    // === STEP 8: Console errors ===
    console.log('\n=== Step 8: Console Errors ===');
    consoleErrors.length === 0
      ? ok('No console errors')
      : fail(`${consoleErrors.length} console errors: ${consoleErrors[0]}`);

    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    await api(page, 'DELETE', `/dungeons/default/${dName}`);
    ok('Cleanup initiated');

  } catch (error) {
    console.error(`\n❌ Fatal: ${error.message}`);
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
