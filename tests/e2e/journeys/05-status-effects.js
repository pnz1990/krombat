// Journey 5: Status Effects — Poison, Burn, Stun
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

async function attackAndDismiss(page) {
  const atkBtn = page.locator('.arena-atk-btn.btn-primary').first();
  if (await atkBtn.count() === 0) return null;
  await atkBtn.click({ force: true });
  await page.waitForTimeout(1000);
  for (let i = 0; i < 25; i++) {
    const cb = page.locator('button:has-text("Continue")');
    if (await cb.count() > 0) {
      const mt = await page.textContent('.combat-modal').catch(() => '');
      await cb.click().catch(() => {});
      await page.waitForTimeout(500);
      return mt;
    }
    await page.waitForTimeout(3000);
  }
  return null;
}

async function run() {
  console.log('🧪 Journey 5: Status Effects\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const { execSync } = require('child_process');
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404'))
      consoleErrors.push(msg.text());
  });

  // Use separate dungeons per effect to avoid state bleed
  const dungeons = [];
  const cleanup = async () => { for (const d of dungeons) await api(page, 'DELETE', `/dungeons/default/${d}`); };

  try {
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // === STEP 1: Poison ===
    console.log('=== Step 1: Poison Effect ===');
    const d1 = `j5-psn-${Date.now()}`;
    dungeons.push(d1);
    await api(page, 'POST', '/dungeons', { name: d1, monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    await waitForSpec(page, d1, d => d.spec?.monsterHP?.length === 2);

    // Set poison
    execSync(`kubectl patch dungeon ${d1} --type=merge -p '{"spec":{"poisonTurns":3}}'`);
    const poisoned = await waitForSpec(page, d1, d => d.spec?.poisonTurns === 3);
    poisoned ? ok('Poison set to 3 turns') : fail('Poison patch failed');

    // Navigate and check badge
    await page.goto(`${BASE_URL}/dungeon/default/${d1}`, { timeout: TIMEOUT });
    await page.waitForTimeout(5000);
    const poisonBadges = page.locator('.status-badge.effect');
    (await poisonBadges.count()) > 0 ? ok('Poison badge visible') : warn('Poison badge not found');

    // Attack — poison should tick and deal damage
    const hpBefore = poisoned.spec.heroHP;
    const mt1 = await attackAndDismiss(page);
    mt1 ? ok('Attack resolved') : fail('Attack did not resolve');
    if (mt1 && (mt1.includes('Poison') || mt1.includes('poison') || mt1.includes('-5')))
      ok('Combat mentions poison');
    else warn('Poison not mentioned in combat result');

    await page.waitForTimeout(1000);
    const afterPoison = await api(page, 'GET', `/dungeons/default/${d1}`);
    const pt = afterPoison.body?.spec?.poisonTurns;
    pt < 3 ? ok(`Poison decremented: 3→${pt}`) : fail(`Poison not decremented: ${pt}`);
    afterPoison.body?.spec?.heroHP < hpBefore
      ? ok(`HP decreased: ${hpBefore}→${afterPoison.body.spec.heroHP}`)
      : warn('HP did not decrease');

    // === STEP 2: Burn ===
    console.log('\n=== Step 2: Burn Effect ===');
    const d2 = `j5-brn-${Date.now()}`;
    dungeons.push(d2);
    await api(page, 'POST', '/dungeons', { name: d2, monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    await waitForSpec(page, d2, d => d.spec?.monsterHP?.length === 2);

    execSync(`kubectl patch dungeon ${d2} --type=merge -p '{"spec":{"burnTurns":2}}'`);
    const burned = await waitForSpec(page, d2, d => d.spec?.burnTurns === 2);
    burned ? ok('Burn set to 2 turns') : fail('Burn patch failed');

    await page.goto(`${BASE_URL}/dungeon/default/${d2}`, { timeout: TIMEOUT });
    await page.waitForTimeout(5000);

    const hpBeforeBurn = burned.spec.heroHP;
    const mt2 = await attackAndDismiss(page);
    mt2 ? ok('Attack resolved') : fail('Attack did not resolve');
    if (mt2 && (mt2.includes('Burn') || mt2.includes('burn') || mt2.includes('-8')))
      ok('Combat mentions burn');
    else warn('Burn not mentioned in combat result');

    await page.waitForTimeout(1000);
    const afterBurn = await api(page, 'GET', `/dungeons/default/${d2}`);
    const bt = afterBurn.body?.spec?.burnTurns;
    bt < 2 ? ok(`Burn decremented: 2→${bt}`) : fail(`Burn not decremented: ${bt}`);
    afterBurn.body?.spec?.heroHP < hpBeforeBurn
      ? ok(`HP decreased with burn: ${hpBeforeBurn}→${afterBurn.body.spec.heroHP}`)
      : warn('HP did not decrease with burn');

    // === STEP 3: Stun ===
    console.log('\n=== Step 3: Stun Effect ===');
    const d3 = `j5-stn-${Date.now()}`;
    dungeons.push(d3);
    await api(page, 'POST', '/dungeons', { name: d3, monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    await waitForSpec(page, d3, d => d.spec?.monsterHP?.length === 2);

    // Set stun and record attackSeq
    const preStun = await api(page, 'GET', `/dungeons/default/${d3}`);
    const seqBefore = preStun.body?.spec?.attackSeq || 0;
    execSync(`kubectl patch dungeon ${d3} --type=merge -p '{"spec":{"stunTurns":1}}'`);
    const stunned = await waitForSpec(page, d3, d => d.spec?.stunTurns === 1);
    stunned ? ok('Stun set to 1 turn') : fail('Stun patch failed');

    const monsterHPBefore = stunned.spec.monsterHP;
    await page.goto(`${BASE_URL}/dungeon/default/${d3}`, { timeout: TIMEOUT });
    await page.waitForTimeout(5000);

    const mt3 = await attackAndDismiss(page);
    mt3 ? ok('Attack resolved while stunned') : fail('Stunned attack did not resolve');
    if (mt3 && (mt3.includes('STUNNED') || mt3.includes('stunned') || mt3.includes('Stun')))
      ok('Combat shows STUNNED');
    else fail(`Stun not shown: ${(mt3 || '').substring(0, 120)}`);

    await page.waitForTimeout(1000);
    const afterStun = await api(page, 'GET', `/dungeons/default/${d3}`);
    afterStun.body?.spec?.stunTurns === 0 ? ok('Stun consumed: 1→0') : fail(`Stun: ${afterStun.body?.spec?.stunTurns}`);
    JSON.stringify(afterStun.body?.spec?.monsterHP) === JSON.stringify(monsterHPBefore)
      ? ok(`Monster HP unchanged while stunned: ${JSON.stringify(monsterHPBefore)}`)
      : warn(`Monster HP changed during stun: ${JSON.stringify(monsterHPBefore)}→${JSON.stringify(afterStun.body?.spec?.monsterHP)}`);

    // === STEP 4: Multiple effects simultaneously ===
    console.log('\n=== Step 4: Multiple Effects ===');
    const d4 = `j5-multi-${Date.now()}`;
    dungeons.push(d4);
    await api(page, 'POST', '/dungeons', { name: d4, monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    await waitForSpec(page, d4, d => d.spec?.monsterHP?.length === 2);

    execSync(`kubectl patch dungeon ${d4} --type=merge -p '{"spec":{"poisonTurns":2,"burnTurns":1,"stunTurns":1}}'`);
    const multi = await waitForSpec(page, d4, d => d.spec?.poisonTurns === 2 && d.spec?.burnTurns === 1 && d.spec?.stunTurns === 1);
    multi ? ok('All 3 effects set') : fail('Multi-effect patch failed');

    await page.goto(`${BASE_URL}/dungeon/default/${d4}`, { timeout: TIMEOUT });
    await page.waitForTimeout(5000);
    const multiBadges = page.locator('.status-badge.effect');
    (await multiBadges.count()) >= 3 ? ok(`${await multiBadges.count()} status badges visible`) : warn(`${await multiBadges.count()} badges (expected 3)`);

    const mt4 = await attackAndDismiss(page);
    if (mt4 && mt4.includes('STUNNED')) ok('Stunned with multiple effects active');
    else warn('Stun text not found with multi-effects');

    await page.waitForTimeout(1000);
    const afterMulti = await api(page, 'GET', `/dungeons/default/${d4}`);
    const s = afterMulti.body?.spec;
    s?.stunTurns === 0 ? ok('Stun consumed in multi-effect') : warn(`Stun: ${s?.stunTurns}`);
    s?.poisonTurns < 2 ? ok(`Poison ticked in multi-effect: ${s.poisonTurns}`) : warn(`Poison: ${s?.poisonTurns}`);
    s?.burnTurns < 1 ? ok(`Burn ticked in multi-effect: ${s.burnTurns}`) : warn(`Burn: ${s?.burnTurns}`);

    // === STEP 5: Effects expire — no badges ===
    console.log('\n=== Step 5: Effects Expire ===');
    execSync(`kubectl patch dungeon ${d4} --type=merge -p '{"spec":{"poisonTurns":0,"burnTurns":0,"stunTurns":0}}'`);
    await waitForSpec(page, d4, d => d.spec?.poisonTurns === 0 && d.spec?.burnTurns === 0 && d.spec?.stunTurns === 0);
    await page.goto(`${BASE_URL}/dungeon/default/${d4}`, { timeout: TIMEOUT });
    await page.waitForTimeout(5000);
    const finalBadges = page.locator('.status-badge.effect');
    (await finalBadges.count()) === 0 ? ok('No status badges when effects expired') : warn(`${await finalBadges.count()} badges still visible`);

    // === STEP 6: Console errors ===
    console.log('\n=== Step 6: Console Errors ===');
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
  console.log(`  Journey 5: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('='.repeat(50));
  process.exit(failed > 0 ? 1 : 0);
}

run();
