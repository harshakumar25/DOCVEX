import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('manifest.json conforms to Manifest V3 specification', () => {
  const manifestPath = path.resolve(process.cwd(), 'extension/manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');

  const content = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(content);

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'DocVex');
  assert.ok(manifest.permissions.includes('contextMenus'));
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('offscreen'));
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.ok(manifest.commands['teach-selection']);
  assert.equal(manifest.commands['teach-selection'].suggested_key.mac, 'MacCtrl+Shift+S');

  // Verify icons exist
  for (const [size, relPath] of Object.entries(manifest.icons)) {
    const iconFile = path.resolve(process.cwd(), 'extension', relPath);
    assert.ok(fs.existsSync(iconFile), `Icon for size ${size} must exist at ${iconFile}`);
  }
});

test('extension JS files exist and are non-empty', () => {
  const bgPath = path.resolve(process.cwd(), 'extension/background.js');
  const csPath = path.resolve(process.cwd(), 'extension/content.js');
  const offscreenHtmlPath = path.resolve(process.cwd(), 'extension/offscreen.html');
  const offscreenJsPath = path.resolve(process.cwd(), 'extension/offscreen.js');
  const popupHtml = path.resolve(process.cwd(), 'extension/popup.html');
  const popupJs = path.resolve(process.cwd(), 'extension/popup.js');

  assert.ok(fs.statSync(bgPath).size > 0);
  assert.ok(fs.statSync(csPath).size > 0);
  assert.ok(fs.statSync(offscreenHtmlPath).size > 0);
  assert.ok(fs.statSync(offscreenJsPath).size > 0);
  assert.ok(fs.statSync(popupHtml).size > 0);
  assert.ok(fs.statSync(popupJs).size > 0);
});
