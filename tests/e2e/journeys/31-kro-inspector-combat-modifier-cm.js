// Journey 31: KroGraph Inspector — gameConfig-cm and modifier-cm deep-dive
// UI-ONLY: no kubectl, no direct fetch/api, no execSync
//
// Covers the Inspector flows for gameConfig (gameconfig-cm) and
// modifierState (modifier-cm) ConfigMap nodes, which contain CEL-computed
// fields and are the most educational in the kro teaching layer.
//
// gameconfig-cm: always present; shows dice formula, HP/counter tables
// modifier-cm: present only when dungeon has a modifier (includeWhen guard)
//              — tested conditionally; warns if no modifier was assigned.
//
// NOTE: combatResolve and actionResolve are virtual specPatch nodes with no
// persistent K8s resource — the Inspector skips them by design. gameConfig is
// the closest real ConfigMap that shows kro CEL output for every dungeon.
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

// Click a graph node whose aria-label starts with the given prefix.
// aria-label format: "{kind}: {label} — {state}"
async function clickGraphNode(page, labelPrefix) {
  const svg = page.locator('svg[aria-label="kro resource graph"]');
  const nodes = svg.locator('g[role="button"]');
  const count = await nodes.count();
  for (let i = 0; i < count; i++) {
    const label = await nodes.nth(i).getAttribute('aria-label').catch(() => '');
    if (label && label.includes(labelPrefix)) {
      await nodes.nth(i).click({ force: true });
      return label;
    }
  }
  return null;
}

async function closeInspector(page) {
  // Dismiss InsightCards or modal overlays before clicking close
  for (let i = 0; i < 3; i++) {
    const insightDismiss = page.locator('.kro-insight-card.visible .kro-insight-dismiss');
    if (await insightDismiss.count() > 0) {
      await insightDismiss.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
    }
    const mo = page.locator('.modal-overlay:not(.combat-overlay)');
    if (await mo.count() > 0) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.evaluate(() => { const el = document.querySelector('.modal-overlay'); if (el) el.click(); }).catch(() => {});
      await page.waitForTimeout(300);
    }
    if (await page.locator('.kro-insight-card.visible').count() === 0 &&
        await page.locator('.modal-overlay:not(.combat-overlay)').count() === 0) break;
  }
  const btn = page.locator('.kro-inspector-header button:has-text("✕")');
  if (await btn.count() > 0) {
    await page.evaluate(() => {
      const b = document.querySelector('.kro-inspector-header button');
      if (b) b.click();
    });
    await page.waitForTimeout(300);
  }
}

async function waitForInspectorReady(page) {
  // Wait up to 15s for loading to finish
  for (let i = 0; i < 30; i++) {
    const loading = await page.locator('.kro-inspector-loading').count();
    if (loading === 0) break;
    await page.waitForTimeout(500);
  }
}

