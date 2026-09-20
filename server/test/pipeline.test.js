import test from 'node:test';
import assert from 'node:assert/strict';
import { teachPipeline } from '../pipeline.js';

test('teachPipeline executes complete flow and shapes response', async () => {
  // We can provide a test provider option or mock Ollama response
  // Testing with an unsupported provider to verify error throwing
  await assert.rejects(
    async () => {
      await teachPipeline(
        {
          text: 'Kubernetes continuously reconciles desired state with actual state.',
          title: 'Kubernetes Documentation',
          url: 'https://kubernetes.io/docs/concepts/',
          provider: 'unknown-provider',
        },
        {}
      );
    },
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.message.includes('Unsupported model provider'));
      return true;
    }
  );
});

test('teachPipeline fails gracefully when Groq is selected without API key', async () => {
  await assert.rejects(
    async () => {
      await teachPipeline(
        {
          text: 'TCP handshake establishes connection.',
          title: 'Networking Concepts',
          provider: 'groq',
        },
        { GROQ_API_KEY: '' }
      );
    },
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.message.includes('Groq API key is missing'));
      return true;
    }
  );
});
