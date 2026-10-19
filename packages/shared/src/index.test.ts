import { describe, expect, it } from 'vitest';
import { repoNameSchema, settingsSchema, defaultSettings } from './index';
describe('shared input boundaries', () => {
  it('rejects path traversal, URLs and extra segments while accepting GitHub dot names', () => {
    for (const value of [
      'owner/..',
      'owner/.',
      '../repo',
      './repo',
      'a/b/c',
      'https://github.com/a/b',
      'a/b%2f..',
      'a/',
    ])
      expect(repoNameSchema.safeParse(value).success).toBe(false);
    for (const value of ['octokit/auth-app.js', 'org/.github', 'valid-owner/repo_name'])
      expect(repoNameSchema.safeParse(value).success).toBe(true);
  });
  it('keeps background sync off by default and bounds opt-in intervals', () => {
    expect(defaultSettings.syncIntervalMinutes).toBe(0);
    expect(settingsSchema.safeParse({ ...defaultSettings, syncIntervalMinutes: 1 }).success).toBe(
      false,
    );
    expect(settingsSchema.safeParse({ ...defaultSettings, syncIntervalMinutes: 5 }).success).toBe(
      true,
    );
  });
});
