// DocVex Plugin Architecture — Zero-Dependency Modular Integration Subsystem

/**
 * Plugin 1: Obsidian Vault Exporter
 * Formats acoustic sessions as Obsidian-compliant Markdown with frontmatter, wikilinks, and callouts.
 */
const obsidianVaultPlugin = {
  id: 'obsidian-vault',
  name: 'Obsidian Knowledge Graph Exporter',
  category: 'Knowledge Base',
  version: '1.0.0',
  icon: '💎',
  description: 'Converts acoustic sessions into Obsidian-compatible markdown with frontmatter metadata, [[wikilinks]], tags, and rich callouts.',
  enabled: true,
  execute: (input = {}) => {
    const session = input.session || input;
    const title = session.title || 'Technical Concept';
    const category = session.category || 'Algorithms';
    const timestamp = session.timestamp || new Date().toISOString();
    const provider = session.provider || 'hybrid';
    const snippet = session.snippet || '';
    const mentalModel = session.mentalModel || session.explanation || '';
    const diagram = session.diagram || '';
    const gotchas = session.gotchas || '';
    const sentences = Array.isArray(session.sentences) ? session.sentences : [];

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const filename = `${slug || 'concept'}.md`;

    let md = '---\n';
    md += `title: "${title.replace(/"/g, '\\"')}"\n`;
    md += `category: "${category}"\n`;
    md += `date: ${timestamp}\n`;
    md += `provider: ${provider}\n`;
    md += `tags:\n  - docvex\n  - acoustic-learning\n  - ${category.toLowerCase().replace(/[^a-z0-9]/g, '-')}\n`;
    md += '---\n\n';

    md += `# ${title}\n\n`;
    md += `> [!abstract] Spatial Mental Cinema\n`;
    md += `> ${mentalModel}\n\n`;

    if (diagram) {
      md += `> [!example] Mechanical Blueprint\n`;
      md += '```text\n' + diagram + '\n```\n\n';
    }

    if (gotchas) {
      md += `> [!warning] Critical Gotchas & Pitfalls\n`;
      md += gotchas.split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
    }

    md += `## Original Technical Passage\n\n`;
    md += '```text\n' + snippet + '\n```\n\n';

    if (sentences.length > 0) {
      md += `## Acoustic Narration Transcript\n\n`;
      sentences.forEach((s, idx) => {
        md += `${idx + 1}. ${s.text}`;
        if (s.pauseAfterMs && s.pauseAfterMs > 0) {
          md += ` *(+${s.pauseAfterMs}ms pause)*`;
        }
        md += '\n';
      });
      md += '\n';
    }

    md += `## Related Concepts\n\n`;
    md += `- [[${category}]]\n`;
    md += `- [[DocVex Acoustic Library]]\n`;

    return {
      success: true,
      filename,
      content: md,
      format: 'markdown/obsidian',
      wordCount: md.trim().split(/\s+/).length,
    };
  },
};

/**
 * Plugin 2: Anki Spaced-Repetition Deck Generator
 * Extracts high-yield flashcards with cloze deletions ({{c1::...}}) for long-term algorithmic retention.
 */
const ankiDeckPlugin = {
  id: 'anki-deck',
  name: 'Anki Spaced-Repetition Generator',
  category: 'Active Recall',
  version: '1.0.0',
  icon: '🎴',
  description: 'Generates active recall flashcards with cloze deletions ({{c1::...}}) and Anki-importable TSV rows from acoustic sessions.',
  enabled: true,
  execute: (input = {}) => {
    const sessions = Array.isArray(input.sessions) 
      ? input.sessions 
      : (input.session ? [input.session] : [input]);

    const cards = [];
    let tsv = '#separator:tab\n#html:true\n#tags column:3\n';

    sessions.forEach((s) => {
      const title = s.title || 'Technical Concept';
      const category = (s.category || 'Algorithms').replace(/[^a-zA-Z0-9]/g, '_');
      const mental = s.mentalModel || s.explanation || '';
      const snippet = s.snippet || '';
      const gotchas = s.gotchas || '';

      // Card 1: Concept to Mental Model Analogy
      const front1 = `<b>What is the physical mental model for:</b><br/><code>${title}</code>`;
      const back1 = `<b>Spatial Analogy:</b><br/>${mental}<br/><br/><small>Passage:</small><br/><pre>${snippet.slice(0, 300)}</pre>`;
      const tag1 = `docvex ${category} mental_model`;
      cards.push({ front: front1, back: back1, tag: tag1 });
      tsv += `${front1}\t${back1}\t${tag1}\n`;

      // Card 2: Cloze Deletion for Key Gotchas (if present)
      if (gotchas) {
        const clozeFront = `<b>${title} — Critical Gotcha:</b><br/>` + 
          gotchas.replace(/(\b[a-zA-Z]{3,}\b)/, '{{c1::$1}}');
        const clozeBack = `<b>Complete Gotcha Reference:</b><br/>${gotchas}`;
        const tag2 = `docvex ${category} gotchas`;
        cards.push({ front: clozeFront, back: clozeBack, tag: tag2 });
        tsv += `${clozeFront}\t${clozeBack}\t${tag2}\n`;
      }
    });

    return {
      success: true,
      cardCount: cards.length,
      cards,
      tsv,
      filename: `docvex_anki_deck_${Date.now()}.txt`,
    };
  },
};

