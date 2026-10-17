# CaptionDrop — Version 1 Requirements

## Document status

Requirements discussion is in progress. This file records the agreed project
boundary and the requirements discussed so far. Update it as decisions are made.
Implementation has not started; creating this document does not authorize
building the extension yet.

The confirmed direction is local-file subtitles, video detection across websites,
and a basic, fast, stable, light extension. The user has also confirmed the file
loading flow: select a detected video, click it to open a file browser, and choose
the local subtitle file for that video. A small CaptionDrop button near the
video's existing controls at the bottom of the player is also confirmed. The
user has confirmed caption text size, text color, and background color controls,
plus repositioning subtitles by dragging them with the mouse, and explicitly
excluded manual subtitle timing adjustment. Remembering subtitles and loading
them automatically on a return visit is also confirmed; whether memory applies
to an individual video or the whole website is still being clarified. Other
detailed behaviors and acceptance scenarios below are a draft baseline for
review; they have not all been individually approved. The remaining functional
requirements still need their details settled. Open decisions below are not
additional approved features.

The visual direction is confirmed: a simple, elegant interface, with the familiar
feel of YouTube's caption controls and the restrained appearance of Apple design.
The exact visual design remains to be decided.

# Purpose

CaptionDrop is a Chrome extension that lets a user display their own subtitle file
over an online video. Version 1 should provide the basic experience and be fast,
stable, and light.

## Version 1 scope baseline

- Browser: desktop Google Chrome.
- Subtitle source: a local file supplied by the user.
- Initial subtitle format: SubRip (`.srt`).
- One selected video and one loaded subtitle file at a time.
- Video compatibility: standard HTML5 video that Chrome allows the extension to
  access, across websites rather than a fixed list of supported sites.
- Initial compatibility test targets include YouTube and Bilibili. Support must
  be verified before it is claimed.
- On first use, activate detection when the user clicks CaptionDrop.
- On a return visit to a remembered target, restore saved subtitles automatically
  where Chrome grants access. This is an exception to initial manual activation.
  Avoid continuous scanning of unrelated browsing activity.
- Subtitle processing stays in the browser; no account or server is needed.
- Remember subtitle data locally so the user need not choose the file again on a
  matching return visit. The website-versus-video matching rule remains open.
- Caption appearance controls: text size, text color, and caption background color.
- Caption positioning: move the subtitle block within the selected video by
  dragging it with the mouse.
- Subtitles follow the video's playback clock automatically. Manual timing
  adjustment is outside version 1.
- Interface style: simple, compact, and elegant, with clear controls and minimal
  visual clutter.

## Confirmed user flow — Select a video and choose subtitles

1. Activate CaptionDrop on a page containing videos.
2. CaptionDrop detects the accessible videos and makes them selectable.
3. Click the video to receive subtitles in CaptionDrop's selection interface.
4. A file browser opens so the user can navigate to their local subtitle file.
5. Choose an `.srt` file and confirm the selection.
6. CaptionDrop loads that file for the selected video and displays its subtitles
   according to the video's playback time.
7. A small CaptionDrop button is available near the selected video's existing
   controls at the bottom of the player. Its click action remains to be decided.
8. The user can drag the displayed subtitles with the mouse to change their
   position within the video.

Use the system's standard file selection dialog. The exact presentation of
detected videos, such as a list or highlights on the page, remains to be decided.

On a matching return visit, CaptionDrop restores the remembered subtitles once
the target video is available, without requiring another extension click or file
selection. Matching details are covered by FR-09 and remain to be decided.

## Functional requirements

### FR-01 — Detect videos across websites

Status: the cross-website detection goal and ability to select a detected video
are confirmed. Other detailed behavior and the technical compatibility boundary
below are proposed for review.

When the user activates CaptionDrop, or returns to a remembered target under
FR-09, it must find accessible videos on the current webpage without depending on
the page being a particular website.

Proposed required behavior:

1. Detect standard HTML5 videos already present on the page.
2. Detect videos that appear after initial page loading while CaptionDrop is
   active, including replacement videos during navigation within a site.
3. Detect videos in embedded players where Chrome grants the required access.
4. If multiple videos are available, let the user choose which receives subtitles.
5. If no accessible video is found, display a clear message and provide a way to
   scan again.
6. Detection and selection must preserve the video's playback state and position.

Acceptance scenarios:

| Scenario                                            | Expected result                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Page contains one accessible HTML5 video            | CaptionDrop finds it and makes it available for subtitle attachment.                  |
| Page contains multiple accessible videos            | The user can choose the target video.                                                 |
| Video appears after activation                      | CaptionDrop detects it while active.                                                  |
| Site replaces its player without a full page reload | CaptionDrop discovers the replacement without attaching subtitles to the wrong video. |
| Video is inside an accessible embedded frame        | CaptionDrop finds the embedded video.                                                 |
| No accessible video is available                    | CaptionDrop shows a useful message and a scan-again action.                           |
| Detection runs while a video is playing or paused   | Playback state and position remain unchanged.                                         |

