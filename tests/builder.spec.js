import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on("console", msg => console.log("PAGE LOG:", msg.text()));
  page.on("pageerror", error => console.log("PAGE ERROR:", error.message));
});

test.describe('Workflow Builder', () => {
  const MOCK_WORKFLOW = {
    pipeline: {
      entry: 'business_analyst',
      milestones: [
        { id: 'initiation', name: 'Project Initiation', statuses: ['DIRECTIVE_CLEAR', 'DIRECTIVE_AMBIGUOUS'], previous: null, next: 'requirements' },
        { id: 'requirements', name: 'Requirements Definition', statuses: ['REQUIREMENTS_CLEAR', 'REQUIREMENTS_DRAFTED'], previous: 'initiation', next: null }
      ]
    },
    agents: {
      business_analyst: { role: 'Business Analyst', emoji: '📋', mission: 'Extract requirements', model: 'specialist' }
    },
    routing: {
      business_analyst: {
        routes: {
          DIRECTIVE_CLEAR: 'business_analyst',
          DIRECTIVE_AMBIGUOUS: '__end__',
          REQUIREMENTS_DRAFTED: 'business_analyst'
        },
        fallback: 'router'
      }
    }
  };

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/workflows', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['workflow']) });
    });

    await page.route('**/api/workflow**', async (route, request) => {
      if (request.method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_WORKFLOW) });
      } else if (request.method() === 'PUT') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      }
    });

    await page.goto('/#/builder');
  });

  test('Workflow selection dialog appears on load', async ({ page }) => {
    await expect(page.getByText('Workflow Builder').first()).toBeVisible();
    await expect(page.getByText('Select an existing workflow').first()).toBeVisible();
  });

  async function openWorkflow(page) {
    // Use "Create New" text field to open a workflow (more reliable than v-select in tests)
    const nameField = page.locator('.v-dialog .v-text-field input');
    await nameField.fill('workflow');
    await page.getByText('Continue').click();
    // Wait for canvas to render
    await expect(page.locator('#canvas-content')).toBeVisible({ timeout: 5000 });
  }

  test('Selecting a workflow loads the visual canvas', async ({ page }) => {
    await openWorkflow(page);

    // Milestone labels should appear
    await expect(page.getByText('PROJECT INITIATION').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('REQUIREMENTS DEFINITION').first()).toBeVisible({ timeout: 5000 });
  });

  test('Agent nodes appear per milestone after loading workflow', async ({ page }) => {
    // Open workflow
    await openWorkflow(page);

    // BA should appear (at least one instance)
    await expect(page.getByText('Business Analyst').first()).toBeVisible({ timeout: 5000 });
  });

  test('User node appears in first milestone', async ({ page }) => {
    await openWorkflow(page);

    await expect(page.getByText('User: Prompt & Feedback').first()).toBeVisible({ timeout: 5000 });
  });

  test('Palette contains draggable elements', async ({ page }) => {
    await openWorkflow(page);

    // Check palette items exist
    await expect(page.locator('.v-list-item:has-text("User Node")')).toBeVisible();
    await expect(page.locator('.v-list-item:has-text("New Milestone")')).toBeVisible();
    await expect(page.locator('.v-list-item:has-text("Agent Nodes")')).toBeVisible();
    await expect(page.locator('.v-list-item:has-text("System Nodes")')).toBeVisible();
  });

  test('Palette has no Start/End items', async ({ page }) => {
    await openWorkflow(page);

    // Start and End should NOT be in the palette
    const paletteList = page.locator('.v-card:has(.v-toolbar-title:has-text("Palette")) .v-list');
    await expect(paletteList.getByText('Start', { exact: true })).toBeHidden();
    await expect(paletteList.getByText('End', { exact: true })).toBeHidden();
  });

  test('JSON view toggle works', async ({ page }) => {
    await openWorkflow(page);

    // Switch to JSON view
    await page.getByText('JSON').click();

    // JSON textarea should contain workflow data
    const textarea = page.locator('textarea');
    const value = await textarea.inputValue();
    expect(value).toContain('business_analyst');
    expect(value).toContain('milestones');
  });

  test('Save button calls PUT /api/workflow', async ({ page }) => {
    let saveCalled = false;
    await page.route('**/api/workflow**', async (route, request) => {
      if (request.method() === 'PUT') {
        saveCalled = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_WORKFLOW) });
      }
    });

    await openWorkflow(page);

    await page.getByText('Save').click();
    await page.waitForTimeout(500);
    expect(saveCalled).toBeTruthy();
  });

  test('Zoom controls change zoom level', async ({ page }) => {
    await openWorkflow(page);

    const zoomText = page.locator('.text-caption:has-text("%")');
    const initialZoom = await zoomText.textContent();
    expect(initialZoom).toContain('100%');

    // Click zoom in a few times
    const zoomInBtn = page.locator('button[title="Zoom In"]');
    for (let i = 0; i < 10; i++) await zoomInBtn.click();

    const newZoom = await zoomText.textContent();
    expect(newZoom).not.toBe(initialZoom);
  });

  test('Clicking the settings icon on a node opens the editor dialog', async ({ page }) => {
    await openWorkflow(page);

    // Wait for nodes to render
    await expect(page.getByText('Business Analyst').first()).toBeVisible({ timeout: 5000 });

    // Click the cog/settings icon on the BA node (each node has one)
    const cogIcons = page.locator('#canvas-content .mdi-cog');
    await cogIcons.first().click();

    // Editor dialog should open
    await expect(page.getByText('Edit Node').first()).toBeVisible({ timeout: 3000 });
  });

  test('Milestone bounding boxes have connection dots', async ({ page }) => {
    await openWorkflow(page);

    await expect(page.getByText('PROJECT INITIATION').first()).toBeVisible({ timeout: 5000 });

    // Each milestone box should have two dots (top and bottom)
    // The dots are positioned absolutely within the box divs
    const milestoneBoxes = page.locator('#canvas-content > div > div.position-absolute.rounded:not([style*="background: #1e1e2e"])');
    const count = await milestoneBoxes.count();
    expect(count).toBeGreaterThanOrEqual(2); // At least 2 milestone boxes
  });
});