/**
 * Plugin 3: Git Diff & Pull Request Acoustic Auditor
 * Parses unified git diff patches, filters noise, identifies key architectural modifications,
 * and generates a spoken walkthrough script.
 */
const gitDiffAuditorPlugin = {
  id: 'git-diff-auditor',
  name: 'Git Diff Acoustic Auditor',
  category: 'VCS & Review',
  version: '1.0.0',
  icon: '🌿',
  description: 'Parses unified git diffs, filters noise, identifies structural additions and deletions, and prepares an acoustic architectural summary.',
  enabled: true,
  execute: (input = {}) => {
    const diffText = (typeof input === 'string' ? input : input.diff || input.text || '').trim();
    if (!diffText) {
      return {
        success: false,
        error: 'Missing git diff input text.',
      };
    }

    const lines = diffText.split('\n');
    const filesModified = [];
    let addedCount = 0;
    let deletedCount = 0;
    let currentFile = null;
    const keyChanges = [];

    for (const line of lines) {
      if (line.startsWith('diff --git') || line.startsWith('+++ b/')) {
        const match = line.match(/(?:b\/|\s)([^\s]+)$/);
        if (match && match[1] && match[1] !== '/dev/null') {
          currentFile = match[1].replace(/^b\//, '');
          if (!filesModified.includes(currentFile)) {
            filesModified.push(currentFile);
          }
        }
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        addedCount++;
        const content = line.slice(1).trim();
        if (content.length > 10 && !content.startsWith('//') && !content.startsWith('/*')) {
          if (keyChanges.length < 5) keyChanges.push(`Added: ${content}`);
        }
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletedCount++;
      }
    }

    const summaryScript = `This pull request modifies ${filesModified.length} file${filesModified.length === 1 ? '' : 's'}: ` +
      `${filesModified.slice(0, 3).join(', ')}${filesModified.length > 3 ? ' and others' : ''}. ` +
      `It introduces ${addedCount} line additions and ${deletedCount} deletions. ` +
      `The core architectural changes center around ${filesModified[0] || 'the codebase'}. ` +
      `Listen closely for changes to state mutation boundaries and concurrency safety.`;

    return {
      success: true,
      filesModified,
      addedCount,
      deletedCount,
      summaryScript,
      keyChanges,
      narratablePassage: `Git Diff Summary for ${filesModified.join(', ')}:\n` +
        `Additions: +${addedCount}, Deletions: -${deletedCount}\n` +
        `Key modified lines:\n` + keyChanges.join('\n'),
    };
  },
};

/**
 * Plugin 4: LeetCode & DSA Mental Cinema Deconstructor
 * Generates spatial ASCII timeline diagrams, step-by-step invariant checkpoints,
 * and mechanical cognitive anchors for algorithmic patterns.
 */
const dsaCinemaPlugin = {
  id: 'dsa-cinema',
  name: 'DSA Mental Cinema Deconstructor',
  category: 'Algorithms',
  version: '1.0.0',
  icon: '🎬',
  description: 'Deconstructs common algorithmic patterns (Sliding Window, Two Pointers, Monotonic Stack, Interval Merging) into spatial diagrams and invariant rules.',
  enabled: true,
  execute: (input = {}) => {
    const pattern = (input.pattern || input.topic || input.text || 'sliding-window').toLowerCase();

    const PATTERNS = {
      'sliding-window': {
        name: 'Sliding Window Invariant',
        analogy: 'A movable optical lens sliding along a tape measure. Expand the right boundary to satisfy conditions, contract the left boundary when invariants are violated.',
        diagram: 'Array: [ 2,  1,  5,  1,  3,  2 ]\n       └────── Window ──────┘\n         L (Left)           R (Right) ──> Expands\n         Contract when sum > Target',
        invariants: [
          'Right pointer advances monotonically to explore candidates.',
          'Left pointer catches up to restore validity.',
          'Time Complexity is strict O(N) because each element enters and exits the window exactly once.',
        ],
      },
      'two-pointers': {
        name: 'Two Pointers Convergence',
        analogy: 'Two inspectors starting at opposite ends of a bridge walking toward each other, comparing measurements until they meet in the center.',
        diagram: 'Sorted Array: [ 1,  2,  4,  7,  11,  15 ]\n              ▲                         ▲\n            Left                      Right\n            (Sum < Target ➔ L++)     (Sum > Target ➔ R--)',
        invariants: [
          'Sorted monotonic property ensures eliminating elements is irreversible and optimal.',
          'Pointers meet in at most N iterations: O(N) time and O(1) space.',
        ],
      },
      'monotonic-stack': {
        name: 'Monotonic Stack Horizon',
        analogy: 'A skyline of skyscrapers viewed from the horizon. Taller buildings immediately obscure shorter ones behind them, leaving only an ascending or descending staircase.',
        diagram: 'Incoming: [ 4, 2, 7 ]\nStack State: [ 4 ] ──> [ 4, 2 ] ──> [ 7 ] (Pops 2 and 4 because 7 is greater)\nTop of stack always holds the Next Greater Element.',
        invariants: [
          'Maintains strictly increasing or decreasing order by popping violators.',
          'Solves Next Greater Element, Stock Span, and Largest Histogram Rectangle in O(N) time.',
        ],
      },
      'topological-sort': {
        name: "Topological Sort / Kahn's Algorithm",
        analogy: 'A domino chain where a tile can only fall once every predecessor tile leading directly to it has finished falling.',
        diagram: 'Graph Dependencies:\n[Task A] ──> [Task B] ──┐\n                        ├───> [Task D (In-degree = 0)] ➔ Execute\n[Task C] ───────────────┘',
        invariants: [
          'Track in-degree (number of prerequisite edges) for every vertex.',
          'Enqueue all nodes with in-degree zero; decrement child in-degrees upon processing.',
          'If processed count < Total nodes, an unresolvable cyclic dependency exists.',
        ],
      },
    };

    let matched = null;
    for (const [key, val] of Object.entries(PATTERNS)) {
      if (pattern.includes(key) || pattern.includes(key.replace('-', ' '))) {
        matched = val;
        break;
      }
    }

    if (!matched) {
      matched = PATTERNS['sliding-window'];
    }

    const narrationScript = `To solve ${matched.name}, visualize ${matched.analogy} ` +
      `Remember the critical invariant: ${matched.invariants[0]}`;

    return {
      success: true,
      patternName: matched.name,
      analogy: matched.analogy,
      diagram: matched.diagram,
      invariants: matched.invariants,
      narrationScript,
    };
  },
};

/**
 * Plugin 5: Podcast & Commute Episode Compiler
 * Stitches multiple learning sessions into an episodic narrative transcript for offline audio listening.
 */
const podcastCompilerPlugin = {
  id: 'podcast-compiler',
  name: 'Podcast & Commute Episode Compiler',
  category: 'Audio Production',
  version: '1.0.0',
  icon: '🎙️',
  description: 'Compiles multiple acoustic learning sessions into a continuous structured audio episode with introductions, chapter markers, and transition pauses.',
  enabled: true,
  execute: (input = {}) => {
    const sessions = Array.isArray(input.sessions) ? input.sessions : [];
    if (sessions.length === 0) {
      return {
        success: false,
        error: 'No sessions provided to compile into a podcast episode.',
      };
    }

    const episodeTitle = input.episodeTitle || `DocVex Deep Dive: ${sessions[0].category || 'Engineering Systems'}`;
    let script = `Welcome to this DocVex acoustic learning episode: ${episodeTitle}.\n`;
    script += `Today we are exploring ${sessions.length} core technical mechanisms.\n\n`;

    const chapters = [];

    sessions.forEach((s, idx) => {
      const chTitle = s.title || `Chapter ${idx + 1}`;
      chapters.push({
        chapterIndex: idx + 1,
        title: chTitle,
        category: s.category || 'General',
      });

      script += `--- Chapter ${idx + 1}: ${chTitle} ---\n`;
      script += `First, the spatial mental model: ${s.mentalModel || s.explanation || ''}\n\n`;
      if (s.sentences && s.sentences.length > 0) {
        script += s.sentences.map(st => st.text).join(' ') + '\n\n';
      }
      if (s.gotchas) {
        script += `Pay special attention to this pitfall: ${s.gotchas.slice(0, 150)}...\n\n`;
      }
      script += `[Musical Interlude — 3 Second Pause]\n\n`;
    });

    script += `This concludes our DocVex acoustic deep dive into ${episodeTitle}. Keep building with spatial clarity.`;

    return {
      success: true,
      episodeTitle,
      chapterCount: sessions.length,
      chapters,
      compiledScript: script,
      estimatedDurationMinutes: Math.round(script.split(/\s+/).length / 140),
    };
  },
};

/**
 * Plugin 6: Distributed Systems Architect
 * Deconstructs distributed consensus, partitioning, and storage topologies
 * into failure domains, CAP trade-offs, and acoustic walk-throughs.
 */
const systemDesignArchitectPlugin = {
  id: 'system-design-architect',
  name: 'Distributed Systems Architect',
  category: 'Databases & Systems',
  version: '1.0.0',
  icon: '🌐',
  description: 'Deconstructs distributed systems patterns (Raft consensus, Consistent Hashing, LSM-trees, Event Sourcing) into ASCII topology diagrams, failure domains, and acoustic walkthroughs.',
  enabled: true,
  execute: (input = {}) => {
    const topic = (input.topic || input.system || input.text || 'consistent-hashing').toLowerCase();

    const TOPOLOGIES = {
      'consistent-hashing': {
        name: 'Consistent Hashing Ring',
        category: 'Partitioning & Routing',
        analogy: 'A circular roulette wheel with 2^32 slots. Both storage servers and incoming data keys hash onto positions on this ring. Keys walk clockwise until they hit the nearest server node.',
        asciiDiagram: '               [Node A (0°)]\n             .       |       .\n       [Node D]      |        [Node B (90°)]\n            \\        |        /\n             \\   (Key: user_42)\n              .      |       .\n               [Node C (180°)]\n     Remap cost on node churn: Only K/N keys moved!',
        capClassification: 'AP (High Availability / Partition Tolerant with Virtual Nodes)',
        failureDomains: [
          'Non-uniform data skew mitigated by virtual tokens per physical node.',
          'Cascading hotspot load during sudden node death mitigated by replication factor R=3.',
        ],
        narrationScript: 'In a Consistent Hashing ring, imagine a 360-degree clock. Both your servers and your keys hash into positions on this clock. ' +
          'A key always walks clockwise until it lands on the first available node. When a node dies, only its immediate clockwise segment transfers to the next neighbor, avoiding complete cluster re-shuffling.',
      },
      'raft-consensus': {
        name: 'Raft Distributed Consensus',
        category: 'Consensus & Coordination',
        analogy: 'A disciplined parliament with a single elected Prime Minister. If the Prime Minister stops sending heartbeats, members hold a timed runoff election with randomized countdown clocks to avoid split votes.',
        asciiDiagram: '  [Client Request]\n         │\n         ▼\n  ┌──────────────┐   AppendEntries Heartbeat (50ms)\n  │ Leader Node  ├────────────────────────┬─────────────┐\n  └──────┬───────┘                        ▼             ▼\n         │ Commit Index           ┌─────────────┐ ┌─────────────┐\n         ▼                        │ Follower 1  │ │ Follower 2  │\n  [State Machine Apply]           └─────────────┘ └─────────────┘',
        capClassification: 'CP (Strict Consistency / Partition Tolerant, halts writes during quorum loss)',
        failureDomains: [
          'Split-vote deadlock prevented by randomized election timeouts (150ms - 300ms).',
          'Split-brain prevented by requiring strict majority quorum (N/2 + 1) for all log commits.',
        ],
        narrationScript: 'Raft achieves consensus by decomposing state into leader election and log replication. ' +
          'The leader handles all client writes, appends them to its local log, and replicates them to followers. Once a strict majority confirms receipt, the entry is committed to the state machine.',
      },
      'lsm-trees': {
        name: 'Log-Structured Merge-Tree (LSM)',
        category: 'Storage Engines',
        analogy: 'A busy accountant writing receipts onto a fast scratchpad in memory. Once the scratchpad fills up, it gets stamped as an immutable book on the shelf, and background clerks periodically merge redundant books.',
        asciiDiagram: ' Writes ──> [ Write-Ahead Log (Disk Disk-Seq) ]\n    │\n    ▼\n [ In-Memory MemTable (SkipList) ] ──(Flush)──>\n                                       [ SSTable Level 0 ]\n                                       [ SSTable Level 1 ] (Compacted)\n Reads  <── [ Bloom Filter Guard ] <── [ Sorted String Tables ]',
        capClassification: 'Storage Engine (Optimized for massive sequential write throughput)',
        failureDomains: [
          'Read amplification: A missing key might check multiple SSTable levels; defended by in-memory Bloom filters.',
          'Write stalls: Unchecked MemTable ingestion exceeding background compaction bandwidth.',
        ],
        narrationScript: 'Log-Structured Merge Trees turn slow random disk writes into high-speed sequential writes. ' +
          'Incoming writes append to an in-memory MemTable and write-ahead log. When full, the MemTable flushes to immutable SSTables on disk, while background threads continuously compact and merge sorted levels.',
      },
      'event-sourcing': {
        name: 'Event Sourcing & CQRS',
        category: 'Data Modeling & Auditability',
        analogy: 'A bank ledger where transactions are never overwritten or deleted. Your current balance is never a stored number; it is dynamically calculated by replaying all historical deposit and withdrawal events.',
        asciiDiagram: '  Command ──> [ Aggregate ] ──> Emit Event (OrderCreated)\n                                        │\n                                        ▼\n                             [ Immutable Event Store ]\n                                        │ (Project)\n                                        ▼\n                             [ Read-Optimized View DB ]',
        capClassification: 'Eventual Consistency (High write throughput, zero destructive mutations)',
        failureDomains: [
          'Long replay times on high-volume aggregates solved by periodic snapshotting.',
          'Schema evolution across historic event streams requiring upcasters.',
        ],
        narrationScript: 'Event Sourcing replaces mutable CRUD states with an append-only sequence of immutable domain events. ' +
          'Instead of updating a database row, every action records a historical fact. Read models are generated asynchronously by projecting event streams into query-optimized views.',
      },
    };

    let matched = null;
    for (const [key, val] of Object.entries(TOPOLOGIES)) {
      const normalizedKey = key.replace('-', ' ');
      if (topic.includes(key) || topic.includes(normalizedKey) || (topic.length >= 3 && key.startsWith(topic))) {
        matched = val;
        break;
      }
    }

    if (!matched) {
      matched = TOPOLOGIES['consistent-hashing'];
    }

    return {
      success: true,
      systemName: matched.name,
      category: matched.category,
      analogy: matched.analogy,
      asciiDiagram: matched.asciiDiagram,
      capClassification: matched.capClassification,
      failureDomains: matched.failureDomains,
      narrationScript: matched.narrationScript,
    };
  },
};

/**
 * Plugin 7: Regex Verbal Decoder & ReDoS Guard
 * Deconstructs complex Regular Expressions into spoken narratives and audits catastrophic backtracking hazards.
 */
const regexDecoderPlugin = {
  id: 'regex-decoder',
  name: 'Regex Verbal Decoder & ReDoS Guard',
  category: 'Dev Tools',
  version: '1.0.0',
  icon: '🔍',
  description: 'Deconstructs cryptographic regular expressions into plain-English verbal walkthroughs and analyzes catastrophic backtracking (ReDoS) hazards.',
  enabled: true,
  execute: (input = {}) => {
    const rawPattern = (typeof input === 'string' ? input : input.pattern || input.regex || input.text || '').trim();
    if (!rawPattern) {
      return {
        success: false,
        error: 'Missing regular expression pattern to decode.',
      };
    }

    const match = rawPattern.match(/^\/(.*)\/([gimsuy]*)$/);
    const pattern = match ? match[1] : rawPattern;
    const flags = match ? match[2] : (input.flags || '');

    const tokens = [];
    let redosRisk = 'LOW';
    const redosWarnings = [];

    if (/(\([^()]*\+[^()]*\)\+|\([^()]*\+[^()]*\)\*|\([^()]*\*[^()]*\)\+|\([^()]*\*[^()]*\)\*)/.test(pattern)) {
      redosRisk = 'CRITICAL';
      redosWarnings.push('Nested quantifiers detected: e.g. (a+)+ or (x*)+ causes O(2^N) catastrophic backtracking on mismatch.');
    } else if (/(\w+\|)+|\([^)]*\|[^)]*\)\+/.test(pattern)) {
      redosRisk = 'MEDIUM';
      redosWarnings.push('Overlapping alternation inside repetition: verify anchor boundaries to prevent polynomial stalling.');
    }

    if (pattern.startsWith('^')) {
      tokens.push({ symbol: '^', meaning: 'Anchor: Asserts beginning of string or line.' });
    }
    if (pattern.includes('\\b')) {
      tokens.push({ symbol: '\\b', meaning: 'Word boundary: Asserts position between word character and non-word character.' });
    }
    if (pattern.includes('(?=')) {
      tokens.push({ symbol: '(?=...)', meaning: 'Positive Lookahead: Asserts following characters match pattern without consuming them.' });
    }
    if (pattern.includes('(?!')) {
      tokens.push({ symbol: '(?!...)', meaning: 'Negative Lookahead: Asserts following characters do NOT match pattern.' });
    }
    if (pattern.includes('(?:')) {
      tokens.push({ symbol: '(?:...)', meaning: 'Non-capturing Group: Groups tokens together without storing captured reference.' });
    }
    if (pattern.includes('[') && pattern.includes(']')) {
      tokens.push({ symbol: '[...]', meaning: 'Character Class: Matches any single character enclosed within the brackets.' });
    }
    if (pattern.includes('+')) {
      tokens.push({ symbol: '+', meaning: 'Greedy Quantifier: Matches 1 or more occurrences of preceding element.' });
    }
    if (pattern.includes('*')) {
      tokens.push({ symbol: '*', meaning: 'Greedy Quantifier: Matches 0 or more occurrences of preceding element.' });
    }
    if (pattern.includes('?')) {
      tokens.push({ symbol: '?', meaning: 'Optional Quantifier: Matches 0 or 1 occurrence of preceding element.' });
    }
    if (pattern.endsWith('$')) {
      tokens.push({ symbol: '$', meaning: 'Anchor: Asserts end of string or line.' });
    }

    const tokenSummary = tokens.length > 0 
      ? ` Key assertions detected: ${tokens.map(t => `${t.symbol} [${t.meaning.split(':')[0]}]`).join(', ')}.` 
      : '';
    const verbalExplanation = `This regular expression evaluates strings against pattern "${pattern}"${flags ? ` with flags [${flags}]` : ''}. ` +
      `It uses ${tokens.length} distinct structural assertions.${tokenSummary} ` +
      `Security Audit: ReDoS hazard risk is rated ${redosRisk}. ${redosWarnings.length > 0 ? redosWarnings[0] : 'No exponential backtracking risks detected.'}`;

    return {
      success: true,
      rawPattern,
      pattern,
      flags,
      tokens,
      redosRisk,
      redosWarnings,
      verbalExplanation,
      safeToUse: redosRisk !== 'CRITICAL',
    };
  },
};