Compatibility boundary:

- "Across websites" means support for accessible HTML5 video, not a guarantee
  that every player on every website works.
- Browser-restricted pages and frames without permission are outside the
  accessible-video boundary. Communicate when access is unavailable.
- Unusual or inaccessible players may require later integration work.
- The permission model for embedded frames still needs to be decided.

### FR-02 — Select a video and load a local subtitle file

Status: selecting a detected video and clicking it to open a file browser for the
local subtitle file is confirmed. Recovery behavior below is proposed.

Required interaction:

- Make the detected videos selectable so the user can choose the intended target.
- Clicking a detected video in the selection interface opens the system's file
  browser. The user can navigate folders and choose a local `.srt` file.
- Read and process the chosen file locally, then attach its subtitles only to the
  selected video.
- Preserve the video's playback state and position during this flow.

Proposed recovery behavior:

- Cancelling the file dialog leaves any currently loaded subtitles unchanged.
- Invalid or unreadable files produce a clear message and allow the user to try
  another file without losing any currently loaded subtitles.
- If the selected video disappears before loading finishes, explain that it is
  unavailable and let the user select a video again.

Acceptance scenarios:

| Scenario                                                 | Expected result                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| User clicks a detected video in CaptionDrop              | A local file selection dialog opens for that target video.                    |
| User navigates folders and selects a valid `.srt` file | CaptionDrop loads the subtitles for the selected video.                       |
| Several videos are present                               | Only the video the user selected receives the chosen subtitles.               |
| User cancels file selection                              | No subtitle file is loaded or replaced.                                       |
| User selects an invalid or unreadable file               | A clear error and retry path are available; existing subtitles remain usable. |
| Selected video disappears before the file is attached    | CaptionDrop reports the unavailable target and allows video selection again.  |

Open details: how detected videos are presented, supported file encodings, and
file size limits.

### FR-03 — Display subtitles in sync with playback

- Show the subtitle text belonging to the selected video's current playback time.
- Keep timing correct through play, pause, seeking, and playback speed changes.
- Show no subtitle when there is no active subtitle cue.
- Detailed subtitle parsing and overlapping-cue behavior remain to be decided.

### FR-04 — Customize caption appearance

Status: caption text size, text color, and background color controls are confirmed.
Manual subtitle timing adjustment is excluded from version 1.

Required controls:

- Let the user choose the caption text size.
- Let the user choose the caption text color.
- Let the user choose the caption background color.
- Apply the chosen appearance to CaptionDrop's subtitles on the selected video.

Proposed behavior and acceptance scenarios:

| Scenario                                  | Expected result                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| User changes the caption size             | Displayed caption text updates to the chosen size without reloading the file.            |
| User changes the caption text color       | CaptionDrop's subtitle text uses the chosen color.                                       |
| User changes the caption background color | The background behind CaptionDrop's subtitle text uses the chosen color.                 |
| User changes appearance during playback   | Playback state, playback position, and automatic subtitle synchronization are preserved. |
| User enters supported fullscreen playback | The chosen appearance is retained in fullscreen.                                         |

Open details: default appearance, supported size range and units, color selection
controls, and whether appearance settings persist between videos or sessions.

### FR-05 — Keep subtitles readable

- Use a readable default subtitle appearance.
- Display subtitles in normal view and supported fullscreen video playback.
- Honor the text size, text color, and background color selected through FR-04.
- Honor the subtitle position chosen by mouse dragging through FR-08.
- Default appearance, default caption placement, and fullscreen compatibility
  details remain to be decided and tested.
- Appearance customization beyond the three controls in FR-04 and mouse
  positioning in FR-08 is outside version 1.

### FR-06 — Control the loaded subtitles

- Let the user turn subtitles off.
- Let the user replace the current subtitle file.
- Do not interrupt video playback when doing either action.
- Remember subtitles for automatic restoration under FR-09. Whether appearance,
  position, and the on/off setting are also remembered remains to be decided.

### FR-07 — Provide a CaptionDrop button in the video player

Status: a small icon button at the bottom of the video, near the player's existing
controls, is confirmed. Its click action, exact appearance, and detailed behavior
remain to be decided.

Required placement:

- Provide an identifiable CaptionDrop icon button on the selected video player.
- Position it near the original playback controls along the bottom of the video,
  using YouTube's player controls as an example of the intended location.
- Keep the original controls usable and avoid covering captions or other buttons.
- Make the button available after manual activation for the selected video or
  automatic restoration for a remembered target under FR-09.

Proposed behavior for review:

