// Shared helpers for UI-only journey tests
// NO kubectl, NO direct API calls — everything through the browser UI

async function createDungeonUI(page, name, { monsters = 2, difficulty = 'easy', heroClass = 'warrior' } = {}) {
  // Dismiss onboarding overlay if present — it intercepts pointer events for new browser sessions
  const skipBtn = page.locator('button.kro-onboard-skip');
  if (await skipBtn.count() > 0) {
    await skipBtn.click();
    await page.waitForTimeout(400);
  }
  await page.fill('input[placeholder="my-dungeon"]', name);
  await page.selectOption('select >> nth=0', difficulty);
  await page.selectOption('select >> nth=1', heroClass);
  const monsterInput = page.locator('input[type="number"]');
  if (await monsterInput.count() > 0) await monsterInput.fill(String(monsters));
  await page.click('button:has-text("Create Dungeon")');
  // Wait for dungeon view to load (not stuck on list or "Initializing")
  for (let i = 0; i < 60; i++) {
    const text = await page.textContent('body');
    if (text.includes(heroClass.toUpperCase()) && text.includes(name)) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

async function attackMonster(page, index = 0) {
  // Click the dice button on the Nth alive monster in the arena
  const btns = page.locator('.arena-entity.monster-entity:not(.dead) .arena-atk-btn.btn-primary');
  const count = await btns.count();
  if (count === 0) return null;
  const btn = btns.nth(Math.min(index, count - 1));
  await btn.click({ force: true });
  return waitForCombatResult(page);
}

async function attackBoss(page) {
  const btn = page.locator('.arena-entity.boss-entity .arena-atk-btn.btn-primary');
  if (await btn.count() === 0) return null;
  await btn.click({ force: true });
  return waitForCombatResult(page);
}

async function useAbility(page, abilityName) {
  // Heal, Taunt, or Backstab (arena inline button)
  if (abilityName === 'Backstab') {
    const btn = page.locator('.arena-entity:not(.dead) button:has-text("Backstab")').first();
    if (await btn.count() === 0) return null;
    await btn.click({ force: true });
  } else {
    const btn = page.locator(`button:has-text("${abilityName}")`);
    if (await btn.count() === 0) return null;
    await btn.click({ force: true });
  }
  return waitForCombatResult(page);
}

async function useBackpackItem(page, itemText) {
  const slot = page.locator(`.backpack-slot:has-text("${itemText}")`).first();
  if (await slot.count() === 0) {
    // Try by partial match on the slot content
    const slots = page.locator('.backpack-slot');
    const count = await slots.count();
    for (let i = 0; i < count; i++) {
      const text = await slots.nth(i).textContent().catch(() => '');
      if (text.toLowerCase().includes(itemText.toLowerCase())) {
        await slots.nth(i).click({ force: true });
        await page.waitForTimeout(3000);
        return true;
      }
    }
    return false;
  }
  await slot.click({ force: true });
  await page.waitForTimeout(3000);
  return true;
}

async function waitForCombatResult(page, maxWait = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    // Dismiss InsightCards — they intercept pointer events and block Continue/Got it! buttons
    const insightClose = page.locator('.kro-insight-card.visible .kro-insight-dismiss');
    if (await insightClose.count() > 0) {
      await insightClose.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }
    // Dismiss modal overlays that block buttons (concept modals, YAML modals)
    // Clicking the overlay background closes most modals; Escape as fallback.
    const modalOverlay = page.locator('.modal-overlay');
    if (await modalOverlay.count() > 0) {
      await page.keyboard.press('Escape').catch(() => {});
      await modalOverlay.first().click({ force: true, position: { x: 5, y: 5 } }).catch(() => {});
      await page.waitForTimeout(300);
    }
    const cb = page.locator('button:has-text("Continue")');
    if (await cb.count() > 0) {
      const mt = await page.textContent('.combat-modal').catch(() => '');
      await cb.click({ force: true, timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      return mt;
    }
    // Loot popup (only shows after combat modal is dismissed now)
    const gotIt = page.locator('button:has-text("Got it!")');
    if (await gotIt.count() > 0) {
      const lt = await page.textContent('.modal').catch(() => '');
      await gotIt.click({ force: true, timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      return lt;
    }
    await page.waitForTimeout(2000);
  }
  return null; // Timed out
}

async function dismissLootPopup(page) {
  const gotIt = page.locator('button:has-text("Got it!")');
  if (await gotIt.count() > 0) {
    const text = await page.textContent('.modal').catch(() => '');
    await gotIt.click().catch(() => {});
    await page.waitForTimeout(500);
    return text;
  }
  return null;
}

function aliveMonsterCount(page) {
  return page.locator('.arena-entity.monster-entity:not(.dead)').count();
}

function deadMonsterCount(page) {
  return page.locator('.arena-entity.monster-entity.dead').count();
}

async function getBodyText(page) {
  return page.textContent('body');
}

async function navigateHome(page, baseUrl) {
  // Dismiss kro-cert-overlay (victory certificate) if present — it intercepts pointer events
  for (let i = 0; i < 3; i++) {
    const certOverlay = page.locator('.kro-cert-overlay');
    if (await certOverlay.count() === 0) break;
    await page.evaluate(() => {
      const el = document.querySelector('.kro-cert-overlay');
      if (el) el.click();
    });
    await page.waitForTimeout(600);
  }
  // If cert overlay is still blocking, navigate by URL directly
  if (await page.locator('.kro-cert-overlay').count() > 0) {
    await page.goto(baseUrl, { timeout: 15000 });
    await page.waitForTimeout(2000);
    return;
  }
  const backBtn = page.locator('.back-btn');
  if (await backBtn.count() > 0) {
    await backBtn.click({ timeout: 5000 }).catch(async () => {
      // Fallback to URL navigation if click fails (e.g. overlay still blocking)
      await page.goto(baseUrl, { timeout: 15000 });
    });
    await page.waitForTimeout(2000);
  } else {
    await page.goto(baseUrl, { timeout: 15000 });
    await page.waitForTimeout(2000);
  }
}

async function deleteDungeon(page, name) {
  // Click the X button on the dungeon tile
  const tile = page.locator(`.dungeon-tile:has-text("${name}")`);
  if (await tile.count() === 0) return false;
  const delBtn = tile.locator('.tile-delete-btn');
  if (await delBtn.count() === 0) return false;
  // Accept the confirm() dialog that appears when deleting
  page.once('dialog', dialog => dialog.accept().catch(() => {}));
  await delBtn.click();
  await page.waitForTimeout(2000);
  return true;
}

module.exports = {
  createDungeonUI, attackMonster, attackBoss, useAbility, useBackpackItem,
  waitForCombatResult, dismissLootPopup, aliveMonsterCount, deadMonsterCount,
  getBodyText, navigateHome, deleteDungeon
};
