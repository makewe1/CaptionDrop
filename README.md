# CaptionDrop

Local subtitles for online videos. A small Chrome extension with a quiet interface
and no account, backend, uploads, or runtime dependencies.

## Install in Chrome

No build or Node.js installation is required to use the extension.

1. Download and extract `dist/CaptionDrop-0.1.4.zip`, or use this project folder.
2. Open `chrome://extensions` in desktop Chrome (version 140 or newer).
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
   Choosing a file again reuses that window.
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
Other sites use their page URL, media source, and a stable player slot. The `t`,
`time`, `start`, and `end` parameters are ignored only when they hold a playback
position, and episode fragments such as `#ep2` keep episodes separate. Video
associations and site ownership are saved as hashes; readable page and media
URLs are not stored in subtitle records.

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
- Memory is bounded to 50 videos and approximately 8 MiB. When space is needed,
  only the oldest entries from the same website and player-frame origin can be
  removed. Other sites' captions and older records without site ownership stay
  protected. If space cannot be freed, captions stay loaded for the current visit
  and a memory warning appears; forget a saved subtitle to make room.
- Replacing or deleting the original subtitle file does not change the saved copy.
  Load its replacement in CaptionDrop to update the memory.
- If the saved index is damaged, CaptionDrop rebuilds it from the saved subtitles
  instead of discarding them. Memory written by a newer CaptionDrop version is left
  untouched until CaptionDrop is updated; captions can still be loaded manually.
- To disable a site's automatic access, change its site access in Chrome's
  extension details. Removing the extension also removes its normal saved data.

## Fullscreen and Incognito

Player-container fullscreen keeps the draggable overlay and CaptionDrop settings.
When Chrome puts the `<video>` element itself into native fullscreen, CaptionDrop
uses a native subtitle track. Exit native fullscreen to drag captions or use the
CaptionDrop settings again. Other subtitle tracks are left under the player's
control. CaptionDrop clears its native cues when fullscreen ends.
Only the currently displayed text is placed in the native track; future cues
remain in the extension's isolated context.

For private windows, open CaptionDrop's **Details** at `chrome://extensions` and
enable **Allow in incognito**. Private captions and their settings stay only in
the current page’s memory. Reloading or closing that page discards them; they
are never added to local or session subtitle storage and cannot restore on a
later visit. Site permissions you grant remain controlled by Chrome.
Automatic loading cannot be enabled from a private window.

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
  text so your selected appearance is applied consistently. To bound page layout
  work on malformed or extreme files, the overlay displays up to 32 simultaneous
  cues and 8,192 characters at a time; the complete subtitle file is retained.
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
npm run test:hardening
npm run test:prerender
npm run test:incognito
npm run package
```

The extension itself uses plain JavaScript, HTML, and CSS. Playwright is a
development dependency only. Verification uses Node.js 22 or newer. Browser tests use a temporary browser profile and
generated local video fixtures; they do not use your own Chrome profile.
The MP4 fixture uses independently decodable frames for reliable paused seeks.
Tests identify fixture tabs by document markers and wait for media seek completion
instead of relying on the last focused browser window. Test waits use the monotonic
clock, so system clock adjustments (common under WSL2) cannot end them early. Test
profiles enable Chrome's developer mode: Chrome 156 and later otherwise disable a
reloaded unpacked extension.

If an installed Chrome build blocks unpacked extension automation, install the
test browser with `npx playwright install chromium`, or specify an extension-capable
Chrome/Chromium executable using `CAPTIONDROP_BROWSER_PATH`.

The release ZIP includes only extension runtime files and icons. Project scope
and implementation choices are recorded in [`REQUIREMENTS.md`](REQUIREMENTS.md).

## Verification results

Verified on Linux with Chrome 140. The browser, adversarial, prerender and Incognito
suites also pass on Chrome for Testing 156 (Stable) and 157 (Beta):

- **97 unit/integration tests pass** for bounded SRT parsing, UTF-16 handling,
  cue lookup, stable provider identities, sender authorization, storage migration,
  atomic eviction, failed saves, concurrent player handoffs, iframe restoration,
  permissions, worker restarts, private-storage exclusion, document-pinned
  navigation checks, metadata-only settings writes, quota retries, bounded rendering,
  damaged/missing-index repair, newer-schema protection, picker window reuse, coalesced
  navigation prompts, opaque embedded top-page tokens, episode-aware identities,
  and site ownership across eviction, quota retries, repair, and upgrades.
- **34 real-browser checks pass**, including the extension-owned file picker,
  closed controls, rejection of forged webpage actions, position-only movement,
  caption timing, styling, dragging, both fullscreen modes, iframe replacement,
  stale picker targets, stable player selection, provider preview handling,
  restricted storage access, per-origin permission requests, extension reload,
  a full browser restart, forgetting subtitles, YouTube/Bilibili in-page navigation,
  autoplay during file selection, tag-heavy quota accounting, lazy frame context
  initialization, and shared-observer cleanup.
- **11 adversarial browser checks** cover custom-element hijacks, forged lifecycle
  events, embedded navigation, document reservations, delayed top-frame videos,
  zoom/transforms/dialogs, current-text-only native captions, immediate provider
  navigation, batched/rate-bounded restore requests, recovery past damaged saved
  captions, and cross-site forged-save floods that preserve the victim's captions
  and appearance. A separate raw-CDP test
  verifies real prerender activation without page DevTools disabling prerendering.
- **6 real split-Incognito checks pass**: page-only captions, no private subtitle
  text/filename/identity in extension storage, preservation across a normal
  window closing, deletion on private-page reload, and no restoration after
  closing and reopening the last private window, plus disabled automatic-loading
  controls and rejection of persistent private automatic-loading preferences.
- The headless test profile uses a disposable copy of the extension with access
  granted only to local fixture hosts and routed YouTube/Bilibili fixtures.
  This models already-granted site access; native permission prompts
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
- Re-running the audit probes after optimization measured **15.7 ms** for a
  4,000-shadow-root mutation burst, approximately **2 ms of script per second**
  during pathological overlapping-cue playback, and approximately **3 ms** per
  settings update for a maximum-size file. Startup with full memory took
  approximately **1 ms**, and 11 frames containing no video sent **zero** worker
  messages. These are single-machine observations; the startup probe could not
  force a cold worker restart, so its timing covers initialization itself.
- Restore lookups use batches of up to 256 candidate videos, with at most one
  request in flight and a 250 ms minimum interval per frame. Empty memory stops
  further automatic lookups until a scan or navigation. History notifications
  update activated pages immediately, with a low-frequency polling fallback.

For bounded live provider probes in addition to the local tests, run
`CAPTIONDROP_LIVE=1 npm run test:browser`.
Live mode enables Chrome's sandbox and fails if the environment cannot support
it. The local fixture suites use a disposable profile with the sandbox disabled.
