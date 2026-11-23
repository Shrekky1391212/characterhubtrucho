import test from 'node:test';
import assert from 'node:assert/strict';
import { characterTagsToApi, characterTagsToForm } from '../src/character-payload.js';

test('character tags submit as comma-separated text, including when empty', () => {
  assert.equal(characterTagsToApi('mage, royal guard'), 'mage, royal guard');
  assert.equal(characterTagsToApi(''), '');
});

test('character tags from existing records display as comma-separated text', () => {
  assert.equal(characterTagsToForm('mage, royal guard'), 'mage, royal guard');
  assert.equal(characterTagsToForm(['mage', 'royal guard']), 'mage, royal guard');
  assert.equal(characterTagsToForm(null), '');
});