import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Rasterize our original SVG geometry for Chrome's PNG-only extension icons.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(path.join(root, 'icons/icon.svg'), 'utf8');
const executablePath = process.env.CAPTIONDROP_BROWSER_PATH
  || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox']
});
try {
  const page = await browser.newPage();
  const rendered = await page.evaluate(async source => {
    const image = new Image();
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
    try {
      image.src = url;
      await image.decode();
      return [16, 32, 48, 128, 512].map(size => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, size, size);
        return { size, data: canvas.toDataURL('image/png').split(',')[1] };
      });
    } finally { URL.revokeObjectURL(url); }
  }, svg);
  for (const { size, data } of rendered) {
    const file = path.join(root, 'icons', `icon-${size}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`Rendered ${path.relative(root, file)}`);
  }
} finally { await browser.close(); }
