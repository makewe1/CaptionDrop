# CaptionDrop

Local subtitles for online videos. A small Chrome extension with a quiet interface
and no account, backend, uploads, or runtime dependencies.

## Install in Chrome

No build or Node.js installation is required to use the extension.

1. Download and extract `dist/CaptionDrop-0.1.3.zip`, or use this project folder.
2. Open `chrome://extensions` in desktop Chrome (version 120 or newer).
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and choose the folder containing `manifest.json`.
5. Pin **CaptionDrop** from Chrome's Extensions menu.

When updating from an older build, reload existing video tabs once to retire
scripts injected by that build.

If Chrome runs on Windows and the project lives in WSL, extract the packaged ZIP
into a Windows folder and load that folder in Chrome.

## Use

1. Open a webpage with a video and click the CaptionDrop toolbar icon.
2. Select a detected video. The system file browser opens immediately.
3. Choose your `.srt` subtitle file.
4. Use the small **CaptionDrop** button near the video's controls to change text
   size, text color, background (Black or Transparent; Transparent by default),
   or caption visibility, or choose a new file. File selection from the player
   opens a CaptionDrop window; click the selected video there to choose its SRT.
5. Drag the caption block to move it. The position carries over to the next cue.
   Focused captions can also be moved with the arrow keys.

Timing follows the video's current playback time through play, pause, seeking,
and speed changes. Manual timing adjustment is intentionally excluded.

For a local example, run `python3 -m http.server 8000 --directory tests/fixtures`,
open `http://localhost:8000/index.html`, and load
[`tests/fixtures/demo.srt`](tests/fixtures/demo.srt).

Subtitle file selection takes place in CaptionDrop's own interface. Webpages
cannot access its file input. Caption text displayed within a webpage, including
native fullscreen subtitle cues, can be read by that webpage's scripts. See
[the privacy policy](PRIVACY.md) for storage and deletion details.

## Remember subtitles

CaptionDrop saves a local copy of the subtitle contents for each individual
video, together with its appearance, position, and visibility setting. YouTube
video IDs and Bilibili video/episode IDs and part numbers identify separate videos.
Other sites use their page URL, media source, and a stable player slot. Only a
hash of the video association is saved; readable page and media URLs are not
stored in subtitle records.

Click **Enable automatic loading** in the toolbar popup and allow access to the
current website. This lets Chrome run CaptionDrop there on return visits, so saved
captions load without selecting the file or clicking the extension again.
Without that permission, captions can still be loaded manually and remembered
captions can be restored when you open CaptionDrop.

- Embedded players on a different website may require additional site access.
  Choose the player’s origin under **Embedded site access**, then click
  **Allow selected site**. Each action requests access to that one origin; other
  inaccessible frames can belong to ads or unrelated services.
- **Forget saved subtitles** in the player settings removes that video's memory;
  its currently displayed captions remain available until you leave.
- Memory is bounded to 50 videos and approximately 8 MiB. The oldest saved entries
  are removed when more space is needed.
- Replacing or deleting the original subtitle file does not change the saved copy.
  Load its replacement in CaptionDrop to update the memory.
- To disable a site's automatic access, change its site access in Chrome's
  extension details. Removing the extension also removes its normal saved data.

## Fullscreen and Incognito

Player-container fullscreen keeps the draggable overlay and CaptionDrop settings.
When Chrome puts the `<video>` element itself into native fullscreen, CaptionDrop
uses a native subtitle track. Exit native fullscreen to drag captions or use the
CaptionDrop settings again. Other subtitle tracks are left under the player's
control.

For private windows, open CaptionDrop's **Details** at `chrome://extensions` and
enable **Allow in incognito**. Private captions and their settings stay only in
the current page’s memory. Reloading or closing that page discards them; they
are never added to local or session subtitle storage and cannot restore on a
later visit. Site permissions you grant remain controlled by Chrome.

## Compatibility and limits

- Standard HTML5 video, dynamically added videos, accessible frames, and open
  shadow-root players are supported. The popup offers a scan-again action.
