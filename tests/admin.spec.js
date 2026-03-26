import { test, expect } from '@playwright/test';

const USE_MOCK_DATA = process.env.USE_MOCK_DATA !== 'false';

test.describe('Admin Portal Page Buttons', () => {
  const MOCK_THREAD_ID_1 = 'thread-111';
  const MOCK_THREAD_ID_2 = 'thread-222';
  
  test.beforeEach(async ({ page }) => {
    if (USE_MOCK_DATA) {
      await page.route('**/api/threads', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { thread_id: MOCK_THREAD_ID_1, title: 'First Thread', directive: 'test 1', msgCount: 2, agents: ['business_analyst'] },
            { thread_id: MOCK_THREAD_ID_2, title: 'Second Thread', directive: 'test 2', msgCount: 4, agents: ['business_analyst', 'software_architect'] }
          ])
        });
      });
      await page.route('**/api/active', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      });
    }

    // Auto-accept confirmation dialogs for delete actions
    page.on('dialog', dialog => dialog.accept());
    
    // Intercept navigation
    await page.goto(`/#/admin`);
    // Wait for the threads to load
    await expect(page.locator('.v-card').first()).toBeVisible();
  });

  test('Delete All button works', async ({ page }) => {
    let deleteCalled = false;
    if (USE_MOCK_DATA) {
      await page.route('**/api/threads', async (route, request) => {
        if (request.method() === 'DELETE') {
          deleteCalled = true;
          await route.fulfill({ status: 200, body: JSON.stringify({ message: 'Deleted' }) });
        } else {
          // Re-mock GET after deletion to return empty list
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
        }
      });
    }

    const deleteAllBtn = page.getByRole('button', { name: /Delete All/i });
    await expect(deleteAllBtn).toBeEnabled();
    await deleteAllBtn.click();

    if (USE_MOCK_DATA) {
      expect(deleteCalled).toBeTruthy();
      await expect(page.getByText('No conversations yet.')).toBeVisible();
    }
  });

  test('Individual Delete button works', async ({ page }) => {
    let deleteCalled = false;
    if (USE_MOCK_DATA) {
      await page.route(`**/api/threads/${MOCK_THREAD_ID_1}`, async (route, request) => {
        if (request.method() === 'DELETE') {
          deleteCalled = true;
          await route.fulfill({ status: 200, body: JSON.stringify({ message: 'Deleted' }) });
        }
      });
      // Need to intercept the subsequent GET to reflect deletion
      let reqCount = 0;
      await page.route('**/api/threads', async (route, request) => {
        if (request.method() === 'GET') {
          reqCount++;
          if (reqCount > 1) {
            // After delete, return only one thread
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify([{ thread_id: MOCK_THREAD_ID_2, title: 'Second Thread', directive: 'test 2', msgCount: 4, agents: [] }])
            });
          } else {
            route.continue(); // Fall back to beforeEach mock for initial load
          }
        } else {
            route.continue();
        }
      });
    }

    // Find the first delete button on a thread row
    const deleteBtns = page.locator('button[title="Delete"]');
    await expect(deleteBtns).toHaveCount(2);
    await deleteBtns.first().click();

    if (USE_MOCK_DATA) {
      expect(deleteCalled).toBeTruthy();
      // Should now only be 1 thread visible
      await expect(page.locator('button[title="Delete"]')).toHaveCount(1);
    }
  });

  test('Export thread button works', async ({ page }) => {
    if (USE_MOCK_DATA) {
      await page.route(`**/api/threads/${MOCK_THREAD_ID_1}/messages`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ role: 'user', content: 'test', timestamp: Date.now() }])
        });
      });
    }
    
    // Playwright handles downloads
    const downloadPromise = page.waitForEvent('download');
    
    const exportBtn = page.locator('button[title="Export"]').first();
    await exportBtn.click();
    
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('chat_first_thread.html');
  });

  test('Clicking thread card navigates to thread details', async ({ page }) => {
    const threadCard = page.locator('.v-card').first();
    await threadCard.click();
    
    await expect(page).toHaveURL(/#\/admin\/thread\/thread-111/);
  });

  test('Home brain icon navigates to chat', async ({ page }) => {
    const homeIcon = page.locator('.mdi-brain').first();
    await homeIcon.click();
    
    await expect(page).toHaveURL(/#\/$/);
  });
});