/**
 * Plugin 8: SQL Explain Query Plan Analyst
 * Analyzes PostgreSQL / MySQL EXPLAIN query plans, pinpoints expensive sequential scans
 * and missing index bottlenecks, and formulates spoken tuning advice.
 */
const sqlExplainAnalystPlugin = {
  id: 'sql-explain-analyst',
  name: 'SQL Explain Query Plan Analyst',
  category: 'Databases & Systems',
  version: '1.0.0',
  icon: '⚡',
  description: 'Parses SQL EXPLAIN and EXPLAIN ANALYZE query plans, identifies sequential table scans, sort spills to disk, and formulates acoustic optimization guidance.',
  enabled: true,
  execute: (input = {}) => {
    const planText = (typeof input === 'string' ? input : input.plan || input.text || '').trim();
    if (!planText) {
      return {
        success: false,
        error: 'Missing SQL EXPLAIN query plan text.',
      };
    }

    const lines = planText.split('\n');
    const bottlenecks = [];
    const recommendations = [];
    let hasSeqScan = false;
    let hasDiskSort = false;
    let hasHighFilterDrop = false;
    let maxCost = 0;

    for (const line of lines) {
      const costMatch = line.match(/cost=[\d.]+\.\.([\d.]+)/);
      if (costMatch && costMatch[1]) {
        const costVal = parseFloat(costMatch[1]);
        if (costVal > maxCost) maxCost = costVal;
      }

      if (/Seq Scan on (\w+)/i.test(line)) {
        hasSeqScan = true;
        const tbl = line.match(/Seq Scan on (\w+)/i)[1];
        bottlenecks.push(`Sequential full-table scan on table "${tbl}".`);
        recommendations.push(`Add a B-Tree or compound index on "${tbl}" targeting the WHERE/JOIN filter columns.`);
      }

      if (/Rows Removed by Filter: (\d+)/i.test(line)) {
        const removed = parseInt(line.match(/Rows Removed by Filter: (\d+)/i)[1], 10);
        if (removed > 1000) {
          hasHighFilterDrop = true;
          bottlenecks.push(`Heavy filtering after fetch: ${removed} rows discarded post-scan.`);
        }
      }

      if (/Sort Method: external merge Disk/i.test(line) || /spill to disk/i.test(line)) {
        hasDiskSort = true;
        bottlenecks.push('Sort operation exceeded memory limits and spilled to temporary disk files.');
        recommendations.push('Increase work_mem setting for this session or add an index matching the ORDER BY clause.');
      }
    }

    if (bottlenecks.length === 0) {
      bottlenecks.push('No obvious performance catastrophes detected in snippet.');
      recommendations.push('Plan utilizes existing indexes or has small cardinality.');
    }

    const narrationScript = `Query plan analysis reveals ${bottlenecks.length} potential bottleneck${bottlenecks.length === 1 ? '' : 's'}. ` +
      `${hasSeqScan ? 'A sequential table scan was identified, indicating missing indexes. ' : ''}` +
      `${hasDiskSort ? 'Disk sort spills were detected, creating I/O latency. ' : ''}` +
      `Primary recommendation: ${recommendations[0]}`;

    return {
      success: true,
      maxEstimatedCost: maxCost,
      bottlenecks,
      recommendations,
      hasSeqScan,
      hasDiskSort,
      hasHighFilterDrop,
      narrationScript,
    };
  },
};

