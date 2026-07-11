import { describe, expect, it } from 'vitest';
import { parseListInput, slugifyUnit } from './property-inventory.service.js';

describe('property inventory helpers', () => {
  it('builds stable SEO slugs from property and unit names', () => {
    expect(slugifyUnit('Harbour View Suites', 'Penthouse 4')).toBe('harbour-view-suites-penthouse-4');
    expect(slugifyUnit('Cedar Court Apartments', 'Apt #102')).toBe('cedar-court-apartments-apt-102');
  });

  it('parses comma-separated and array list inputs', () => {
    expect(parseListInput('parking, balcony, in-suite laundry')).toEqual([
      'parking',
      'balcony',
      'in-suite laundry',
    ]);
    expect(parseListInput(['pet friendly', '  storage  ', ''])).toEqual(['pet friendly', 'storage']);
  });
});
