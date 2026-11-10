import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

test('content.js does not use innerHTML for dynamic explanation or user text', () => {
  const contentJsPath = path.resolve(process.cwd(), 'extension/content.js');
  const content = fs.readFileSync(contentJsPath, 'utf8');

  // Ensure innerHTML is not used to render explanation, status, error, or sources
  assert.ok(!content.includes('.innerHTML'), 'content.js must not assign to innerHTML');
  assert.ok(!content.includes('eval('), 'content.js must not use eval');
  assert.ok(!content.includes('new Function('), 'content.js must not use Function constructor');

  // Verify safe DOM methods are used
  assert.ok(content.includes('replaceChildren'), 'content.js should use replaceChildren');
  assert.ok(content.includes('textContent'), 'content.js should use textContent for untrusted strings');
  assert.ok(content.includes('isSafeUrl'), 'content.js should validate URL protocols');
});

test('LawBuddy page scripts never inject HTML and validate link protocols', () => {
  const candidates = [
    path.resolve(process.cwd(), 'node_modules/@docvex/lawbuddy/web'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../lawbuddy/web'),
    path.resolve(process.cwd(), '../lawbuddy/web'),
    path.resolve(process.cwd(), 'packages/lawbuddy/web'),
    path.resolve(process.cwd(), 'web/lawbuddy'),
  ];
  const dir = candidates.find((c) => fs.existsSync(c));
  assert.ok(dir, 'LawBuddy web directory must exist');
  const scripts = fs.readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(scripts.length >= 3);
  for (const name of scripts) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.ok(!/\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write/.test(source), `${name} must not inject HTML`);
    assert.ok(!source.includes('eval(') && !source.includes('new Function('), `${name} must not evaluate code`);
  }
  const common = fs.readFileSync(path.join(dir, 'common.js'), 'utf8');
  assert.ok(common.includes('textContent') && common.includes('isSafeUrl'), 'shared helpers set text safely and check URLs');
  for (const page of ['index.html', 'teach.html']) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), `${page} must not contain inline scripts (CSP script-src 'self')`);
    assert.ok(!/\son[a-z]+=/i.test(html), `${page} must not use inline event handlers`);
  }
});
