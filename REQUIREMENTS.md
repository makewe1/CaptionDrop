# CaptionDrop — Version 1 Requirements

## Status and purpose

The user authorized implementation of this specification. Version 0.1.2 implements
local-file subtitles with a simple, elegant interface. This file records the
required behavior, project boundary, and practical defaults chosen for this build.
Verification details and installation instructions are in `README.md`.

CaptionDrop's priorities are **fast, stable, and light**. It runs locally without
an account, backend, subtitle upload, or external runtime dependencies.

## Version 1 boundary

- Desktop Google Chrome 120 or newer; Manifest V3.
- One selected video and one subtitle file at a time in each browser tab.
- Standard HTML5 videos across websites, including dynamically loaded videos,
  accessible embedded frames, and open shadow-root players.
- YouTube and Bilibili have video identity and control-bar adapters. Their live
  websites are compatibility targets; support must be tested before it is claimed.
- Local SubRip (`.srt`) files only: UTF-8 or BOM-marked UTF-16, at most 2 MiB and
  20,000 non-empty cues.
- Initial detection follows a click on the toolbar icon. Automatic restoration
  runs on sites where the user has enabled automatic loading and granted access.
- Caption text size, text color, background (Black or Transparent), and position are customizable.
- Caption timing follows video playback automatically; no manual timing controls.
- Interface: compact, clear, and elegant, with YouTube-like control familiarity
  and an Apple-inspired, restrained visual direction.

## Main user flow

1. Open a webpage with a video and click CaptionDrop in Chrome's toolbar.
2. See the detected videos and select one.
3. Clicking a video entry immediately opens the system file browser.
4. Navigate to a local `.srt` file and select it.
5. Captions appear on the selected video at the video's current playback time.
6. Use the small CaptionDrop button near the player's bottom controls to change
   appearance, visibility, or the loaded file.
7. Drag the subtitle block to move it within the video.
8. Enable automatic loading for the website once. On a matching return visit,
   saved subtitles are restored without choosing the file or clicking CaptionDrop.

## Functional requirements

### FR-01 — Detect videos across websites

- Detect accessible HTML5 videos without limiting the extension to one website.
- Include videos that appear later or replace a player while the page is active.
- Discover accessible embedded videos and videos inside open shadow roots.
- Present multiple detected videos so the user can choose the intended target.
- Show a useful no-video or access-unavailable message and a scan-again action.
- Preserve the website's playback state and position while detecting videos.
- Handle navigation within a single-page website and stop displaying captions
  when the active video's identity no longer matches its saved subtitle association.

Acceptance: verify single, multiple, late-loaded, replaced, embedded, and absent
videos; detection must not pause, restart, or seek the video.

### FR-02 — Select a video and load a local subtitle file

- Use a selectable list of detected videos in the toolbar popup.
- Clicking a video entry opens the system file browser directly.
- Read and validate the selected SRT locally; attach it only to the chosen video.
- Cancelling selection leaves the existing captions unchanged.
- Invalid or unreadable replacements show a useful message and retain existing
  captions. A missing target permits selecting a video again.
- Enforce the encoding, file size, and cue count limits above.

Acceptance: verify the real file chooser, cancellation, Unicode, multiline text,
malformed files, oversized files, replacement, and correct video selection.

### FR-03 — Display subtitles in sync with playback

- Use the video's current playback time to select the active subtitle cues.
- Remain synchronized through playing, pausing, seeking, and speed changes.
- Display overlapping cues together and no text during gaps between cues.
- Render subtitle contents as plain text, including multiline and right-to-left
  text; embedded file markup must not execute as HTML.
- Do not add manual time shifting, offset, delay, or individual cue editing.

Acceptance: verify cue boundaries, overlaps, gaps, forward and backward seeking,
pausing, and different playback speeds.

### FR-04 — Customize caption appearance

- Provide controls for text size, text color, and caption background with exactly
  two options: Black and Transparent.
- Apply changes immediately to CaptionDrop's subtitle block without reloading the
  file, seeking, pausing playback, or changing synchronization.
- Retain the selected appearance when changing cues and entering fullscreen.

Build defaults: 28 px white text on a transparent caption background; text size range
16–64 px; a standard text color picker and Black/Transparent background selector;
settings remembered per video. Previously saved custom backgrounds fall back to Transparent.

### FR-05 — Keep subtitles readable in normal view and fullscreen

- Start with a readable appearance and a bottom-center position inside the video.
- Respect user-selected appearance and dragged position.
- Keep the subtitle block inside the visible video bounds when resized.
- In player-container fullscreen, retain the overlay, dragging, and settings.
- In native fullscreen directly on a `<video>`, render captions using a native
  subtitle track. Exit that mode to drag captions or access CaptionDrop settings.
- Do not replace or remove the website's existing subtitle tracks.

Acceptance: test normal view, resizing, player-container fullscreen, native video
fullscreen, repeated fullscreen entry, and cleanup after leaving fullscreen.

### FR-06 — Control loaded subtitles

- Let the user show or hide captions and replace the subtitle file.
- Preserve playback state and position when changing these controls.
- Keep the player's CaptionDrop control available when captions are hidden.
- Remember subtitle contents and settings as described in FR-09.

### FR-07 — Provide a CaptionDrop button in the player

- Add a small, identifiable CaptionDrop icon button near the bottom playback
  controls of the selected video.
- Place it alongside available YouTube/Bilibili controls; use an overlay fallback
  near the control area for other players.
- Clicking it opens a compact panel with file selection/replacement, caption
  visibility, text size, text color, background (Black or Transparent), and forget-memory actions.
