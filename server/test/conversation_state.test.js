import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  CONVERSATION_STATES,
  DocyConversationState,
  isDenyCommand,
  isProceedCommand,
  looksLikePromptOrInstruction,
} from '../../extension/conversationState.js';
import { buildFollowUpPrompt, DOCY_FOLLOWUP_SYSTEM_PROMPT } from '../prompt/teacherPrompt.js';
import { transcribeAudioWithGroq } from '../providers/groqProvider.js';
import { createServer, validateTeachInput } from '../server.js';
import { streamTeachPipeline } from '../pipeline.js';

test('DocyConversationState tracks main sentences, preserves progress across follow-up + Deny, and Proceeds with remaining sentences', () => {
  const conv = new DocyConversationState();
  assert.equal(conv.state, CONVERSATION_STATES.IDLE);

  conv.startMainSession({ selectedText: 'const x = [1, 2].map(n => n * 2);' });
  assert.equal(conv.state, CONVERSATION_STATES.MAIN_TEACHING);

  const i0 = conv.recordMainSentence('First, map creates a new array.');
  const i1 = conv.recordMainSentence('Each number n is multiplied by two.');
  const i2 = conv.recordMainSentence('So the result becomes two and four.');
  assert.deepEqual([i0, i1, i2], [0, 1, 2]);

  // Sentence 0 finished playing; user interrupts during sentence 1
  conv.markMainSentenceCompleted(0);
  conv.beginListening();
  assert.equal(conv.state, CONVERSATION_STATES.INTERRUPTED_LISTENING);

  conv.startFollowUp('tell me the actual output');
  assert.equal(conv.state, CONVERSATION_STATES.FOLLOWUP_ANSWERING);

  const afterFirst = conv.completeFollowUp('The actual output is the array 2, 4.');
  assert.equal(afterFirst, CONVERSATION_STATES.ASK_CONTINUE);

  // User denies continuing and gives another prompt -> mainSession MUST remain intact
  assert.equal(conv.denyContinue(), CONVERSATION_STATES.AWAITING_PROMPT);
  assert.ok(conv.getFollowUpContext().includes('First, map creates a new array.'));
  assert.ok(conv.getFollowUpContext().includes('The actual output is the array 2, 4.'));

  conv.startFollowUp('does it mutate the original array?');
  const afterSecond = conv.completeFollowUp('No, map returns a brand new array and leaves the original untouched.');
  assert.equal(afterSecond, CONVERSATION_STATES.ASK_CONTINUE);

  // User clicks Proceed -> gets exact remaining unplayed sentences [1, 2]
  const resumeData = conv.proceedMainSession();
  assert.equal(conv.state, CONVERSATION_STATES.MAIN_TEACHING);
  assert.equal(resumeData.resumeFromIndex, 1);
  assert.deepEqual(resumeData.remainingSentences, [
    'Each number n is multiplied by two.',
    'So the result becomes two and four.',
  ]);
});

test('DocyConversationState completeFollowUp returns IDLE when no main session exists', () => {
  const conv = new DocyConversationState();
  conv.startFollowUp('what is a closure?');
  assert.equal(conv.completeFollowUp('A closure captures outer lexical variables.'), CONVERSATION_STATES.IDLE);
});

test('looksLikePromptOrInstruction accepts instructions and questions while filtering fillers', () => {
  assert.equal(looksLikePromptOrInstruction('tell me the actual output'), true);
  assert.equal(looksLikePromptOrInstruction('give an example with integers'), true);
  assert.equal(looksLikePromptOrInstruction('Why does await pause here?'), true);
  assert.equal(looksLikePromptOrInstruction('output'), true);
  assert.equal(looksLikePromptOrInstruction('uh'), false);
  assert.equal(looksLikePromptOrInstruction('hmm'), false);
  assert.equal(looksLikePromptOrInstruction(''), false);
});

test('isProceedCommand and isDenyCommand classify Proceed vs Deny accurately', () => {
  assert.equal(isProceedCommand('proceed'), true);
  assert.equal(isProceedCommand('Yes, continue please'), true);
  assert.equal(isDenyCommand('deny'), true);
  assert.equal(isDenyCommand('No, new prompt'), true);
  assert.equal(isProceedCommand('deny'), false);
  assert.equal(isDenyCommand('proceed'), false);
});

