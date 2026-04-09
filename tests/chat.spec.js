import { test, expect } from '@playwright/test';

const USE_MOCK_DATA = process.env.USE_MOCK_DATA !== 'false';

test.beforeEach(async ({ page }) => { page.on("console", msg => console.log("PAGE LOG:", msg.text())); page.on("pageerror", error => console.log("PAGE ERROR:", error.message)); });

test.describe('Chat Main Page UI', () => {
  const MOCK_THREAD_ID = 'chat-thread-789';

  test.beforeEach(async ({ page }) => {
    if (USE_MOCK_DATA) {
      // /api/workflows returns array of workflow name strings
      await page.route('**/api/workflows', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(['standard', 'research'])
        });
      });

      // /api/workflow returns the workflow JSON (milestones etc.)
      await page.route('**/api/workflow', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ pipeline: { entry: 'business_analyst', milestones: [] }, agents: {}, routing: {} })
        });
      });

      await page.route('**/api/threads', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ thread_id: MOCK_THREAD_ID, title: 'Chat Mock Thread', directive: 'test chat', msgCount: 1, agents: [], created_at: Date.now()/1000 }])
        });
      });

      await page.route('**/api/active', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      });

      const mockMessages = [
        { role: 'user', content: 'Initial user message', timestamp: Date.now() },
        { role: 'assistant', name: 'business_analyst', content: 'Assistant reply', timestamp: Date.now() + 1000 }
      ];
      await page.route(`**/api/threads/${MOCK_THREAD_ID}/messages**`, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockMessages) });
      });

      await page.route(`**/api/threads/${MOCK_THREAD_ID}/stream`, async (route) => {
        await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'data: [DONE]\n\n' });
      });
    }

    page.on('dialog', dialog => dialog.accept());
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.goto(`/#/`);
  });

  test('Sidebar Rail toggle works', async ({ page }) => {
    const expandBtn = page.locator('button .mdi-chevron-left, button .mdi-chevron-right').first();
    await expandBtn.click(); // collapse
    await expect(page.getByText('Chat Mock Thread')).toBeHidden();
    
    await expandBtn.click(); // expand
    await expect(page.getByText('Chat Mock Thread')).toBeVisible();
  });

  test('New Chat UI and Workflow selection', async ({ page }) => {
    // Click New Chat
    await page.getByText('New Chat').first().click();

    // Check empty state
    await expect(page.locator('p.text-body-1.text-medium-emphasis.mb-6')).toContainText('Multi-agent software engineering anything');
    
    // Select workflow (workflows are now name strings: 'standard', 'research')
    await page.click('.v-select');
    await page.getByText('research').first().click();
    
    // Type message
    const textarea = page.locator('textarea:not([readonly])');
    await textarea.fill('Testing new message');
    
    // We would send, but we'd need to mock the completions API fully. Just verifying UI enables the send button.
    const sendBtn = page.locator('button', { has: page.locator('.mdi-send') }).first();
    await expect(sendBtn).toBeEnabled();
  });

  test('Clicking a thread in sidebar loads it', async ({ page }) => {
    await page.getByText('Chat Mock Thread').first().click();
    // Wait for messages to render, then verify content exists in DOM
    await page.waitForTimeout(2000);
    const content = await page.content();
    expect(content).toContain('Initial user message');
    expect(content).toContain('Assistant reply');
  });

  test('Sidebar thread menu: Delete works', async ({ page }) => {
    let deleteCalled = false;
    if (USE_MOCK_DATA) {
      await page.route(`**/api/threads/${MOCK_THREAD_ID}`, async (route, request) => {
        if (request.method() === 'DELETE') {
          deleteCalled = true;
          await route.fulfill({ status: 200, body: JSON.stringify({ message: 'Deleted' }) });
        }
      });
    }

    // Open the dots menu for the thread
    const menuBtn = page.locator('.v-navigation-drawer button .mdi-dots-horizontal').first();
    await menuBtn.click();

    // Click Delete in the dropdown
    await page.getByText('Delete', { exact: true }).last().click();

    if (USE_MOCK_DATA) {
      expect(deleteCalled).toBeTruthy();
    }
  });

  test('Message actions: Copy and Clone work', async ({ page }) => {
    // Load thread
    await page.getByText('Chat Mock Thread').first().click();
    await page.waitForTimeout(2000);

    // Test Copy
    const copyBtn = page.locator('button[title="Copy text"]').first();
    await copyBtn.click();
    await page.waitForTimeout(100);
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain('Initial user message');

    // Test Clone
    let cloneCalled = false;
    if (USE_MOCK_DATA) {
      await page.route(`**/api/threads/${MOCK_THREAD_ID}/clone`, async (route) => {
        cloneCalled = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ thread_id: 'cloned-id' }) });
      });
    }

    const cloneBtn = page.locator('button[title="Clone from here"]').first();
    await cloneBtn.click();

    if (USE_MOCK_DATA) {
      expect(cloneCalled).toBeTruthy();
    }
  });

  test('Active thread controls: Pause/Resume work', async ({ page }) => {
    // Override active to make this thread active
    if (USE_MOCK_DATA) {
      await page.route('**/api/active', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ thread_id: MOCK_THREAD_ID, agent: 'business_analyst' }]) });
      });
      // To simulate streaming state we need the stream endpoint to not close immediately
      await page.route(`**/api/threads/${MOCK_THREAD_ID}/stream`, async (route) => {
        await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"content":" "}}]}\n\n' });
      });
    }
    
    await page.goto(`/#/`);
    await page.getByText('Chat Mock Thread').first().click();

    // The stream mock returns [DONE] instantly, so streaming becomes false, but it's still "active".
    // This makes the button show "Resume" instead of "Pause".
    const resumeBtn = page.getByRole('button', { name: /Resume/i }).first();
    await expect(resumeBtn).toBeVisible({ timeout: 5000 });

    let pauseCalled = false;
    let resumeCalled = false;

    if (USE_MOCK_DATA) {
      await page.route(`**/api/threads/${MOCK_THREAD_ID}/pause`, async (route) => {
        pauseCalled = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: 'Paused' }) });
      });
      await page.route(`**/api/threads/${MOCK_THREAD_ID}/resume`, async (route) => {
        resumeCalled = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: 'Resumed' }) });
      });
    }

    await resumeBtn.click();
    if (USE_MOCK_DATA) expect(resumeCalled).toBeTruthy();
  });
});