- Keep existing player controls usable; avoid duplicate CaptionDrop buttons.
- Support keyboard activation, clear labels, and visible focus.
- Keep the button available after manual loading or automatic restoration.

Acceptance: verify button placement, repeated activation, panel controls, keyboard
interaction, player-container fullscreen, and no interference with playback.

### FR-08 — Reposition subtitles by mouse dragging

- Press and hold on the subtitle block, drag horizontally or vertically, and
  release to choose its position within the selected video.
- Move text and background as one block.
- Carry the chosen position over to subsequent cues.
- Preserve playback and synchronization; prevent the drag from triggering the
  website's click-to-pause or seeking behavior.
- Maintain relative position when the player resizes or uses container fullscreen.
- Keep captions within the visible video area.

Build default: persist relative position per video. Arrow keys also move a focused
caption block. Dragging applies to the DOM overlay; native video fullscreen uses
the browser's subtitle renderer as described in FR-05.

### FR-09 — Remember and automatically restore subtitles

- Save subtitle contents locally so future visits do not depend on reopening the
  original file or remembering its filesystem path.
- Restore captions automatically when a saved target becomes available, provided
  the user has granted site access and enabled automatic loading for that site.
- Restore without opening the file browser or changing video playback position.
- Apply saved captions only to their matching video, including after site navigation.
- Let the user replace or forget the saved association. Forgetting does not remove
  captions already loaded for the current visit.
- If saving fails, keep loaded captions usable and explain that memory is unavailable.

Build decisions:

- Memory is per individual video, rather than reusing one file across a domain.
- YouTube uses the video ID; Bilibili separates video IDs, multipart selections,
  and episode IDs. Generic sites use normalized page/source identity and player
  ordinal, with the top page included for embedded players.
- Persist subtitle contents, text size, colors, relative position, and visibility.
  Do not save or restore video playback position.
- Keep at most 50 saved videos and approximately 8 MiB of caption data. Remove
  the oldest saved entries when the memory budget is exceeded.
- Normal-window memory stays in browser-local extension storage. Incognito memory
  uses separate session storage and is cleared after the last private window closes.
- Automatic loading uses optional per-site access and persisted script registration.
  Cross-origin embedded players may require their own site-access grant.

Acceptance: test restoration after reload and browser restart, delayed video
loading, separate video identities, SPA navigation, cache limits, forgetting,
permission revocation, and private-session separation.

## Non-functional requirements

### NFR-01 — Fast

- Keep activation, scanning, loading, appearance changes, and restoration responsive.
- Use indexed cue lookup and the video playback clock.
- Avoid rereading subtitle files or rebuilding the cue index during playback.
- Avoid a caption animation loop while the video is paused or captions are hidden.

### NFR-02 — Stable

- Handle missing/replaced players, invalid files, inaccessible frames, and memory
  failures without interrupting the website.
- Prevent duplicate overlays, buttons, native fallback cues, and stale attachments.
- Clean up listeners, timers, observers, and native fallback cues on detachment.
- Preserve the selected-video reservation across background service-worker restarts.
- Use useful status messages and manual recovery paths.

### NFR-03 — Light

- Use plain JavaScript, HTML, and CSS with no runtime framework or external service.
- Run no continuous all-website scanner before activation or site permission.
- Limit automatic restoration to explicitly enabled sites.
- Avoid full-page rescans for unrelated page mutations and bound saved-caption data.
- Package only the extension runtime files and icons; exclude tests and tooling.
- Measure package size and representative parser performance. No universal CPU,
  memory, or startup-time claim is made without an agreed test environment.

### NFR-04 — Local processing

- Keep subtitles and saved data in the browser; no uploads or analytics.
- Use the minimum required extension APIs plus optional website permissions for
  automatic restoration and otherwise inaccessible embedded players.
- Explain site access and remembering behavior in concise usage instructions.

### NFR-05 — Simple, elegant interface

- Keep the interface compact and understandable, with familiar caption controls.
- Use a simple, original taichi-inspired icon: one solid monochrome flowing
  shape, with no badge, border, dots, or interior details. Use the same silhouette
  in the player's control color for the in-player button.
- Use system typography, consistent spacing, restrained colors, simple icons,
  subtle rounded corners, and clear hover/focus/selected states.
- Use one compact settings panel instead of adding complex screens.
- Keep the video and captions as the main focus.
- Avoid decorative effects or dependencies that undermine speed or package size.
- Interface styling must not override the user's caption appearance preferences.

## Outside version 1

- Online subtitle search/download, automatic transcription, and translation.
- Subtitle text editing, individual cue editing, and manual timing adjustments.
- Additional subtitle formats, including VTT.
- Multiple simultaneous subtitle tracks or captioned videos within one tab.
- Font-family selection and layout customization beyond size, colors, and dragging.
- Universal support for every website, closed shadow trees, browser-restricted
  pages, non-HTML5 players, or picture-in-picture overlays.
- Cloud accounts, servers, synchronization across devices, and saving playback position.

## Completion and remaining verification

The build should provide an unpacked Chrome extension and a runtime-only ZIP,
with installation instructions, meaningful automated tests, and documented limits.
Tests must cover parser safety, cue timing, memory, permissions, and actual browser
interaction with generated local video fixtures. Live YouTube/Bilibili streaming
compatibility must be reported separately from fixture and identity-rule tests.

Additional manual compatibility checks on real sites and platforms may still be
needed after automated verification. Record actual results without treating
untested scenarios as confirmed support.
