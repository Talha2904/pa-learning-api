import { describe, expect, it } from 'vitest';
import { isHomePageLink } from '../../src/application/services/import-parsing.js';

describe('isHomePageLink', () => {
  it.each([
    'https://www.icaew.com',
    'https://alison.com/',
    'https://www.accaglobal.com/gb/en.html',
    'https://example.com/en-gb/',
    'https://example.com/index.php',
  ])('flags the front page %s', (link) => {
    expect(isHomePageLink(link)).toBe(true);
  });

  it.each([
    'https://alison.com/course/excel-for-beginners',
    'https://www.accaglobal.com/gb/en/cpd/aml-update.html',
    'https://example.com/?course=42',
    'https://example.com/#module-3',
    '',
    null,
    'not a url',
  ])('accepts %s', (link) => {
    expect(isHomePageLink(link)).toBe(false);
  });
});
