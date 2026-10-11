import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import {
  listPlugins,
  getPlugin,
  executePlugin,
  setPluginEnabled,
  resetPlugins,
} from '../plugins/pluginManager.js';

const startTestServer = async (options = {}) => {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { baseUrl, close, port };
};

test('Plugin Registry: lists all 8 built-in developer plugins with metadata', () => {
  resetPlugins();
  const plugins = listPlugins();
  assert.equal(plugins.length, 8);
  const ids = plugins.map(p => p.id);
  assert.deepEqual(ids, [
    'obsidian-vault',
    'anki-deck',
    'git-diff-auditor',
    'dsa-cinema',
    'podcast-compiler',
    'system-design-architect',
    'regex-decoder',
    'sql-explain-analyst',
  ]);

  for (const p of plugins) {
    assert.ok(p.id && typeof p.id === 'string');
    assert.ok(p.name && typeof p.name === 'string');
    assert.ok(p.category && typeof p.category === 'string');
    assert.ok(p.version && typeof p.version === 'string');
    assert.ok(p.icon && typeof p.icon === 'string');
    assert.ok(p.description && typeof p.description === 'string');
    assert.equal(p.enabled, true);
  }
});

test('Plugin Registry: getPlugin retrieves plugin or returns null', () => {
  const p = getPlugin('git-diff-auditor');
  assert.ok(p);
  assert.equal(p.id, 'git-diff-auditor');
  assert.equal(getPlugin('non-existent-plugin'), null);
});

test('Plugin Registry: toggle and disabled execution enforcement', () => {
  resetPlugins();
  const toggled = setPluginEnabled('obsidian-vault', false);
  assert.deepEqual(toggled, { id: 'obsidian-vault', enabled: false });

  const res = executePlugin('obsidian-vault', { title: 'Test' });
  assert.equal(res.success, false);
  assert.match(res.error, /disabled/i);

  setPluginEnabled('obsidian-vault', true);
  const res2 = executePlugin('obsidian-vault', { title: 'Test' });
  assert.equal(res2.success, true);
  resetPlugins();
});

test('Plugin 1: obsidian-vault generates valid Obsidian Markdown with wikilinks & callouts', () => {
  const session = {
    title: 'Raft Consensus Algorithm',
    category: 'Distributed Systems',
    snippet: 'Raft decomposes consensus into leader election and log replication.',
    mentalModel: 'A parliament of clocks where members hold a timed runoff election.',
    diagram: '[Client] -> [Leader] -> [Followers]',
    gotchas: 'Split votes can occur if election timeouts are identical.\nHeartbeats must be sent below 100ms.',
    sentences: [
      { text: 'Raft elects a single distinguished leader.', pauseAfterMs: 300 },
      { text: 'Followers reject logs from unverified terms.', pauseAfterMs: 600 },
    ],
  };

  const res = executePlugin('obsidian-vault', { session });
  assert.equal(res.success, true);
  assert.equal(res.filename, 'raft-consensus-algorithm.md');
  assert.equal(res.format, 'markdown/obsidian');
  assert.match(res.content, /^---\ntitle: "Raft Consensus Algorithm"/);
  assert.match(res.content, /> \[!abstract\] Spatial Mental Cinema/);
  assert.match(res.content, /> \[!example\] Mechanical Blueprint/);
  assert.match(res.content, /> \[!warning\] Critical Gotchas & Pitfalls/);
  assert.match(res.content, /\[\[Distributed Systems\]\]/);
  assert.match(res.content, /1\. Raft elects a single distinguished leader\. \*\(\+300ms pause\)\*/);
});

