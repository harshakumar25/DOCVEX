import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FloorHolder } from '../prismaguard/sidecar/floorHolder.js';
import {
  extractJsonString,
  sanitizeAndCastToolArguments,
  isTokenAllowedUnderCFG,
} from '../prismaguard/sidecar/cfgLogitMasker.js';
import { AtomicToolProxy } from '../prismaguard/sidecar/atomicToolProxy.js';

describe('PrismaGuard Runtime Sidecar (Floor-Holding, CFG Masking & Atomic Tool Proxy)', () => {
  describe('FloorHolder (Speculative Floor-Holding)', () => {
    it('emits natural Indic filler when model reasoning latency exceeds threshold', async () => {
      const holder = new FloorHolder({
        language: 'hi-IN',
        delayThresholdMs: 50, // fast for testing
      });

      let emittedFiller = null;
      const { promise } = holder.scheduleFloorHold((filler) => {
        emittedFiller = filler;
      });

      const res = await promise;
      assert.ok(res !== null, 'Filler must be emitted');
      assert.ok(emittedFiller !== null, 'Callback must receive filler');
      assert.ok(typeof emittedFiller.text === 'string' && emittedFiller.text.length > 0);
      assert.strictEqual(holder.isHoldingFloor, true);
    });

    it('cancels floor hold cleanly if agent responds before latency threshold', async () => {
      const holder = new FloorHolder({
        language: 'hi-IN',
        delayThresholdMs: 100,
      });

      let emittedFiller = null;
      const { cancel, promise } = holder.scheduleFloorHold((filler) => {
        emittedFiller = filler;
      });

      // Simulate fast model responding in 20ms
      await new Promise((r) => setTimeout(r, 20));
      cancel();

      const res = await promise;
      assert.strictEqual(res, null, 'Must return null on cancellation');
      assert.strictEqual(emittedFiller, null, 'Callback must not be invoked');
      assert.strictEqual(holder.isHoldingFloor, false);
    });

    it('rotates through fillers without immediate repetition', () => {
      const holder = new FloorHolder({ language: 'hi-IN' });
      const f1 = holder.getNextFiller();
      const f2 = holder.getNextFiller();
      assert.notStrictEqual(f1.text, f2.text, 'Sequential fillers should vary');
    });
  });

  describe('CfgLogitMasker (Schema-Constrained Decoding & Sanitization)', () => {
    it('extractJsonString strips markdown fences and conversational banter', () => {
      const rawWithMarkdown = 'Sure, here is the function call:\n```json\n{"amount": 5000, "date": "tomorrow"}\n```\nHope that helps!';
      const extracted = extractJsonString(rawWithMarkdown);
      assert.strictEqual(extracted, '{"amount": 5000, "date": "tomorrow"}');

      const rawBare = '{"status": "ok"}';
      assert.strictEqual(extractJsonString(rawBare), '{"status": "ok"}');
    });

    it('sanitizeAndCastToolArguments coerces string numbers to integers when required by schema', () => {
      const schema = {
        required: ['accountId', 'amount'],
        properties: {
          accountId: { type: 'string', minLength: 3 },
          amount: { type: 'integer', minimum: 100 },
          confirmed: { type: 'boolean' },
        },
      };

      // Raw 4B SLM output with stringified numbers and booleans
      const rawModelOutput = '```json\n{"accountId": "ACC-9921", "amount": "8450", "confirmed": "true"}\n```';

      const result = sanitizeAndCastToolArguments(rawModelOutput, schema);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.arguments.amount, 8450, 'Must coerce "8450" string to 8450 integer');
      assert.strictEqual(result.arguments.confirmed, true, 'Must coerce "true" string to boolean true');
      assert.strictEqual(result.arguments.accountId, 'ACC-9921');
    });

    it('sanitizeAndCastToolArguments catches missing fields and bounds violations', () => {
      const schema = {
        required: ['amount'],
        properties: {
          amount: { type: 'integer', minimum: 500 },
        },
      };

      const invalidOutput = '{"amount": 250}';
      const result = sanitizeAndCastToolArguments(invalidOutput, schema);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('below minimum 500')));
    });

    it('isTokenAllowedUnderCFG blocks illegal token injection', () => {
      assert.strictEqual(isTokenAllowedUnderCFG('{"key": ', '```'), false);
      assert.strictEqual(isTokenAllowedUnderCFG('{"key": ', '"value"'), true);
    });

    it('sanitizeAndCastToolArguments rejects and strips prototype pollution attempts (__proto__, constructor)', () => {
      const schema = {
        required: ['accountId'],
        properties: {
          accountId: { type: 'string' },
        },
      };

      const maliciousPayload = '{"accountId": "ACC-01", "__proto__": {"polluted": true}, "constructor": {"polluted": true}}';
      const result = sanitizeAndCastToolArguments(maliciousPayload, schema);

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.arguments.accountId, 'ACC-01');
      assert.strictEqual({}.polluted, undefined, 'Global prototype must not be polluted');
    });
  });

  describe('AtomicToolProxy (Atomic In-Flight Cancellation)', () => {
    it('executes successful tool invocation with COMMITTED status', async () => {
      const proxy = new AtomicToolProxy();
      const res = await proxy.execute('tool-call-1', 'check_balance', async (signal) => {
        return { balance: 45000, currency: 'INR' };
      });

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.aborted, false);
      assert.strictEqual(res.result.balance, 45000);

      const tele = proxy.getTelemetry();
      assert.strictEqual(tele.history.length, 1);
      assert.strictEqual(tele.history[0].status, 'COMMITTED');
    });

    it('aborts in-flight tool call on caller barge-in and triggers rollback hook', async () => {
      const proxy = new AtomicToolProxy();
      let rollbackInvokedWith = null;

      const toolPromise = proxy.execute(
        'tool-call-2',
        'execute_transfer',
        async (signal) => {
          // Simulate slow banking API taking 200ms
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 200);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(signal.reason);
            });
          });
          return { status: 'TRANSFERRED' };
        },
        async (abortedCallId) => {
          rollbackInvokedWith = abortedCallId;
        }
      );

      // Caller interrupts at t = 30ms
      await new Promise((r) => setTimeout(r, 30));
      const aborted = proxy.abort('tool-call-2', 'Caller shouted: Nahi ruko');
      assert.strictEqual(aborted, true);

      const res = await toolPromise;
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.aborted, true);
      assert.strictEqual(rollbackInvokedWith, 'tool-call-2', 'Rollback hook must be called with callId');

      const tele = proxy.getTelemetry();
      assert.strictEqual(tele.history[0].status, 'ABORTED');
    });

    it('abortAll cancels all active in-flight calls on global hangup', async () => {
      const proxy = new AtomicToolProxy();

      const p1 = proxy.execute('call-a', 'tool_a', async (signal) => {
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        });
      });

      const p2 = proxy.execute('call-b', 'tool_b', async (signal) => {
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        });
      });

      const abortedCount = proxy.abortAll('Caller hung up');
      assert.strictEqual(abortedCount, 2);

      const [r1, r2] = await Promise.all([p1, p2]);
      assert.strictEqual(r1.aborted, true);
      assert.strictEqual(r2.aborted, true);
    });
  });
});

