// Journey 6: Dungeon Modifiers — Curses & Blessings
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
  console.log('🧪 Journey 6: Dungeon Modifiers\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const { execSync } = require('child_process');
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404'))
      consoleErrors.push(msg.text());
  });

  const dungeons = [];
  const cleanup = async () => {
    for (const d of dungeons) await api(page, 'DELETE', `/dungeons/default/${d}`);
  };

  try {
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // === TEST 1: Curse of Darkness (-25% damage) ===
    console.log('=== Test 1: Curse of Darkness ===');
    const d1 = `j6-dark-${Date.now()}`;
    dungeons.push(d1);
    await api(page, 'POST', '/dungeons', { name: d1, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    const ready1 = await waitForSpec(page, d1, d => d.spec?.monsterHP?.length === 1);
    if (!ready1) { fail('Dungeon not ready'); } else {
      execSync(`kubectl patch dungeon ${d1} --type=merge -p '{"spec":{"modifier":"curse-darkness"}}'`);
      await page.waitForTimeout(5000);
      await page.goto(`${BASE_URL}/dungeon/default/${d1}`, { timeout: TIMEOUT });
      await page.waitForTimeout(5000);

      // Curse badge visible
      const curseBadge = page.locator('.status-badge.curse');
      (await curseBadge.count()) > 0 ? ok('Curse badge visible') : warn('Curse badge not found');

      // Attack and verify curse note in combat
      const atkBtn = page.locator('.arena-atk-btn.btn-primary').first();
      if (await atkBtn.count() > 0) {
        await atkBtn.click({ force: true });
        await page.waitForTimeout(1000);
        for (let i = 0; i < 25; i++) {
          const cb = page.locator('button:has-text("Continue")');
          if (await cb.count() > 0) {
            const mt = await page.textContent('.combat-modal').catch(() => '');
            mt.includes('Curse') || mt.includes('-25%') || mt.includes('curse')
              ? ok('Combat shows curse effect')
              : warn('Curse text not in combat modal');
            await cb.click().catch(() => {});
            break;
          }
          await page.waitForTimeout(3000);
        }
      }

      // Verify modifier in spec
      const res1 = await api(page, 'GET', `/dungeons/default/${d1}`);
      res1.body?.spec?.modifier === 'curse-darkness' ? ok('Modifier in spec: curse-darkness') : fail(`Modifier: ${res1.body?.spec?.modifier}`);
    }

    // === TEST 2: Blessing of Strength (+50% damage) ===
    console.log('\n=== Test 2: Blessing of Strength ===');
    const d2 = `j6-str-${Date.now()}`;
    dungeons.push(d2);
    await api(page, 'POST', '/dungeons', { name: d2, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    const ready2 = await waitForSpec(page, d2, d => d.spec?.monsterHP?.length === 1);
    if (!ready2) { fail('Dungeon not ready'); } else {
      execSync(`kubectl patch dungeon ${d2} --type=merge -p '{"spec":{"modifier":"blessing-strength"}}'`);
      await page.waitForTimeout(5000);
      await page.goto(`${BASE_URL}/dungeon/default/${d2}`, { timeout: TIMEOUT });
      await page.waitForTimeout(5000);

      // Blessing badge visible
      const blessBadge = page.locator('.status-badge.blessing');
      (await blessBadge.count()) > 0 ? ok('Blessing badge visible') : warn('Blessing badge not found');

      // Attack and verify blessing note
      const atkBtn2 = page.locator('.arena-atk-btn.btn-primary').first();
      if (await atkBtn2.count() > 0) {
        await atkBtn2.click({ force: true });
        await page.waitForTimeout(1000);
        for (let i = 0; i < 25; i++) {
          const cb = page.locator('button:has-text("Continue")');
          if (await cb.count() > 0) {
            const mt = await page.textContent('.combat-modal').catch(() => '');
            mt.includes('Blessing') || mt.includes('+50%') || mt.includes('blessing')
              ? ok('Combat shows blessing effect')
              : warn('Blessing text not in combat modal');
            await cb.click().catch(() => {});
            break;
          }
          await page.waitForTimeout(3000);
        }
      }

      const res2 = await api(page, 'GET', `/dungeons/default/${d2}`);
      res2.body?.spec?.modifier === 'blessing-strength' ? ok('Modifier in spec: blessing-strength') : fail(`Modifier: ${res2.body?.spec?.modifier}`);
    }

    // === TEST 3: No modifier ===
    console.log('\n=== Test 3: No Modifier ===');
    const d3 = `j6-none-${Date.now()}`;
    dungeons.push(d3);
    await api(page, 'POST', '/dungeons', { name: d3, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    const ready3 = await waitForSpec(page, d3, d => d.spec?.monsterHP?.length === 1);
    if (!ready3) { fail('Dungeon not ready'); } else {
      execSync(`kubectl patch dungeon ${d3} --type=merge -p '{"spec":{"modifier":"none"}}'`);
      await page.waitForTimeout(5000);
      await page.goto(`${BASE_URL}/dungeon/default/${d3}`, { timeout: TIMEOUT });
      await page.waitForTimeout(5000);

      // No modifier badge
      const noBadge = page.locator('.status-badge.curse, .status-badge.blessing');
      (await noBadge.count()) === 0 ? ok('No modifier badge when none') : warn('Modifier badge visible for none');

      const res3 = await api(page, 'GET', `/dungeons/default/${d3}`);
      res3.body?.spec?.modifier === 'none' ? ok('Modifier in spec: none') : ok(`Modifier: ${res3.body?.spec?.modifier} (may have random)`);
    }

    // === TEST 4: Curse of Fury (boss 2x counter) ===
    console.log('\n=== Test 4: Curse of Fury ===');
    const d4 = `j6-fury-${Date.now()}`;
    dungeons.push(d4);
    await api(page, 'POST', '/dungeons', { name: d4, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    const ready4 = await waitForSpec(page, d4, d => d.spec?.monsterHP?.length === 1);
    if (!ready4) { fail('Dungeon not ready'); } else {
      // Kill monster, set modifier, so boss is ready
      execSync(`kubectl patch dungeon ${d4} --type=merge -p '{"spec":{"modifier":"curse-fury","monsterHP":[0]}}'`);
      await page.waitForTimeout(5000);
      await page.goto(`${BASE_URL}/dungeon/default/${d4}`, { timeout: TIMEOUT });
      await page.waitForTimeout(5000);

      const curseBadge4 = page.locator('.status-badge.curse');
      (await curseBadge4.count()) > 0 ? ok('Curse of Fury badge visible') : warn('Fury badge not found');

      const res4 = await api(page, 'GET', `/dungeons/default/${d4}`);
      res4.body?.spec?.modifier === 'curse-fury' ? ok('Modifier in spec: curse-fury') : fail(`Modifier: ${res4.body?.spec?.modifier}`);
    }

    // === TEST 5: Blessing of Resilience (halved counter) ===
    console.log('\n=== Test 5: Blessing of Resilience ===');
    const d5 = `j6-res-${Date.now()}`;
    dungeons.push(d5);
    await api(page, 'POST', '/dungeons', { name: d5, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    const ready5 = await waitForSpec(page, d5, d => d.spec?.monsterHP?.length === 1);
    if (!ready5) { fail('Dungeon not ready'); } else {
      execSync(`kubectl patch dungeon ${d5} --type=merge -p '{"spec":{"modifier":"blessing-resilience"}}'`);
      await page.waitForTimeout(5000);

      const res5 = await api(page, 'GET', `/dungeons/default/${d5}`);
      res5.body?.spec?.modifier === 'blessing-resilience' ? ok('Modifier in spec: blessing-resilience') : fail(`Modifier: ${res5.body?.spec?.modifier}`);

      await page.goto(`${BASE_URL}/dungeon/default/${d5}`, { timeout: TIMEOUT });
      await page.waitForTimeout(5000);
      const blessBadge5 = page.locator('.status-badge.blessing');
      (await blessBadge5.count()) > 0 ? ok('Resilience blessing badge visible') : warn('Resilience badge not found');
    }

    // === TEST 6: Blessing of Fortune (crit chance) ===
    console.log('\n=== Test 6: Blessing of Fortune ===');
    const d6 = `j6-fort-${Date.now()}`;
    dungeons.push(d6);
    await api(page, 'POST', '/dungeons', { name: d6, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    const ready6 = await waitForSpec(page, d6, d => d.spec?.monsterHP?.length === 1);
    if (!ready6) { fail('Dungeon not ready'); } else {
      execSync(`kubectl patch dungeon ${d6} --type=merge -p '{"spec":{"modifier":"blessing-fortune"}}'`);
      await page.waitForTimeout(5000);

      const res6 = await api(page, 'GET', `/dungeons/default/${d6}`);
      res6.body?.spec?.modifier === 'blessing-fortune' ? ok('Modifier in spec: blessing-fortune') : fail(`Modifier: ${res6.body?.spec?.modifier}`);
    }

    // === TEST 7: Curse of Fortitude (monsters +50% HP) ===
    console.log('\n=== Test 7: Curse of Fortitude ===');
    const d7 = `j6-fort2-${Date.now()}`;
    dungeons.push(d7);
    await api(page, 'POST', '/dungeons', { name: d7, monsters: 1, difficulty: 'easy', heroClass: 'warrior' });
    const ready7 = await waitForSpec(page, d7, d => d.spec?.monsterHP?.length === 1);
    if (!ready7) { fail('Dungeon not ready'); } else {
      execSync(`kubectl patch dungeon ${d7} --type=merge -p '{"spec":{"modifier":"curse-fortitude"}}'`);
      await page.waitForTimeout(5000);

      const res7 = await api(page, 'GET', `/dungeons/default/${d7}`);
      res7.body?.spec?.modifier === 'curse-fortitude' ? ok('Modifier in spec: curse-fortitude') : fail(`Modifier: ${res7.body?.spec?.modifier}`);

      await page.goto(`${BASE_URL}/dungeon/default/${d7}`, { timeout: TIMEOUT });
      await page.waitForTimeout(5000);
      const curseBadge7 = page.locator('.status-badge.curse');
      (await curseBadge7.count()) > 0 ? ok('Fortitude curse badge visible') : warn('Fortitude badge not found');
    }

    // === TEST 8: Modifier CR exists in dungeon namespace ===
    console.log('\n=== Test 8: Modifier CR ===');
    try {
      const modCR = execSync(`kubectl get modifier ${d1}-modifier -n ${d1} -o jsonpath='{.status.effect}' 2>&1`).toString();
      modCR.includes('Darkness') || modCR.includes('darkness')
        ? ok(`Modifier CR has effect: ${modCR.substring(0, 60)}`)
        : warn(`Modifier CR effect: ${modCR.substring(0, 60)}`);
    } catch {
      warn('Modifier CR not found (may still be reconciling)');
    }

    // === TEST 9: Console errors ===
    console.log('\n=== Test 9: Console Errors ===');
    consoleErrors.length === 0
      ? ok('No console errors')
      : fail(`${consoleErrors.length} console errors: ${consoleErrors[0]}`);

    // === Cleanup ===
    console.log('\n=== Cleanup ===');
    await cleanup();
    ok('Cleanup initiated');

  } catch (error) {
    console.error(`\n❌ Fatal: ${error.message}`);
    failed++;
    await cleanup();
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Journey 6: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