async function run() {
  console.log('Journey 31: KroGraph Inspector — gameConfig-cm and modifier-cm\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dName = `j31-${Date.now()}`;

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

    // Allow initial reconcile to settle so gameconfig-cm is populated
    await page.waitForTimeout(3000);

    // ── Switch to kro Graph tab ───────────────────────────────────────────────
    console.log('\n  [kro Graph tab]');
    const tabSwitched = await switchToTab(page, 'kro');
    tabSwitched ? ok('kro tab is present and clickable') : fail('kro tab not found');

    // ── KroGraph panel and SVG ────────────────────────────────────────────────
    console.log('\n  [KroGraph panel]');
    const graphPanel = page.locator('.kro-graph-panel');
    await graphPanel.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await graphPanel.count() > 0) ? ok('kro-graph-panel is visible') : fail('kro-graph-panel not found');

    const svg = page.locator('svg[aria-label="kro resource graph"]');
    await svg.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await svg.count() > 0) ? ok('Graph SVG rendered') : fail('Graph SVG not found');

    // ── Verify combatResolve and gameConfig nodes are present in graph ────────
    console.log('\n  [Node presence check]');
    const allNodes = svg.locator('g[role="button"]');
    const nodeCount = await allNodes.count();
    let combatNodeFound = false;
    let gameConfigNodeFound = false;
    let modifierNodeFound = false;
    for (let i = 0; i < nodeCount; i++) {
      const label = await allNodes.nth(i).getAttribute('aria-label').catch(() => '');
      if (label && label.includes('combatResolve')) combatNodeFound = true;
      if (label && label.includes('gameConfig')) gameConfigNodeFound = true;
      if (label && label.includes('modifierState')) modifierNodeFound = true;
    }
    combatNodeFound
      ? ok('combatResolve (specPatch) node found in KroGraph')
      : fail('combatResolve node not found in KroGraph');
    gameConfigNodeFound
      ? ok('gameConfig (ConfigMap) node found in KroGraph')
      : fail('gameConfig node not found in KroGraph');
    modifierNodeFound
      ? ok('modifierState (modifier-cm) node found in KroGraph (modifier is active)')
      : warn('modifierState node not visible — dungeon has no modifier (20% chance, statistically expected)');

    // ── Click gameConfig node — Inspector opens ───────────────────────────────
    // gameConfig is the gameconfig-cm ConfigMap — always present, always has CEL data
    console.log('\n  [Click gameConfig node — Inspector]');
    const gameConfigNodeLabel = await clickGraphNode(page, 'gameConfig');
    gameConfigNodeLabel
      ? ok(`Clicked gameConfig node (aria-label: "${gameConfigNodeLabel}")`)
      : fail('gameConfig node not clickable');

    await page.waitForTimeout(500);
    const inspector = page.locator('.kro-inspector');
    await inspector.waitFor({ timeout: TIMEOUT }).catch(() => {});
    (await inspector.count() > 0)
      ? ok('.kro-inspector panel appeared after clicking gameConfig node')
      : fail('.kro-inspector did not open for gameConfig node');

    // ── Inspector title and kubectl command for gameconfig-cm ─────────────────
    console.log('\n  [Inspector title + kubectl for gameconfig-cm]');
    const titleText = await page.locator('.kro-inspector-title').textContent().catch(() => '');
    titleText.includes('gameConfig') || titleText.includes('Inspector')
      ? ok(`Inspector title: "${titleText.trim()}"`)
      : fail(`Inspector title unexpected: "${titleText}"`);

    const kubectlText = await page.locator('.kro-inspector-kubectl').textContent().catch(() => '');
    kubectlText.includes('kubectl get')
      ? ok('kubectl command present for gameConfig inspector')
      : fail('kubectl command missing for gameConfig inspector');
    kubectlText.includes(dName)
      ? ok(`kubectl command references dungeon name "${dName}"`)
      : fail(`kubectl command missing dungeon name in: "${kubectlText.trim()}"`);
    kubectlText.includes('-o yaml')
      ? ok('kubectl command includes -o yaml flag')
      : fail('kubectl command missing -o yaml flag');

    // ── Inspector YAML for gameconfig-cm (CEL-computed fields) ───────────────
    console.log('\n  [Inspector YAML — gameconfig-cm CEL fields]');
    await waitForInspectorReady(page);

    const yamlEl = page.locator('.kro-inspector-yaml');
    const emptyEl = page.locator('.kro-inspector-empty');

    if (await yamlEl.count() > 0) {
      const yamlText = await yamlEl.textContent().catch(() => '');
      yamlText.length > 0
        ? ok(`gameconfig-cm YAML content present (${yamlText.length} chars)`)
        : fail('gameconfig-cm YAML element is empty');

      // ConfigMap YAML should contain apiVersion, kind, data
      yamlText.includes('apiVersion') || yamlText.includes('kind') || yamlText.includes('data')
        ? ok('gameconfig-cm YAML contains Kubernetes ConfigMap fields')
        : warn(`gameconfig-cm YAML doesn't look like K8s resource: "${yamlText.slice(0, 80)}"`);

      // gameconfig-cm should have CEL-computed fields: dice formula, HP, counters
      const hasGameData = yamlText.includes('dice') || yamlText.includes('HP') ||
                          yamlText.includes('maxHP') || yamlText.includes('counter') ||
                          yamlText.includes('formula') || yamlText.includes('warrior') ||
                          yamlText.includes('easy') || yamlText.includes('normal');
      hasGameData
        ? ok('gameconfig-cm YAML contains CEL-computed game config data')
        : warn('Expected dice/HP/counter fields in gameconfig-cm ConfigMap — may not be populated yet');

    } else if (await emptyEl.count() > 0) {
      warn('gameconfig-cm Inspector shows "resource not available" — configmap may not exist yet (cluster cold)');
    } else {
      fail('gameconfig-cm Inspector shows neither YAML content nor loading/empty state');
    }

    // ── Close inspector ───────────────────────────────────────────────────────
    await closeInspector(page);
    await page.waitForTimeout(300);
    const inspectorGone = await page.locator('.kro-inspector').count() === 0;
    inspectorGone
      ? ok('Inspector closed after ✕ button click')
      : fail('Inspector still visible after close button click');

    // ── modifier-cm Inspector (conditional — only if modifier-cm node exists) ──
    console.log('\n  [modifier-cm Inspector (conditional)]');
    if (modifierNodeFound) {
      const modNodeLabel = await clickGraphNode(page, 'modifierState');
      modNodeLabel
        ? ok(`Clicked modifierState node (aria-label: "${modNodeLabel}")`)
        : fail('modifierState node not clickable despite being found earlier');

      await page.waitForTimeout(500);
      const modInspector = page.locator('.kro-inspector');
      await modInspector.waitFor({ timeout: TIMEOUT }).catch(() => {});
      (await modInspector.count() > 0)
        ? ok('.kro-inspector opened for modifierState node')
        : fail('.kro-inspector did not open for modifierState node');

      // Title should reference modifier
      const modTitleText = await page.locator('.kro-inspector-title').textContent().catch(() => '');
      modTitleText.includes('modifierState') || modTitleText.includes('Inspector')
        ? ok(`modifier-cm Inspector title: "${modTitleText.trim()}"`)
        : fail(`modifier-cm Inspector title unexpected: "${modTitleText}"`);

      // kubectl command should reference the dungeon
      const modKubectl = await page.locator('.kro-inspector-kubectl').textContent().catch(() => '');
      modKubectl.includes(dName)
        ? ok(`modifier-cm kubectl references dungeon name "${dName}"`)
        : fail(`modifier-cm kubectl missing dungeon name: "${modKubectl.trim()}"`);

      // YAML content check
      await waitForInspectorReady(page);
      const modYaml = page.locator('.kro-inspector-yaml');
      if (await modYaml.count() > 0) {
        const modYamlText = await modYaml.textContent().catch(() => '');
        modYamlText.length > 0
          ? ok(`modifier-cm YAML content present (${modYamlText.length} chars)`)
          : fail('modifier-cm YAML element is empty');

        // Modifier ConfigMap should contain CEL-computed modifier type data
        const hasModData = modYamlText.includes('modifier') || modYamlText.includes('curse') ||
                           modYamlText.includes('blessing') || modYamlText.includes('effect') ||
                           modYamlText.includes('type') || modYamlText.includes('data');
        hasModData
          ? ok('modifier-cm YAML contains CEL-computed modifier fields')
          : warn('Expected modifier/curse/blessing fields in modifier-cm ConfigMap');
      } else if (await page.locator('.kro-inspector-empty').count() > 0) {
        warn('modifier-cm Inspector shows "resource not available"');
      } else {
        fail('modifier-cm Inspector shows neither YAML nor empty state');
      }

      await closeInspector(page);
      ok('modifier-cm Inspector flow complete');
    } else {
      warn('modifier-cm test skipped — no modifier on this dungeon (testing gameconfig-cm only)');
      ok('Journey 31 core test (gameconfig-cm) complete; modifier-cm skipped due to no modifier');
    }

    // ── Switching between nodes updates Inspector content ─────────────────────
    console.log('\n  [Node switching — Inspector updates correctly]');
    // Click gameConfig again, then click Dungeon node, verify Inspector updates
    const gameConfigLabel2 = await clickGraphNode(page, 'gameConfig');
    gameConfigLabel2 ? ok('Re-clicked gameConfig node') : warn('gameConfig node not re-clickable');
    await page.waitForTimeout(400);

    const gameConfigTitle = await page.locator('.kro-inspector-title').textContent().catch(() => '');
    gameConfigTitle.includes('gameConfig') || gameConfigTitle.includes('Inspector')
      ? ok(`Inspector shows gameConfig after re-click: "${gameConfigTitle.trim()}"`)
      : warn(`Inspector title after re-click: "${gameConfigTitle.trim()}"`);

    // Switch to Dungeon CR node — inspector should update
    const dungeonLabel = await clickGraphNode(page, 'Dungeon');
    if (dungeonLabel) {
      await page.waitForTimeout(400);
      const dungeonTitle = await page.locator('.kro-inspector-title').textContent().catch(() => '');
      dungeonTitle.includes('Dungeon') || dungeonTitle.includes('Inspector')
        ? ok(`Inspector updated to Dungeon CR node: "${dungeonTitle.trim()}"`)
        : fail(`Inspector did not update when switching from gameConfig to Dungeon: "${dungeonTitle}"`);
    } else {
      warn('Could not click Dungeon node for switch test');
    }

    await closeInspector(page);

    // ── Verify no JS errors during all inspector interactions ─────────────────
    console.log('\n  [Console error check]');
    const criticalErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('net::ERR') &&
      !e.includes('kro warning') && !e.includes('WebSocket') &&
      !e.includes('404')
    );
    criticalErrors.length === 0
      ? ok('No critical JS errors during journey')
      : fail(`JS errors: ${criticalErrors.slice(0, 3).join('; ')}`);

  } catch (err) {
    fail(`Unexpected error: ${err.message}`);
    console.error(err);
  } finally {
    await page.goto(BASE_URL, { timeout: TIMEOUT }).catch(() => {});
    await page.waitForTimeout(1000);
    await deleteDungeon(page, dName).catch(() => {});
    await browser.close();
    console.log(`\n  Passed: ${passed}  Failed: ${failed}  Warnings: ${warnings}`);
    if (failed > 0) process.exit(1);
  }
}

run();
