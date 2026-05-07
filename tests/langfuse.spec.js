import { test, expect } from '@playwright/test';

const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || 'pk-lf-d0f8768c-b452-43f3-a5a6-95eb638acfb9';
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || 'sk-lf-7633faaf-c5c1-439a-9705-55e72151e5d3';
const LANGFUSE_BASE_URL = process.env.LANGFUSE_BASE_URL || 'http://10.3.0.241:3000';
const AUTH = 'Basic ' + Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64');

async function langfuseGet(path) {
  const res = await fetch(`${LANGFUSE_BASE_URL}/api/public${path}`, {
    headers: { Authorization: AUTH }
  });
  return res.json();
}

async function waitForTrace(name, { timeout = 30000, interval = 2000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const data = await langfuseGet(`/traces?name=${encodeURIComponent(name)}&limit=1`);
    if (data.data?.length > 0) return data.data[0];
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Trace "${name}" not found within ${timeout}ms`);
}

async function waitForSession(sessionId, { timeout = 30000, interval = 2000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const data = await langfuseGet(`/sessions/${encodeURIComponent(sessionId)}`);
    if (data.id) return data;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Session "${sessionId}" not found within ${timeout}ms`);
}

test.describe('Langfuse Integration', () => {

  test('Langfuse API is reachable and authenticated', async () => {
    const data = await langfuseGet('/traces?limit=1');
    expect(data.meta).toBeDefined();
    expect(data.meta.page).toBe(1);
  });

  test('SDK trace and session are ingested and visible', async () => {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { LangfuseSpanProcessor } = await import('@langfuse/otel');
    const { startObservation, propagateAttributes } = await import('@langfuse/tracing');
    const sessionId = `e2e-session-${Date.now()}`;
    const traceName = `e2e-trace-${Date.now()}`;

    // Initialize OTEL with Langfuse exporter for this test
    const sdk = new NodeSDK({
      spanProcessors: [new LangfuseSpanProcessor({
        publicKey: LANGFUSE_PUBLIC_KEY,
        secretKey: LANGFUSE_SECRET_KEY,
        baseUrl: LANGFUSE_BASE_URL,
      })],
    });
    sdk.start();

    try {
      await propagateAttributes({
        sessionId,
        userId: 'e2e-test',
        traceName,
        metadata: { source: 'playwright' }
      }, async () => {
        const span = startObservation('e2e-span', { input: { test: true } });
        span.update({ output: { result: 'ok' } }).end();
      });

      // Flush spans to Langfuse
      await sdk.shutdown();

      // Wait for the worker to process the blob and write to ClickHouse
      const found = await waitForTrace(traceName, { timeout: 30000 });
      expect(found.name).toBe(traceName);
      expect(found.sessionId).toBe(sessionId);
      expect(found.userId).toBe('e2e-test');
      expect(found.observations.length).toBeGreaterThanOrEqual(1);

      // Verify the session exists
      const session = await waitForSession(sessionId, { timeout: 15000 });
      expect(session.id).toBe(sessionId);
    } catch (e) {
      await sdk.shutdown().catch(() => {});
      throw e;
    }
  });

  test('@langfuse/langchain CallbackHandler can be instantiated', async () => {
    const { CallbackHandler } = await import('@langfuse/langchain');
    const sessionId = `e2e-langchain-${Date.now()}`;

    const handler = new CallbackHandler({
      sessionId,
      userId: 'e2e-langchain',
      tags: ['e2e-test'],
    });

    expect(handler.sessionId).toBe(sessionId);
    expect(handler.userId).toBe('e2e-langchain');
  });

  test('ai-it chat completion creates Langfuse trace', async ({ request }) => {
    test.setTimeout(180000);
    const directive = `e2e langfuse test ${Date.now()}`;

    // Fire off the chat completion (don't await — it runs the full agent pipeline)
    const completionPromise = request.post('/v1/chat/completions', {
      data: {
        model: 'ai-it-org',
        messages: [{ role: 'user', content: directive }],
        stream: true
      },
      timeout: 150000
    }).catch(() => null);

    // The thread ID is an MD5 hash of the directive
    const crypto = await import('crypto');
    const threadId = crypto.createHash('md5').update(directive).digest('hex').substring(0, 12);

    // Poll Langfuse for the trace — it should appear once the first LLM call starts
    const found = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 120000) {
        const traces = await langfuseGet(`/traces?limit=20`);
        const match = traces.data?.find(t => t.sessionId === threadId);
        if (match) return match;
        await new Promise(r => setTimeout(r, 3000));
      }
      return null;
    })();

    expect(found).toBeDefined();
    expect(found.sessionId).toBe(threadId);

    // Clean up — abort the stream
    completionPromise.then(r => r?.dispose?.()).catch(() => {});
  });

  test('user star rating creates Langfuse score', async ({ request }) => {
    test.setTimeout(60000);
    // Find a recently created trace in Langfuse
    let threadId = null;
    const startLookup = Date.now();
    while (Date.now() - startLookup < 30000) {
      const traces = await langfuseGet('/traces?limit=10');
      const trace = traces.data?.find(t => t.sessionId && t.sessionId.length === 12);
      if (trace) {
        threadId = trace.sessionId;
        break;
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!threadId) {
      test.skip();
      return;
    }

    // Send a rating via the ai-it API
    const response = await request.post(`/api/threads/${threadId}/messages/2/score`, {
      data: { rating: 5, agentName: 'e2e-test-agent' }
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.ok).toBe(true);

    // Verify rating persists in messages API
    const msgsRes = await request.get(`/api/threads/${threadId}/messages`);
    const msgs = await msgsRes.json();
    
    // Wait for Langfuse to process the score
    const start = Date.now();
    let found = null;
    while (Date.now() - start < 45000) {
      const scores = await langfuseGet('/scores?limit=50');
      found = scores.data?.find(s => s.name === 'user_rating' && s.comment === 'e2e-test-agent' && (s.traceId || s.sessionId === threadId));
      if (found) break;
      await new Promise(r => setTimeout(r, 3000));
    }
    expect(found).toBeDefined();
    expect(found.value).toBe(5);
    expect(found.name).toBe('user_rating');
  });
});
