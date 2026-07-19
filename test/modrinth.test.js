const test = require('node:test');
const assert = require('node:assert/strict');
const { safeArchivePath, isAllowedDownload } = require('../src/modrinth');

test('accepts only confined archive paths and official Modrinth CDN downloads', () => {
  assert.equal(safeArchivePath('mods/example.jar'), true);
  assert.equal(safeArchivePath('../outside.jar'), false);
  assert.equal(safeArchivePath('/absolute/path'), false);
  assert.equal(safeArchivePath('mods\\windows-path.jar'), false);
  assert.equal(isAllowedDownload('https://cdn.modrinth.com/data/project/versions/version/example.jar'), true);
  assert.equal(isAllowedDownload('https://cdn.modrinth.com.evil.example/example.jar'), false);
  assert.equal(isAllowedDownload('https://user@cdn.modrinth.com/example.jar'), false);
  assert.equal(isAllowedDownload('http://cdn.modrinth.com/example.jar'), false);
});