- YouTube and Bilibili have dedicated video identity rules and control-bar
  placement adapters. Live-site compatibility must be verified against those
  services; their player internals can change independently of this extension.
- Closed shadow trees, Chrome's internal pages, the Chrome Web Store, inaccessible
  frames, picture-in-picture, and non-HTML5 players are outside this version's
  verified compatibility boundary.
- Files must be SRT, no larger than 2 MiB, with up to 20,000 non-empty cues.
  UTF-8 and BOM-marked UTF-16 are supported. Save legacy encodings as UTF-8 first.
- Overlapping cues display together. Embedded subtitle styling becomes plain
  text so your selected appearance is applied consistently.
- Generic players without a stable video URL can require selecting the subtitle
  file again after the site's player or source changes.

## Permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Access the current page after you open CaptionDrop. |
| `scripting` | Install the video detector and caption overlay into permitted frames. |
| `storage` | Keep subtitle memory and appearance settings locally. |
| `webNavigation` | Enumerate frames when scanning or coordinating an activated tab. |
| Optional website access | Enable automatic loading and access cross-origin embedded players only when allowed. |

Navigation checks run only in pages where CaptionDrop is active. The service
worker does not subscribe to browser-wide navigation events.

No scripts, fonts, subtitle contents, or analytics are fetched from a server.

## Development and verification

```sh
npm ci
npm test
npm run test:browser
npm run test:incognito
npm run package
```

The extension itself uses plain JavaScript, HTML, and CSS. Playwright is a
development dependency only. Browser tests use a temporary browser profile and
generated local video fixtures; they do not use your own Chrome profile.

If an installed Chrome build blocks unpacked extension automation, install the
test browser with `npx playwright install chromium`, or specify an extension-capable
Chrome/Chromium executable using `CAPTIONDROP_BROWSER_PATH`.

The release ZIP includes only extension runtime files and icons. Project scope
and implementation choices are recorded in [`REQUIREMENTS.md`](REQUIREMENTS.md).

## Verification results

Verified on Linux with Chrome 140:

- **64 unit/integration tests pass** for bounded SRT parsing, UTF-16 handling,
  cue lookup, stable provider identities, sender authorization, storage migration,
  atomic eviction, failed saves, concurrent player handoffs, iframe restoration,
  permissions, worker restarts, and private-storage exclusion.
- **29 real-browser checks pass**, including the extension-owned file picker,
  closed controls, rejection of forged webpage actions, position-only movement,
  caption timing, styling, dragging, both fullscreen modes, iframe replacement,
  stale picker targets, stable player selection, provider preview handling,
  restricted storage access, per-origin permission requests, extension reload,
  a full browser restart, and forgetting subtitles.
- **5 real split-Incognito checks pass**: page-only captions, no private subtitle
  text/filename/identity in extension storage, preservation across a normal
  window closing, deletion on private-page reload, and no restoration after
  closing and reopening the last private window.
- The headless test profile uses a disposable copy of the extension with access
  granted only to local fixture hosts, the routed YouTube fixture, and Bilibili
  for the optional live probe. This models already-granted site access; native permission prompts
  and clicking Chrome's real toolbar button were not automated. The distributed
  manifest retains optional site permissions.
- A prior live YouTube probe detected its video and attached local SRT captions after
  verifying the current control-bar layout. Streaming playback and long viewing
  sessions were not verified by that probe.
- Bilibili's live check reached its time limit, so live Bilibili compatibility is
  still unverified. Its identity rules and adapter are implemented.
- In one Chrome run, a 10,000-cue / 487,786-byte SRT parsed in **18.5 ms** and indexed
  in **1.7 ms**; 1,000 cue lookups took **2.3 ms**. These are observations on this
  machine, not guarantees for other devices.
- The runtime contains **11 files / 105,578 bytes**, packaged as a **35,654-byte ZIP**.

For bounded live provider probes in addition to the local tests, run
`CAPTIONDROP_LIVE=1 npm run test:browser`.
