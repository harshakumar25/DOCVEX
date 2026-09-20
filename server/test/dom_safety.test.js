import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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