- Clicking the button opens a small CaptionDrop panel for the existing version 1
  subtitle actions: choose or replace a file, turn subtitles on or off, and change
  caption text size, text color, and background color. A file selection action in
  that panel opens the system file browser. The panel has no manual subtitle
  timing adjustment controls.
- Keep the button usable in normal view and supported fullscreen playback.
- Where the player hides its controls, show and hide the button with those
  controls.
- Support keyboard activation and provide an accessible "CaptionDrop" label.
- Add only one button for the selected player, including after repeated activation.

Proposed acceptance scenarios:

| Scenario                                               | Expected result                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| User selects a video in CaptionDrop                    | One CaptionDrop button is available near the bottom player controls.     |
| Selected video uses YouTube's player                   | The button sits near the existing controls and does not obstruct them.   |
| User uses the original player controls                 | Playback, volume, seeking, settings, and fullscreen controls still work. |
| User enters supported fullscreen playback              | The CaptionDrop button remains accessible.                               |
| CaptionDrop is activated repeatedly for the same video | The player still has only one CaptionDrop button.                        |

Open details: button artwork, precise placement for each player, click action,
panel layout if a panel is chosen, and fallback placement for players without an
accessible bottom control bar. Substital is an interaction reference; the exact
CaptionDrop design has not been chosen. Follow the visual direction in NFR-05.

### FR-08 — Reposition subtitles by dragging with the mouse

Status: changing the subtitle position by mouse dragging is confirmed. YouTube's
draggable captions are an interaction reference. Detailed behavior below is
proposed for review.

Required interaction:

- Let the user press and hold the mouse on CaptionDrop's displayed subtitle
  block, drag it horizontally or vertically, and release it at a chosen position
  within the selected video.
- Move the subtitle block as a whole, including its text and background.

Proposed behavior and acceptance scenarios:

| Scenario                                                   | Expected result                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| User drags the displayed subtitle block                    | The block follows the pointer and stays at the chosen position on release.        |
| The next subtitle cue appears                              | It uses the chosen position rather than returning to the default location.        |
| User drags while the video is playing or paused            | Playback state, playback position, and subtitle synchronization are preserved.    |
| User drags toward the edge of the video                    | The subtitle block stays within the visible video bounds.                         |
| Video size changes or the user enters supported fullscreen | The chosen relative position is maintained, with the block kept inside the video. |
| User interacts with the original player controls           | Dragging support does not obstruct those controls.                                |

Open details: drag feedback, default position, whether a reset-position action is
needed, and behavior when changing videos or reloading. Remembering positions
across sessions has not been agreed.

### FR-09 — Remember subtitles and restore them on return visits

Status: remembering captions and automatically loading them when revisiting the
site is confirmed. The matching rule and storage details remain open.

Required behavior:

- Remember the subtitles previously loaded by the user locally in the browser.
- On a matching return visit, load the remembered subtitles automatically when
  the target video becomes available and Chrome permits access.
- Do not require the user to select the same file again or click the extension
  again for a matching return visit.
- Keep restoration local; no account, server, or subtitle upload is needed.
- Preserve the video's playback state and position during restoration.

Matching decision pending:

- Recommended: remember each individual video separately, so different videos
  on the same website can use different subtitle files.
- Alternative: reuse the website's last subtitle file across the whole site.
- The user has been asked which behavior they want. Neither matching rule is
  confirmed yet; the implementation must not assume one is approved.

Proposed storage and recovery behavior:

- Save subtitle contents locally so restoration does not depend only on the
  original file's name or path.
- Keep remembered subtitles across browser restarts.
- Provide a way to replace or forget a remembered subtitle association.
- If saved data is unavailable, unreadable, or cannot be stored, explain the
  issue and allow the user to choose a subtitle file manually.
- Restore only when the current target matches the agreed rule. Handle sites
  that change videos without a full page reload using the same matching rule.

Proposed acceptance scenarios:

| Scenario | Expected result |
| --- | --- |
| User revisits a remembered target under the agreed matching rule | Captions load automatically without reopening the file browser. |
| The matching video appears after the page initially loads | Restoration happens once the video is available. |
| User visits a target that does not match saved memory | CaptionDrop does not apply an unrelated saved subtitle file. |
| User returns after restarting Chrome | The remembered association and subtitle contents remain available. |
| User replaces a remembered subtitle file | Future matching visits use the replacement file. |
| Restoration cannot access saved data or the target video | CaptionDrop explains the issue and provides a manual recovery path. |

Open details: website-versus-video matching, identifying a target reliably,
retention and storage limits, a forget-memory action, and site access needed for
automatic restoration. Remembering appearance, dragged position, caption on/off
state, or video playback position is not confirmed by this requirement.

## Non-functional requirements

### NFR-01 — Fast

- Activation, video detection, subtitle loading, and restoration should feel
  responsive.
