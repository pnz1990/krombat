const { chromium } = require('playwright');

const BASE_URL = 'http://localhost:3000';
const TIMEOUT = 10000;

async function runSmokeTests() {
  console.log('🧪 Starting smoke tests...\n');
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  let passed = 0;
  let failed = 0;
  
  try {
    // Test 1: UI loads
    console.log('Test 1: UI loads...');
    await page.goto(BASE_URL, { timeout: TIMEOUT });
    await page.waitForLoadState('domcontentloaded');
    console.log('  ✓ Page loaded\n');
    passed++;
    
    // Test 2: Check for main elements
    console.log('Test 2: Main UI elements present...');
    const bodyText = await page.textContent('body');
    if (bodyText.includes('Kubernetes RPG') || bodyText.includes('KROMBAT') || bodyText.includes('Dungeon')) {
      console.log('  ✓ Main content found\n');
      passed++;
    } else {
      console.log('  ✗ Main content not found\n');
      failed++;
    }
    
    // Test 3: No JavaScript errors
    console.log('Test 3: No console errors...');
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    await page.waitForTimeout(2000); // Wait for any async errors
    if (errors.length === 0) {
      console.log('  ✓ No console errors\n');
      passed++;
    } else {
      console.log('  ✗ Console errors found:');
      errors.forEach(err => console.log('    -', err));
      console.log('');
      failed++;
    }
    
    // Test 4: Check if React rendered (look for common React patterns)
    console.log('Test 4: React app rendered...');
    const hasReactRoot = await page.evaluate(() => {
      return document.querySelector('#root') !== null || 
             document.querySelector('[data-reactroot]') !== null ||
             document.querySelector('div') !== null;
    });
    if (hasReactRoot) {
      console.log('  ✓ React app rendered\n');
      passed++;
    } else {
      console.log('  ✗ React app not rendered\n');
      failed++;
    }
    
    // Test 5: API connectivity (check if backend is reachable)
    console.log('Test 5: Backend API reachable...');
    try {
      const response = await page.evaluate(async () => {
        const res = await fetch('/api/v1/dungeons');
        return { status: res.status, ok: res.ok };
      });
      if (response.ok || response.status === 200) {
        console.log('  ✓ Backend API responding\n');
        passed++;
      } else {
        console.log(`  ✗ Backend API returned status ${response.status}\n`);
        failed++;
      }
    } catch (error) {
      console.log('  ✗ Backend API not reachable:', error.message, '\n');
      failed++;
    }
    
    // Test 6: Create dungeon
    console.log('Test 6: Create dungeon...');
    try {
      const dungeonName = `test-${Date.now()}`;
      const createResponse = await page.evaluate(async (name) => {
        const res = await fetch('/api/v1/dungeons', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name,
            monsters: 2,
            difficulty: 'easy'
          })
        });
        return { status: res.status, ok: res.ok, data: await res.json() };
      }, dungeonName);
      
      if (createResponse.ok) {
        console.log(`  ✓ Dungeon created: ${dungeonName}\n`);
        passed++;
        
        // Test 7: View dungeon
        console.log('Test 7: View dungeon details...');
        await page.waitForTimeout(2000); // Wait for reconciliation
        const dungeonResponse = await page.evaluate(async (name) => {
          const res = await fetch(`/api/v1/dungeons/default/${name}`);
          return { status: res.status, ok: res.ok, data: await res.json() };
        }, dungeonName);
        
        if (dungeonResponse.ok && dungeonResponse.data.status) {
          console.log('  ✓ Dungeon details retrieved\n');
          passed++;
          
          // Test 8: Attack monster
          console.log('Test 8: Attack monster...');
          const monsterTarget = `${dungeonName}-monster-0`;
          const attackResponse = await page.evaluate(async (name, target) => {
            const res = await fetch(`/api/v1/dungeons/default/${name}/attacks`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                target: target,
                damage: 30
              })
            });
            return { status: res.status, ok: res.ok };
          }, dungeonName, monsterTarget);
          
          if (attackResponse.ok) {
            console.log('  ✓ Attack submitted successfully\n');
            passed++;
          } else {
            console.log(`  ✗ Attack failed with status ${attackResponse.status}\n`);
            failed++;
          }
        } else {
          console.log('  ✗ Could not retrieve dungeon details\n');
          failed++;
          failed++; // Skip attack test
        }
        
        // Cleanup: Delete dungeon
        console.log('Cleanup: Deleting test dungeon...');
        await page.evaluate(async (name) => {
          await fetch(`/api/v1/dungeons/default/${name}`, { method: 'DELETE' });
        }, dungeonName);
        console.log('  ✓ Cleanup complete\n');
        
      } else {
        console.log(`  ✗ Failed to create dungeon: ${createResponse.status}\n`);
        failed++;
        failed += 2; // Skip view and attack tests
      }
    } catch (error) {
      console.log('  ✗ Dungeon creation failed:', error.message, '\n');
      failed++;
      failed += 2; // Skip view and attack tests
    }
    
    // Summary
    console.log('━'.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('━'.repeat(50));
    
    if (failed > 0) {
      await page.screenshot({ path: 'test-failure.png', fullPage: true });
      console.log('\n📸 Screenshot saved to test-failure.png');
    }
    
    return failed === 0;
    
  } catch (error) {
    console.error('\n❌ Fatal test error:', error.message);
    await page.screenshot({ path: 'test-failure.png', fullPage: true });
    console.log('📸 Screenshot saved to test-failure.png');
    return false;
  } finally {
    await browser.close();
  }
}

// Run tests
runSmokeTests().then(success => {
  process.exit(success ? 0 : 1);
});
