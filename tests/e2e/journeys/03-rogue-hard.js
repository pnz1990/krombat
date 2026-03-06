// Journey 3: Rogue Hard — Dodge & Backstab
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
  console.log('🧪 Journey 3: Rogue Hard — Dodge & Backstab\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j3-${Date.now()}`;
  const { execSync } = require('child_process');
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404'))
      consoleErrors.push(msg.text());
  });

  try {
    // === STEP 1: Create rogue hard dungeon via UI ===
    console.log('=== Step 1: Create Rogue Dungeon ===');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    await page.fill('input[placeholder="my-dungeon"]', dName);
    await page.selectOption('select >> nth=0', 'hard');
    await page.selectOption('select >> nth=1', 'rogue');
    const monsterInput = page.locator('input[type="number"]');
    if (await monsterInput.count() > 0) await monsterInput.fill('3');
    await page.click('button:has-text("Create Dungeon")');
    await page.waitForTimeout(3000);

    for (let i = 0; i < 30; i++) {
      const text = await page.textContent('body');
      if (text.includes('ROGUE') && text.includes(dName)) break;
      await page.waitForTimeout(2000);
    }
    const body = await page.textContent('body');
    body.includes('ROGUE') ? ok('Rogue dungeon created') : fail('Dungeon did not load as rogue');

    // === STEP 2: Verify rogue initial state ===
    console.log('\n=== Step 2: Rogue Initial State ===');
    body.includes('150') ? ok('Hero HP: 150') : fail('Hero HP not 150');

    // Backstab info should be visible
    const backstabText = page.locator('text=Backstab');
    (await backstabText.count()) > 0 ? ok('Backstab display present') : fail('Backstab display missing');
    body.includes('Ready') ? ok('Backstab shows Ready') : warn('Backstab may not show Ready');

    // No heal or taunt buttons
    const healBtn = page.locator('button:has-text("Heal")');
    const tauntBtn = page.locator('button:has-text("Taunt")');
    (await healBtn.count()) === 0 ? ok('No Heal button (rogue only)') : fail('Heal button visible for rogue');
    (await tauntBtn.count()) === 0 ? ok('No Taunt button (rogue only)') : fail('Taunt button visible for rogue');

    // No mana display
    body.includes('Mana:') ? fail('Mana display visible for rogue') : ok('No mana display');

    // Hard difficulty — monsters should have 80 HP
    body.includes('/80') ? ok('Monsters have 80 HP (hard)') : warn('Monster HP may not show /80');

    // === STEP 3: Backstab attack ===
    console.log('\n=== Step 3: Backstab Attack ===');
    // Backstab button should be on monster entity cards
    const backstabBtn = page.locator('button:has-text("Backstab")').first();
    if (await backstabBtn.count() > 0) {
      await backstabBtn.click({ force: true });
      await page.waitForTimeout(1000);

      let resolved = false;
      for (let i = 0; i < 25; i++) {
        const cb = page.locator('button:has-text("Continue")');
        if (await cb.count() > 0) {
          resolved = true;
          const mt = await page.textContent('.combat-modal').catch(() => '');
          mt.includes('Backstab') || mt.includes('3x') || mt.includes('damage')
            ? ok('Backstab result shown')
            : fail(`Backstab result unexpected: ${mt.substring(0, 150)}`);
          await cb.click().catch(() => {});
          await page.waitForTimeout(500);
          break;
        }
        await page.waitForTimeout(3000);
      }
      resolved ? ok('Backstab resolved') : fail('Backstab did not resolve');
    } else {
      fail('Backstab button not found on entity card');
    }

    // === STEP 4: Backstab cooldown ===
    console.log('\n=== Step 4: Backstab Cooldown ===');
    await page.waitForTimeout(2000);
    const bodyAfterBS = await page.textContent('body');
    // Should show cooldown (e.g. "3 CD")
    bodyAfterBS.includes('CD') ? ok('Backstab shows cooldown') : warn('Backstab cooldown text not found');

    // Backstab button should NOT be on entity cards during cooldown
    const backstabBtnCD = page.locator('.arena-entity button:has-text("Backstab")');
    (await backstabBtnCD.count()) === 0 ? ok('Backstab button hidden during cooldown') : fail('Backstab button still visible during cooldown');

    // === STEP 5: Normal attack — cooldown decrements ===
    console.log('\n=== Step 5: Normal Attack + CD Decrement ===');
    const atkBtn = page.locator('.arena-atk-btn.btn-primary').first();
    if (await atkBtn.count() > 0) {
      await atkBtn.click({ force: true });
      await page.waitForTimeout(1000);
      for (let i = 0; i < 25; i++) {
        const cb = page.locator('button:has-text("Continue")');
        if (await cb.count() > 0) {
          const mt = await page.textContent('.combat-modal').catch(() => '');
          mt.includes('damage') || mt.includes('HP') ? ok('Normal attack resolved') : fail('Normal attack empty');
          await cb.click().catch(() => {});
          break;
        }
        await page.waitForTimeout(3000);
      }

      // Check cooldown decremented (3 → 2)
      await page.waitForTimeout(1000);
      const bodyAfterAtk = await page.textContent('body');
      bodyAfterAtk.includes('2 CD') ? ok('Backstab cooldown decremented to 2') : warn('Cooldown may not show 2 CD yet');
    } else {
      warn('All monsters dead from backstab (3x on hard can one-shot)');
    }

    // === STEP 6: Verify dodge mechanic via kubectl ===
    console.log('\n=== Step 6: Dodge Mechanic ===');
    // We can't guarantee dodge procs, but we can verify the rogue class is applied
    // Check the dungeon spec to confirm rogue class
    const res = await api(page, 'GET', `/dungeons/default/${dName}`);
    res.status === 200 && res.body?.spec?.heroClass === 'rogue'
      ? ok('Dungeon confirms rogue class')
      : fail('Dungeon heroClass not rogue');

    // Verify backstabCooldown is tracked in spec
    const cd = res.body?.spec?.backstabCooldown;
    typeof cd === 'number' ? ok(`Backstab cooldown in spec: ${cd}`) : fail('backstabCooldown not in spec');

    // === STEP 7: Backstab ready after cooldown expires ===
    console.log('\n=== Step 7: Backstab Ready After Cooldown ===');
    // Patch cooldown to 0 to test re-availability
    execSync(`kubectl patch dungeon ${dName} --type=merge -p '{"spec":{"backstabCooldown":0}}'`);
    await page.waitForTimeout(5000);
    await page.goto(`${BASE_URL}/dungeon/default/${dName}`, { timeout: TIMEOUT });
    await page.waitForTimeout(5000);

    const bodyReady = await page.textContent('body');
    bodyReady.includes('Ready') ? ok('Backstab shows Ready after cooldown reset') : warn('Backstab Ready text not found');

    // Backstab button should reappear on entity cards
    const backstabBtn2 = page.locator('.arena-entity button:has-text("Backstab")');
    (await backstabBtn2.count()) > 0 ? ok('Backstab button reappears when ready') : warn('Backstab button not visible yet');

    // === STEP 8: Hard difficulty dice ===
    console.log('\n=== Step 8: Hard Difficulty ===');
    // Dice formula should be 3d20+5
    const diceText = await page.textContent('body');
    diceText.includes('3d20+5') ? ok('Dice formula: 3d20+5 (hard)') : warn('Dice formula not found');

    // Boss should have 800 HP
    // Boss is pending so not visible, check via API
    const dungeonState = await api(page, 'GET', `/dungeons/default/${dName}`);
    dungeonState.body?.spec?.bossHP === 800
      ? ok('Boss HP: 800 (hard)')
      : fail(`Boss HP: ${dungeonState.body?.spec?.bossHP} (expected 800)`);

    // === STEP 9: Second backstab ===
    console.log('\n=== Step 9: Second Backstab ===');
    const backstabBtn3 = page.locator('.arena-entity button:has-text("Backstab")').first();
    if (await backstabBtn3.count() > 0) {
      await backstabBtn3.click({ force: true });
      await page.waitForTimeout(1000);
      let resolved2 = false;
      for (let i = 0; i < 25; i++) {
        const cb = page.locator('button:has-text("Continue")');
        if (await cb.count() > 0) {
          resolved2 = true;
          const mt = await page.textContent('.combat-modal').catch(() => '');
          mt.includes('Backstab') || mt.includes('3x') || mt.includes('damage')
            ? ok('Second backstab has result')
            : warn('Second backstab result unclear');
          await cb.click().catch(() => {});
          break;
        }
        await page.waitForTimeout(3000);
      }
      resolved2 ? ok('Second backstab resolved') : fail('Second backstab did not resolve');

      // Cooldown should be back to 3
      await page.waitForTimeout(1000);
      const bodyAfterBS2 = await page.textContent('body');
      bodyAfterBS2.includes('3 CD') ? ok('Backstab cooldown reset to 3') : warn('Cooldown may not show 3 CD');
    } else {
      warn('Backstab button not available for second test');
    }

    // === STEP 10: Console errors ===
    console.log('\n=== Step 10: Console Errors ===');
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
  console.log(`  Journey 3: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
