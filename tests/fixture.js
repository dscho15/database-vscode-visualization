const { execFileSync } = require('node:child_process');
const path = require('node:path');

function createFixture(database) {
  execFileSync('go', ['run', './tests/fixture', database], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'pipe',
  });
}

module.exports = { createFixture };