test('Plugin 2: anki-deck generates cloze-deletion active recall cards and TSV', () => {
  const session = {
    title: 'Sliding Window Invariant',
    category: 'Algorithms',
    snippet: 'while (right < n) { add(nums[right]); ... }',
    mentalModel: 'An optical lens expanding right and contracting left.',
    gotchas: 'Off-by-one window length: always use right - left + 1.',
  };

  const res = executePlugin('anki-deck', { session });
  assert.equal(res.success, true);
  assert.equal(res.cardCount, 2);
  assert.match(res.tsv, /#separator:tab/);
  assert.match(res.tsv, /\{\{c1::/); // Cloze deletion test
  assert.ok(res.filename.startsWith('docvex_anki_deck_'));
});

test('Plugin 3: git-diff-auditor parses diff patches and scripts acoustic review', () => {
  const emptyRes = executePlugin('git-diff-auditor', { diff: '' });
  assert.equal(emptyRes.success, false);
  assert.match(emptyRes.error, /missing/i);

  const sampleDiff = `diff --git a/server/auth.js b/server/auth.js
--- a/server/auth.js
+++ b/server/auth.js
@@ -10,2 +10,4 @@
-const token = req.cookies.oldToken;
+const token = req.headers.authorization?.split(' ')[1];
+if (!token) throw new Error('Unauthorized');
+verifyJwtSignature(token);
`;

  const res = executePlugin('git-diff-auditor', { diff: sampleDiff });
  assert.equal(res.success, true);
  assert.deepEqual(res.filesModified, ['server/auth.js']);
  assert.equal(res.addedCount, 3);
  assert.equal(res.deletedCount, 1);
  assert.match(res.summaryScript, /This pull request modifies 1 file/);
  assert.match(res.narratablePassage, /Key modified lines/);
});

test('Plugin 4: dsa-cinema generates spatial ASCII diagram and invariant rules', () => {
  const res = executePlugin('dsa-cinema', { pattern: 'monotonic-stack' });
  assert.equal(res.success, true);
  assert.equal(res.patternName, 'Monotonic Stack Horizon');
  assert.match(res.analogy, /skyscrapers/i);
  assert.ok(res.diagram.includes('Stack State'));
  assert.ok(res.invariants.length >= 2);
  assert.match(res.narrationScript, /To solve Monotonic Stack Horizon/);

  // Fallback for unknown pattern
  const fallback = executePlugin('dsa-cinema', { pattern: 'something-random' });
  assert.equal(fallback.success, true);
  assert.equal(fallback.patternName, 'Sliding Window Invariant');
});

test('Plugin 5: podcast-compiler combines sessions into continuous narrative episode', () => {
  const emptyRes = executePlugin('podcast-compiler', { sessions: [] });
  assert.equal(emptyRes.success, false);
  assert.match(emptyRes.error, /no sessions/i);

  const sessions = [
    {
      title: 'B-Tree Node Splitting',
      category: 'Storage',
      mentalModel: 'An expanding bookshelf dividing at median key.',
      sentences: [{ text: 'When a B-tree page overflows its 4KB boundary, it splits.' }],
      gotchas: 'Parent node pointer updates require latching.',
    },
    {
      title: 'Write-Ahead Log Flushing',
      category: 'Durability',
      mentalModel: 'Writing in permanent ink before taking any physical action.',
      sentences: [{ text: 'Transactions must fsync WAL before returning success.' }],
    },
  ];

  const res = executePlugin('podcast-compiler', { sessions, episodeTitle: 'Database Internals' });
  assert.equal(res.success, true);
  assert.equal(res.episodeTitle, 'Database Internals');
  assert.equal(res.chapterCount, 2);
  assert.match(res.compiledScript, /--- Chapter 1: B-Tree Node Splitting ---/);
  assert.match(res.compiledScript, /--- Chapter 2: Write-Ahead Log Flushing ---/);
  assert.match(res.compiledScript, /\[Musical Interlude — 3 Second Pause\]/);
  assert.ok(typeof res.estimatedDurationMinutes === 'number');
});

test('Plugin 6: system-design-architect analyzes topologies and failure modes', () => {
  const res = executePlugin('system-design-architect', { topic: 'raft-consensus' });
  assert.equal(res.success, true);
  assert.equal(res.systemName, 'Raft Distributed Consensus');
  assert.equal(res.category, 'Consensus & Coordination');
  assert.match(res.capClassification, /CP/);
  assert.ok(res.failureDomains.some(f => f.includes('Split-vote')));
  assert.ok(res.asciiDiagram.includes('Leader Node'));
  assert.match(res.narrationScript, /Raft achieves consensus/);

  // LSM trees topology
  const lsm = executePlugin('system-design-architect', { topic: 'lsm' });
  assert.equal(lsm.success, true);
  assert.equal(lsm.systemName, 'Log-Structured Merge-Tree (LSM)');
  assert.ok(lsm.asciiDiagram.includes('MemTable'));
});

test('Plugin 7: regex-decoder parses tokens and assesses ReDoS hazards', () => {
  const empty = executePlugin('regex-decoder', { pattern: '' });
  assert.equal(empty.success, false);

  // Standard safe regex with lookahead and anchors
  const safeRegex = '/^(?=.*[a-z])(?=.*[A-Z])\\w{8,}$/';
  const safeRes = executePlugin('regex-decoder', { pattern: safeRegex });
  assert.equal(safeRes.success, true);
  assert.equal(safeRes.redosRisk, 'LOW');
  assert.equal(safeRes.safeToUse, true);
  assert.ok(safeRes.tokens.length >= 2);
  assert.match(safeRes.verbalExplanation, /Positive Lookahead/i);

  // Dangerous catastrophic backtracking pattern (a+)+
  const dangerousRegex = '/^([a-zA-Z0-9]+)+$/';
  const redosRes = executePlugin('regex-decoder', { pattern: dangerousRegex });
  assert.equal(redosRes.success, true);
  assert.equal(redosRes.redosRisk, 'CRITICAL');
  assert.equal(redosRes.safeToUse, false);
  assert.ok(redosRes.redosWarnings.length > 0);
});

test('Plugin 8: sql-explain-analyst detects Seq Scans and disk sort spills', () => {
  const empty = executePlugin('sql-explain-analyst', { plan: '' });
  assert.equal(empty.success, false);

  const samplePlan = `Sort (cost=25000.00..25100.00 rows=40000 width=128)
  Sort Key: created_at DESC
  Sort Method: external merge Disk: 4096kB
  ->  Seq Scan on telemetry_events (cost=0.00..18450.00 rows=40000 width=128)
        Filter: (org_id = 99)
        Rows Removed by Filter: 850000
`;

  const res = executePlugin('sql-explain-analyst', { plan: samplePlan });
  assert.equal(res.success, true);
  assert.equal(res.hasSeqScan, true);
  assert.equal(res.hasDiskSort, true);
  assert.equal(res.hasHighFilterDrop, true);
  assert.equal(res.maxEstimatedCost, 25100.00);
  assert.ok(res.bottlenecks.some(b => b.includes('telemetry_events')));
  assert.ok(res.bottlenecks.some(b => b.includes('spilled to temporary disk')));
  assert.ok(res.recommendations.some(r => r.includes('B-Tree')));
  assert.match(res.narrationScript, /sequential table scan was identified/);
});

test('REST API: GET /api/plugins returns full list and counts', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/plugins`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.count, 8);
    assert.equal(data.plugins.length, 8);
  } finally {
    await close();
  }
});

test('REST API: POST /api/plugins/execute executes plugin with JSON payload', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/plugins/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pluginId: 'dsa-cinema',
        input: { pattern: 'two-pointers' },
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.patternName, 'Two Pointers Convergence');
  } finally {
    await close();
  }
});

test('REST API: POST /api/plugins/execute handles invalid requests cleanly', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    // Missing pluginId
    const res1 = await fetch(`${baseUrl}/api/plugins/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    });
    assert.equal(res1.status, 400);

    // Non-existent plugin
    const res2 = await fetch(`${baseUrl}/api/plugins/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginId: 'unknown-plug', input: {} }),
    });
    assert.equal(res2.status, 400);
    const data2 = await res2.json();
    assert.match(data2.error, /not found/i);
  } finally {
    await close();
  }
});

test('REST API: POST /api/plugins/toggle switches plugin status', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    // Disable plugin
    const resToggle = await fetch(`${baseUrl}/api/plugins/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginId: 'regex-decoder', enabled: false }),
    });
    assert.equal(resToggle.status, 200);
    const dataToggle = await resToggle.json();
    assert.equal(dataToggle.plugin.enabled, false);

    // Try executing disabled plugin
    const resExec = await fetch(`${baseUrl}/api/plugins/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginId: 'regex-decoder', input: { pattern: 'abc' } }),
    });
    assert.equal(resExec.status, 400);
    const dataExec = await resExec.json();
    assert.match(dataExec.error, /disabled/i);

    // Re-enable
    await fetch(`${baseUrl}/api/plugins/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginId: 'regex-decoder', enabled: true }),
    });
  } finally {
    resetPlugins();
    await close();
  }
});
