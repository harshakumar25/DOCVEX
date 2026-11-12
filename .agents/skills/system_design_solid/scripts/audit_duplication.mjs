#!/usr/bin/env node
/**
 * Audit script for the DocVex System Design & SOLID skill.
 * Detects duplicated canonical domain symbols across server, extension, dashboard, and Python workers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const checks = [
  {
    name: 'normalizeSpeechText implementations',
    pattern: /(export\s+)?(const|function)\s+normalizeSpeechText\b/g,
    files: [
      'server/prompt/speechNormalization.js',
      'extension/speechNormalization.js',
      'extension/speechCore.js',
    ],
    maxDefs: 1,
    allowReexports: true,
  },
  {
    name: 'shapeSpeechText implementations',
    pattern: /(export\s+)?(const|function)\s+shapeSpeechText\b/g,
    files: [
      'server/prompt/teacherPrompt.js',
      'extension/content.js',
      'extension/speechCore.js',
    ],
    maxDefs: 1,
  },
  {
    name: 'SentenceBuffer / ClientSentenceBuffer definitions',
    pattern: /class\s+(Client)?SentenceBuffer\b/g,
    files: [
      'server/prompt/sentenceBuffer.js',
      'extension/content.js',
      'extension/speechCore.js',
    ],
    maxDefs: 1,
  },
  {
    name: 'Voice selector implementations',
    pattern: /function\s+(selectBestSpeechVoice|pickBestVoice)\b/g,
    files: [
      'extension/voiceSelector.js',
      'extension/content.js',
      'demo.html',
    ],
    maxDefs: 1,
  },
  {
    name: 'Python choose_device / load_model implementations',
    pattern: /^def\s+(choose_device|load_model)\s*\(/gm,
    files: [
      'chatterbox/docvex_worker.py',
      'chatterbox/benchmark_docvex.py',
      'chatterbox/model_runtime.py',
    ],
    maxDefs: 2, // 1 choose_device + 1 load_model
  },
];

let hasWarnings = false;
console.log('=== DocVex SOLID & Duplication Audit ===\n');

for (const check of checks) {
  let count = 0;
  const locations = [];
  for (const rel of check.files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const matches = [...text.matchAll(check.pattern)];
    if (matches.length > 0) {
      count += matches.length;
      locations.push(`${rel} (${matches.length})`);
    }
  }
  const ok = count <= check.maxDefs && count > 0;
  const badge = ok ? 'PASS' : 'WARN';
  if (!ok) hasWarnings = true;
  console.log(`[${badge}] ${check.name}: ${count} definition(s) [target <= ${check.maxDefs}] -> ${locations.join(', ') || 'none'}`);
}

process.exitCode = hasWarnings ? 1 : 0;

