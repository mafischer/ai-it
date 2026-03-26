const { defineConfig, devices } = require('@playwright/test');
module.exports = defineConfig({
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on',
    screenshot: 'on',
    video: 'on'
  },
  reporter: [['html', { open: 'never' }]],
});
