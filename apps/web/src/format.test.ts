import { describe, expect, it } from 'vitest';
import { duration } from './format';

describe('duration labels', () => {
  it.each([
    [0, '0m 0s'],
    [0.4, '0m 0s'],
    [0.5, '0m 1s'],
    [1, '0m 1s'],
    [59.4, '0m 59s'],
    [59.5, '1m 0s'],
    [59.6, '1m 0s'],
    [60, '1m 0s'],
    [60.4, '1m 0s'],
    [60.5, '1m 1s'],
    [119.4, '1m 59s'],
    [119.5, '2m 0s'],
    [119.6, '2m 0s'],
    [120, '2m 0s'],
    [3599.6, '60m 0s'],
  ])('rounds %s seconds before splitting minutes and seconds', (seconds, label) => {
    expect(duration(seconds)).toBe(label);
  });

  it.each([-0.5, -1, -60, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'displays a nonnegative finite label for %s seconds',
    (seconds) => {
      expect(duration(seconds)).toBe('0m 0s');
    },
  );
});