- Keep captions aligned with the video's playback clock.
- Avoid unnecessary repeated processing or expensive work during playback.
- Numeric timing targets, representative subtitle sizes, and test hardware still
  need to be agreed; no performance results have been established yet.

### NFR-02 — Stable

- Handle missing videos, invalid files, and changing players gracefully.
- Preserve playback state and avoid interfering with the webpage's controls.
- Repeated activation or file replacement must not create duplicate subtitle
  displays or leave obsolete video attachments active.
- Give the user a useful recovery action when an operation fails.
- Test actual behavior on YouTube, Bilibili, and representative HTML5 video pages.

### NFR-03 — Light

- Proposed implementation approach: plain JavaScript, HTML, and CSS.
- Avoid large frameworks and unnecessary dependencies.
- Keep background activity and idle resource use minimal.
- Keep automatic restoration checks limited to remembered targets and avoid
  repeatedly loading saved subtitle contents when they are not needed.
- Release resources associated with videos or subtitles that are no longer active.
- Package size, CPU, and memory budgets still need to be agreed and measured.

### NFR-04 — Local processing

- Keep subtitle file contents in the browser; do not upload them.
- Keep remembered subtitle data in browser-local extension storage.
- Require no account, backend, or external subtitle service for the core features.
- Request browser permissions needed for the agreed behavior. The exact
  permission design remains open.

### NFR-05 — Simple, elegant interface

Status: a simple and elegant design inspired by YouTube's caption interface and
Apple's design style is confirmed. Detailed styling and layout below are proposed.

Design requirements:

- Keep the extension interface compact, easy to understand, and visually quiet.
- Use familiar video-player controls and concise labels for the agreed features.
- Make the CaptionDrop player button fit naturally beside the existing controls.
- Keep the video and captions visible while users interact with the controls.
- Preserve readable text and identifiable, usable controls.
- Keep visual effects and interface assets consistent with the fast and light
  requirements; no heavy design framework is needed.

Proposed visual approach:

- A small, clearly organized panel for the main subtitle actions and appearance
  controls, if the panel interaction proposed in FR-07 is chosen.
- Readable system typography, consistent spacing, and a clear visual hierarchy.
- A restrained neutral palette, subtle rounded corners, and simple icons.
- Clear hover, selected, and keyboard-focus states.
- Restrained shadows and transitions where they help explain an interaction.

This requirement governs the extension's interface. Users still control their
caption text size, text color, background color, and position through FR-04 and
FR-08.

Open details: exact palette, spacing, icon artwork, panel layout, and final visual
review. Automatic light/dark themes or a theme switcher have not been requested.

## Outside version 1

- Online subtitle search or downloads.
- Automatic captions, speech recognition, or AI transcription.
- Translation.
- Editing subtitle text or individual cue timings.
- Manual subtitle timing adjustment, including offset or delay controls.
- Appearance customization beyond caption text size, text color, background
  color, and mouse positioning, such as font family selection or custom layouts
  beyond moving the subtitle block.
- Simultaneous subtitle tracks or subtitles on multiple videos at once.
- Guaranteed compatibility with every website or custom video player.
- Additional subtitle formats, including `.vtt`, unless explicitly added later.

## Decisions to settle before implementation

1. Supported file encodings and sizes. The file-browser interaction is confirmed.
2. Presentation of detected videos for selection and permission handling for
   embedded players. Clicking a selection must open the file browser.
3. Subtitle parsing details, including multiline text and overlapping cues.
4. Caption size range and units, defaults, and text and background color controls.
5. Default caption position, drag interaction details, and fullscreen behavior.
   Mouse dragging to change the position is confirmed.
6. Memory matching rule: remember each individual video or reuse a file across
   the whole website. Also settle identification during navigation and reloads.
7. Measurable performance and resource budgets and the test environment.
8. Player button appearance and exact placement, what clicking it opens, and
   placement on players without accessible bottom controls.
9. Memory storage and retention limits, forgetting or replacing saved captions,
   and browser permissions needed for automatic restoration.
10. Whether appearance settings, dragged position, or caption on/off state are
    remembered in addition to subtitle contents.
11. Final interface layout and visual details within the simple, elegant direction
    confirmed in NFR-05.

## Proposed version 1 completion criteria

- The open decisions required to implement the agreed features have been resolved
  in this document.
- All nine functional requirements work within the documented compatibility
  boundary.
- Detection and subtitle playback have been verified on the agreed test pages,
  including YouTube and Bilibili; any remaining limitations are documented.
- Agreed performance and resource budgets have been measured and met.
- The interface follows NFR-05 and has been visually reviewed for clarity,
  readability, and fit beside the original video-player controls.
- Invalid files, unavailable video access, and video replacement have been tested.
- Automatic restoration has been verified against the agreed matching rule and
  storage behavior, including delayed video loading and navigation between videos.
- The user can load the unpacked extension in Chrome and follow concise usage
  instructions.
