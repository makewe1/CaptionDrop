import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Chrome 156+ disables a reloaded unpacked extension, including after an
// Incognito-access change, unless the profile is in developer mode.
export async function prepareProfile(profile) {
  const preferences = path.join(profile, 'Default', 'Preferences');
  try { await access(preferences); return; } catch {}
  await mkdir(path.dirname(preferences), { recursive: true });
  await writeFile(preferences, JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
}

// Chrome can replace an extension service worker while Playwright still lists
// the stopped instance. Prefer the cached worker, then any listed instance
// that can still run extension APIs.
export async function liveWorker(context, extensionId, cached) {
  const candidates = [cached, ...context.serviceWorkers().filter(item => item !== cached
    && item.url().startsWith(`chrome-extension://${extensionId}/`)).reverse()].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await Promise.race([candidate.evaluate(() => chrome.tabs.query({ active: true })),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('Worker did not answer')), 3000))]);
      return candidate;
    } catch {}
  }
  throw new Error('The CaptionDrop service worker is not running.');
}
