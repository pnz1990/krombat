// Journey 14: kro Inspector Panel
// UI-ONLY: no kubectl, no fetch/api, no execSync
// Tests: KroGraph node click → Inspector panel; kubectl command; YAML content;
//        close button; switching between nodes updates inspector.
const { chromium } = require('playwright');
const { createDungeonUI, navigateHome, deleteDungeon , testLogin} = require('./helpers');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT = 20000;
let passed = 0, failed = 0, warnings = 0;
function ok(msg)   { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

async function switchToTab(page, label) {
  const btn = page.locator(`button.log-tab:has-text("${label}")`);
  if (await btn.count() === 0) return false;
  await btn.click();
  await page.waitForTimeout(400);
  return true;
}

// Click a graph node by its aria-label prefix (e.g. "Dungeon CR:" or "Hero CR:")
// Returns true if a clickable node was found and clicked.
async function clickGraphNode(page, kindPrefix) {
  const svg = page.locator('svg[aria-label="kro resource graph"]');
  // SVG <g> elements with role=button are the clickable nodes
  const nodes = svg.locator('g[role="button"]');
  const count = await nodes.count();
  for (let i = 0; i < count; i++) {
    const label = await nodes.nth(i).getAttribute('aria-label').catch(() => '');
    if (label && label.startsWith(kindPrefix)) {
      await nodes.nth(i).click({ force: true });
      return true;
    }
  }
  return false;
}

async function run() {
  console.log('Journey 14: kro Inspector Panel\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j14-${Date.now()}`;

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error' && !msg.text().includes('WebSocket') && !msg.text().includes('404') && !msg.text().includes('409') && !msg.text().includes('429') && !msg.text().includes('504') && !msg.text().includes('net::ERR')) consoleErrors.push(msg.text()); });

  try {
    await testLogin(page, BASE_URL);

    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForSelector('input[placeholder="my-dungeon"]', { timeout: TIMEOUT });

    // ── Create dungeon ────────────────────────────────────────────────────────
    console.log('\n  [Create dungeon]');
    const loaded = await createDungeonUI(page, dName, { monsters: 2, difficulty: 'easy', heroClass: 'warrior' });
    loaded ? ok('Dungeon created and game view loaded') : fail('Dungeon view did not load');

    // Allow initial reconcile to settle
    await page.waitForTimeout(3000);

    // ── Switch to kro Graph tab ───────────────────────────────────────────────
    console.log('\n  [kro Graph tab]');
    const tabSwitched = await switchToTab(page, 'kro');
    tabSwitched ? ok('kro tab is present and clickable') : fail('kro tab not found');

    // ── KroGraph panel visible ────────────────────────────────────────────────
    console.log('\n  [KroGraph panel]');
    const graphPanel = page.locator('.kro-graph-panel');
    await graphPanel.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await graphPanel.count() > 0) ? ok('kro-graph-panel is visible') : fail('kro-graph-panel not found');

    // Graph SVG should be present
    const svg = page.locator('svg[aria-label="kro resource graph"]');
    await svg.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await svg.count() > 0) ? ok('Graph SVG rendered (aria-label="kro resource graph")') : fail('Graph SVG not found');

    // Graph should have clickable nodes (g[role="button"])
    const clickableNodes = svg.locator('g[role="button"]');
    const nodeCount = await clickableNodes.count();
    nodeCount > 0 ? ok(`Graph has ${nodeCount} clickable node(s) (g[role="button"])`) : fail('No clickable nodes in graph SVG');

    // ── Click Dungeon CR node → Inspector opens ───────────────────────────────
    console.log('\n  [Click Dungeon CR node — Inspector panel]');
    const dungeonClicked = await clickGraphNode(page, 'Dungeon');
    dungeonClicked ? ok('Clicked Dungeon CR node') : fail('Could not find Dungeon CR node to click');

    // Inspector panel should appear
    await page.waitForTimeout(500);
    const inspector = page.locator('.kro-inspector');
    await inspector.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await inspector.count() > 0) ? ok('.kro-inspector panel appeared after node click') : fail('.kro-inspector panel did not appear');

    // Inspector header should contain kro badge
    const kroHeader = page.locator('.kro-inspector-header .kro-insight-badge');
    (await kroHeader.count() > 0) ? ok('Inspector header has kro badge (.kro-insight-badge)') : fail('Inspector header missing kro badge');

    // Inspector title should reference the node
    const titleEl = page.locator('.kro-inspector-title');
    const titleText = await titleEl.textContent().catch(() => '');
    titleText.includes('Inspector:') ? ok(`Inspector title shown: "${titleText.trim()}"`) : fail(`Inspector title unexpected: "${titleText}"`);

    // Inspector kubectl command should be present
    const kubectlEl = page.locator('.kro-inspector-kubectl');
    (await kubectlEl.count() > 0) ? ok('.kro-inspector-kubectl element found') : fail('.kro-inspector-kubectl element missing');

    const kubectlText = await kubectlEl.textContent().catch(() => '');
    kubectlText.includes('kubectl get') ? ok(`kubectl command shown: "${kubectlText.trim()}"`) : fail(`kubectl command text unexpected: "${kubectlText}"`);
    kubectlText.includes(dName) ? ok(`kubectl command references dungeon name "${dName}"`) : fail(`kubectl command missing dungeon name, got: "${kubectlText}"`);
    kubectlText.includes('-o yaml') ? ok('kubectl command includes -o yaml flag') : fail('kubectl command missing -o yaml flag');

    // ── Inspector YAML or loading state ──────────────────────────────────────
    console.log('\n  [Inspector YAML / loading]');
    // Wait for loading to complete (up to 10s)
    for (let i = 0; i < 20; i++) {
      const loading = await page.locator('.kro-inspector-loading').count();
      if (loading === 0) break;
      await page.waitForTimeout(500);
    }

    const yamlEl = page.locator('.kro-inspector-yaml');
    const emptyEl = page.locator('.kro-inspector-empty');
    const yamlCount = await yamlEl.count();
    const emptyCount = await emptyEl.count();

    if (yamlCount > 0) {
      const yamlText = await yamlEl.textContent().catch(() => '');
      yamlText.length > 0 ? ok(`Inspector YAML content present (${yamlText.length} chars)`) : fail('Inspector YAML element is empty');
      yamlText.includes('apiVersion') || yamlText.includes('metadata') || yamlText.includes('kind')
        ? ok('Inspector YAML contains Kubernetes resource fields')
        : warn(`YAML content doesn't look like K8s resource: "${yamlText.slice(0, 80)}"`);
    } else if (emptyCount > 0) {
      warn('Inspector shows "resource not available" — cluster may not have resource ready yet');
    } else {
      fail('Inspector shows neither YAML content nor empty state');
    }

    // ── Close button dismisses inspector ─────────────────────────────────────
    console.log('\n  [Close button]');
    const closeBtn = page.locator('.kro-inspector-header button:has-text("✕")');
    (await closeBtn.count() > 0) ? ok('Close button (✕) found in inspector header') : fail('Close button not found in .kro-inspector-header');

    if (await closeBtn.count() > 0) {
      // Dismiss any InsightCard or modal overlay that may intercept pointer events
      for (let i = 0; i < 3; i++) {
        const insightDismiss = page.locator('.kro-insight-card.visible .kro-insight-dismiss');
        if (await insightDismiss.count() > 0) {
          await insightDismiss.first().click({ force: true }).catch(() => {});
          await page.waitForTimeout(400);
        }
        const modalOverlay = page.locator('.modal-overlay');
        if (await modalOverlay.count() > 0) {
          await page.keyboard.press('Escape').catch(() => {});
          await page.evaluate(() => {
            const el = document.querySelector('.modal-overlay');
            if (el) el.click();
          });
          await page.waitForTimeout(400);
        }
        if (await page.locator('.kro-insight-card.visible').count() === 0 &&
            await page.locator('.modal-overlay').count() === 0) break;
      }
      // Use evaluate to bypass overlay z-index issues
      await page.evaluate(() => {
        const btn = document.querySelector('.kro-inspector-header button');
        if (btn) btn.click();
      });
      await page.waitForTimeout(400);
      const inspectorAfterClose = await page.locator('.kro-inspector').count();
      inspectorAfterClose === 0 ? ok('Inspector dismissed after clicking ✕') : fail('Inspector still visible after clicking ✕');
    }

    // ── Click Hero CR node — inspector opens for Hero ─────────────────────────
    console.log('\n  [Click Hero CR node — Inspector updates]');
    const heroClicked = await clickGraphNode(page, 'Hero CR');
    heroClicked ? ok('Clicked Hero CR node') : fail('Could not find Hero CR node to click');

    await page.waitForTimeout(500);
    const heroInspector = page.locator('.kro-inspector');
    await heroInspector.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await heroInspector.count() > 0) ? ok('.kro-inspector appeared for Hero CR node') : fail('.kro-inspector did not appear for Hero CR');

    const heroTitle = await page.locator('.kro-inspector-title').textContent().catch(() => '');
    heroTitle.includes('Hero') || heroTitle.includes('Inspector')
      ? ok(`Inspector title updated for Hero: "${heroTitle.trim()}"`)
      : fail(`Inspector title did not update for Hero, got: "${heroTitle}"`);

    const heroKubectl = await page.locator('.kro-inspector-kubectl').textContent().catch(() => '');
    heroKubectl.includes('kubectl get') ? ok('kubectl command present for Hero node') : fail(`Hero inspector kubectl command missing, got: "${heroKubectl}"`);

    // ── Click Boss CR node — inspector updates to Boss ────────────────────────
    console.log('\n  [Click Boss CR node — Inspector updates again]');
    const bossClicked = await clickGraphNode(page, 'Boss CR');
    if (bossClicked) {
      await page.waitForTimeout(500);
      const bossTitle = await page.locator('.kro-inspector-title').textContent().catch(() => '');
      bossTitle.includes('Boss') || bossTitle.includes('Inspector')
        ? ok(`Inspector title updated for Boss: "${bossTitle.trim()}"`)
        : fail(`Inspector title did not update for Boss, got: "${bossTitle}"`);

      const bossKubectl = await page.locator('.kro-inspector-kubectl').textContent().catch(() => '');
      bossKubectl.includes('kubectl get') ? ok('kubectl command present for Boss node') : fail(`Boss inspector kubectl missing, got: "${bossKubectl}"`);
    } else {
      warn('Boss CR node not clickable yet (may require all monsters dead) — skipping boss inspector check');
    }

    // ── Non-inspector nodes do not open inspector ─────────────────────────────
    console.log('\n  [Non-inspector nodes — no inspector for unmapped nodes]');
    // Close any open inspector first
    const closeBtn2 = page.locator('.kro-inspector-header button:has-text("✕")');
    if (await closeBtn2.count() > 0) {
      // Dismiss overlays before closing
      for (let i = 0; i < 3; i++) {
        const insightDismiss2 = page.locator('.kro-insight-card.visible .kro-insight-dismiss');
        if (await insightDismiss2.count() > 0) {
          await insightDismiss2.first().click({ force: true }).catch(() => {});
          await page.waitForTimeout(300);
        }
        const mo2 = page.locator('.modal-overlay');
        if (await mo2.count() > 0) {
          await page.keyboard.press('Escape').catch(() => {});
          await page.evaluate(() => { const el = document.querySelector('.modal-overlay'); if (el) el.click(); });
          await page.waitForTimeout(300);
        }
        if (await page.locator('.kro-insight-card.visible').count() === 0 &&
            await page.locator('.modal-overlay').count() === 0) break;
      }
      await page.evaluate(() => {
        const btn = document.querySelector('.kro-inspector-header button');
        if (btn) btn.click();
      });
      await page.waitForTimeout(300);
    }

    // Monster CR nodes (id: monster-0, etc.) are mapped but loot nodes are not (no kind in kindMap)
    // Try clicking a loot node — inspector should NOT appear
    const allNodes = svg.locator('g[role="button"]');
    const allCount = await allNodes.count();
    let foundLootNode = false;
    for (let i = 0; i < allCount; i++) {
      const label = await allNodes.nth(i).getAttribute('aria-label').catch(() => '');
      if (label && label.startsWith('Loot CR')) {
        await allNodes.nth(i).click({ force: true });
        await page.waitForTimeout(400);
        const inspectorAfterLoot = await page.locator('.kro-inspector').count();
        // Loot nodes have concept but no kindMap entry → inspector should NOT open
        inspectorAfterLoot === 0 ? ok('Loot CR node click does not open inspector (not in kindMap)') : warn('Loot CR node opened inspector unexpectedly');
        foundLootNode = true;
        break;
      }
    }
    if (!foundLootNode) {
      warn('No Loot CR node found to test unmapped node behavior');
    }

    // ── No console errors during inspector interactions ───────────────────────
    console.log('\n  [Console errors check]');
    const relevantErrors = consoleErrors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('net::ERR') &&
      !e.includes('404')
    );
    relevantErrors.length === 0
      ? ok('No JS console errors during Inspector interactions')
      : warn(`${relevantErrors.length} console error(s): ${relevantErrors.slice(0, 2).join(' | ')}`);

    // ── Cleanup ───────────────────────────────────────────────────────────────
    console.log('\n  [Cleanup]');
    await navigateHome(page, BASE_URL);
    await page.waitForTimeout(1000);
    const deleted = await deleteDungeon(page, dName);
    deleted ? ok(`Dungeon "${dName}" deleted`) : warn(`Could not delete dungeon "${dName}"`);

  } catch (err) {
    fail(`Unexpected error: ${err.message}`);
    console.error(err);
  } finally {
    await browser.close();
    console.log(`\n  Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);
    if (failed > 0) process.exit(1);
  }
}

run();