test('buildFollowUpPrompt includes highlighted selectedText and previousContext', () => {
  const prompt = buildFollowUpPrompt({
    followUpQuestion: 'tell me the actual output',
    previousContext: 'We were tracing reduce on [1, 2, 3].',
    selectedText: '[1, 2, 3].reduce((a, b) => a + b, 10)',
  });
  assert.match(prompt, /Highlighted context/);
  assert.match(prompt, /reduce\(\(a, b\)/);
  assert.match(prompt, /Previous explanation context/);
  assert.match(prompt, /tell me the actual output/);
  assert.match(DOCY_FOLLOWUP_SYSTEM_PROMPT, /actual output/i);
});

test('transcribeAudioWithGroq posts multipart audio and parses transcript cleanly', async () => {
  let capturedUrl = '';
  let capturedHeaders = null;
  let capturedBody = null;

  const res = await transcribeAudioWithGroq({
    audioBuffer: Buffer.from([1, 2, 3, 4]),
    mimeType: 'audio/webm;codecs=opus',
    apiKey: 'test-groq-key',
    fetchFn: async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      capturedBody = init.body;
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: ' Tell me the actual output of this loop. ' }),
      };
    },
  });

  assert.equal(capturedUrl, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(capturedHeaders.Authorization, 'Bearer test-groq-key');
  assert.ok(capturedBody instanceof FormData);
  assert.equal(res.text, 'Tell me the actual output of this loop.');
  assert.equal(res.provider, 'groq-whisper');
});

test('validateTeachInput supports continueSentences and follow-up context fields', () => {
  const continueCheck = validateTeachInput({
    continueSentences: ['First remaining sentence.', 'Second remaining sentence.'],
    provider: 'hybrid',
  });
  assert.equal(continueCheck.valid, true);
  assert.deepEqual(continueCheck.data.continueSentences, [
    'First remaining sentence.',
    'Second remaining sentence.',
  ]);

  const followUpCheck = validateTeachInput({
    text: 'give me the output',
    isFollowUp: true,
    followUpContext: 'Previous explanation',
    followUpSelectedText: 'console.log(2 + 2)',
  });
  assert.equal(followUpCheck.valid, true);
  assert.equal(followUpCheck.data.isFollowUp, true);
  assert.equal(followUpCheck.data.followUpSelectedText, 'console.log(2 + 2)');
});

test('POST /transcribe endpoint decodes audioBase64 and returns transcript', async () => {
  const server = createServer({
    GROQ_API_KEY: 'test-key',
    transcribeHandler: async ({ audioBuffer, mimeType }) => ({
      text: `transcribed ${audioBuffer.length} bytes (${mimeType})`,
      provider: 'groq-whisper',
      model: 'whisper-large-v3-turbo',
    }),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const response = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        audioBase64: `data:audio/webm;base64,${Buffer.from('hello-audio').toString('base64')}`,
        mimeType: 'audio/webm',
      });
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/transcribe',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        }
      );
      req.on('error', reject);
      req.end(payload);
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.text, 'transcribed 11 bytes (audio/webm)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('streamTeachPipeline streams saved continueSentences directly with Chatterbox synthesis', async () => {
  const tokens = [];
  const synthesized = [];
  let donePayload = null;

  await streamTeachPipeline(
    {
      text: 'Continue previous explanation.',
      continueSentences: ['Second sentence.', 'Third sentence.'],
      requestId: 'req-continue-1',
      provider: 'hybrid',
    },
    {
      onToken: (t) => tokens.push(t),
      onAudioReady: (audio) => synthesized.push(audio),
      onDone: (d) => { donePayload = d; },
      options: {
        CHATTERBOX_ENABLED: true,
        CHATTERBOX_MODEL: 'turbo',
        chatterboxProvider: {
          start: async () => {},
          synthesize: async (sentence) => ({
            fileName: `${sentence.length}.wav`,
            sampleRate: 24000,
            durationSeconds: 1.0,
            generatedAudioAvailableSeconds: 1.0,
            model: 'turbo',
          }),
        },
      },
    }
  );

  assert.equal(tokens.join(''), 'Second sentence. Third sentence.');
  assert.equal(synthesized.length, 2);
  assert.equal(synthesized[0].sentenceIndex, 0);
  assert.equal(synthesized[1].sentenceIndex, 1);
  assert.equal(donePayload.explanation, 'Second sentence. Third sentence.');
  assert.equal(donePayload.groundingStatus, 'resumed');
});

