"""Create a small unpacked-extension ZIP; no third-party Python packages needed."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'manifest.json').read_text())
files = ['manifest.json', 'background.js', 'core.js', 'content.js',
         'popup.html', 'popup.css', 'popup.js']
files += [f'icons/icon-{size}.png' for size in (16, 32, 48, 128)]
destination = root / 'dist' / f'CaptionDrop-{manifest["version"]}.zip'
destination.parent.mkdir(exist_ok=True)
for name in files:
    if not (root / name).is_file():
        raise SystemExit(f'Missing extension asset: {name}')
with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, name)
total = sum((root / name).stat().st_size for name in files)
print(f'{destination}\n{len(files)} files; {total:,} bytes unpacked; '
      f'{destination.stat().st_size:,} bytes zipped')
