import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Browser focus is not a stable tab identifier across extension picker windows.
export async function fixtureTabId(worker, page) {
  await page.bringToFront();
  const marker = randomUUID();
  await page.evaluate(value => document.documentElement.setAttribute('data-captiondrop-test-tab', value), marker);
  try {
    const id = await worker.evaluate(async value => {
      const tabs = await chrome.tabs.query({});
      const matches = await Promise.all(tabs.map(async tab => {
        try {
          const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id },
            func: () => document.documentElement?.getAttribute('data-captiondrop-test-tab') });
          return result.result === value ? tab.id : undefined;
        } catch { return undefined; }
      }));
      return matches.find(Number.isInteger);
    }, marker);
    assert.ok(Number.isInteger(id), 'The fixture document must have a Chrome tab ID');
    return id;
  } finally {
    await page.evaluate(() => document.documentElement.removeAttribute('data-captiondrop-test-tab'));
  }
}