// Plugin Registry — 8 Complete Zero-Dependency Plugins
const PLUGINS = [
  obsidianVaultPlugin,
  ankiDeckPlugin,
  gitDiffAuditorPlugin,
  dsaCinemaPlugin,
  podcastCompilerPlugin,
  systemDesignArchitectPlugin,
  regexDecoderPlugin,
  sqlExplainAnalystPlugin,
];

/**
 * Returns metadata list of all registered plugins.
 */
export function listPlugins() {
  return PLUGINS.map(p => ({
    id: p.id,
    name: p.name,
    category: p.category,
    version: p.version,
    icon: p.icon,
    description: p.description,
    enabled: p.enabled,
  }));
}

/**
 * Retrieves a specific plugin by ID.
 */
export function getPlugin(id) {
  return PLUGINS.find(p => p.id === id) || null;
}

/**
 * Toggles a plugin's enabled status.
 */
export function setPluginEnabled(id, enabled) {
  const plugin = getPlugin(id);
  if (!plugin) return null;
  plugin.enabled = Boolean(enabled);
  return { id: plugin.id, enabled: plugin.enabled };
}

/**
 * Executes a registered plugin safely.
 */
export function executePlugin(id, input = {}) {
  const plugin = getPlugin(id);
  if (!plugin) {
    return { success: false, error: `Plugin "${id}" not found.` };
  }
  if (!plugin.enabled) {
    return { success: false, error: `Plugin "${plugin.name}" is currently disabled.` };
  }
  try {
    return plugin.execute(input);
  } catch (err) {
    return { success: false, error: `Execution error in "${plugin.name}": ${err.message}` };
  }
}

/**
 * Resets plugins to their default enabled states.
 */
export function resetPlugins() {
  PLUGINS.forEach(p => { p.enabled = true; });
}
