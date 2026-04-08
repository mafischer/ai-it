import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => { page.on("console", msg => console.log("PAGE LOG:", msg.text())); page.on("pageerror", error => console.log("PAGE ERROR:", error.message)); });

test.describe('Rewind Functionality', () => {
  test('should trigger rewind API when rewind button is clicked and reload messages', async ({ page }) => {
    // 1. Mock the API endpoints required to render the thread
    const MOCK_THREAD_ID = 'test-thread-123';
    
    // Mock the thread list for the title
    await page.route('**/api/threads', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ thread_id: MOCK_THREAD_ID, title: 'Test Thread', directive: 'test', msgCount: 3, agents: ['business_analyst'] }])
      });
    });

    // Mock the workflow endpoint (needed for milestone labels)
    await page.route('**/api/workflow', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ pipeline: { entry: 'business_analyst', milestones: [] }, agents: {}, routing: {} })
      });
    });

    // Mock the thread messages
    const mockMessages = [
      { role: 'user', content: 'Create a test feature', timestamp: Date.now() },
      { role: 'assistant', name: 'business_analyst', content: 'STATUS: DIRECTIVE_AMBIGUOUS', timestamp: Date.now() + 1000 },
      { role: 'user', content: 'Here is the clarification', timestamp: Date.now() + 2000 }
    ];

    await page.route(`**/api/threads/${MOCK_THREAD_ID}/messages**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMessages)
      });
    });

    // Mock the active status initially empty
    await page.route('**/api/active', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([])
      });
    });

    // Mock the SSE stream endpoint
    await page.route(`**/api/threads/${MOCK_THREAD_ID}/stream`, async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: 'data: [DONE]\n\n'
      });
    });

    // 2. Mock the rewind API endpoint to intercept the rewind request
    let rewindCalled = false;
    let rewindPayload = null;
    
    await page.route(`**/api/threads/${MOCK_THREAD_ID}/rewind`, async (route) => {
      rewindCalled = true;
      rewindPayload = route.request().postDataJSON();
      
      // Update the mock messages to simulate a state truncation after rewind
      mockMessages.splice(2); // Remove the last message (index 2)
      
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ message: "Rewound to message 1 and re-invoked" })
      });
    });

    // Handle confirm dialogs automatically by accepting them
    page.on('dialog', dialog => dialog.accept());

    // 3. Navigate to the thread
    await page.goto(`http://localhost:3000/#/admin/thread/${MOCK_THREAD_ID}`);

    // Wait for message cards to render (each message is a v-card)
    await expect(page.locator('button[title="Rewind to this point"]')).toHaveCount(3, { timeout: 10000 });

    // Expand messages to see content
    await page.getByText('Expand All').click();
    await expect(page.getByText('Here is the clarification')).toBeVisible({ timeout: 5000 });

    // 4. Click the "Rewind" button on the assistant message (second rewind button)
    const rewindButton = page.locator('button[title="Rewind to this point"]').nth(1);
    await rewindButton.click();

    // Wait for the fetch cycle to complete
    await page.waitForTimeout(500);

    // 5. Assert the rewind API was called correctly
    expect(rewindCalled).toBeTruthy();
    expect(rewindPayload).toEqual({ messageIndex: 1 });

    // 6. Assert that the UI refreshed the messages list (removing the last one)
    await expect(page.locator('button[title="Rewind to this point"]')).toHaveCount(2, { timeout: 5000 });
    await expect(page.getByText('Here is the clarification')).toBeHidden();
  });
});
