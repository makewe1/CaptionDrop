# CaptionDrop Privacy Policy

Last updated: 24 October 2026

CaptionDrop is a Chrome extension that displays subtitles from user-selected
local SRT files on supported web videos. This policy explains the information
the extension accesses, how it uses that information, and the controls available
to users.

## Information accessed and stored

CaptionDrop accesses the following information to provide its subtitle features:

- **Subtitle files:** the contents and filenames of SRT files selected by the
  user. The extension saves a local copy so subtitles can be restored for the
  same video. It does not retain the original file's full local path.
- **Video and webpage information:** page, frame, and media URLs; provider video
  identifiers; page and video titles; and player information needed to find and
  identify videos. Saved video associations contain a one-way hash derived from normalized
  URLs or provider identifiers, rather than readable copies of those values.
  A separate one-way hash of the top-level and player-frame origins limits which
  records can be removed to make room for a save. Page and video titles are used to label detected videos and are
  not saved in subtitle records. CaptionDrop's scripts in embedded frames receive only
  an opaque token for the top-level page, not its address.
- **Playback state:** the video's current playback time and playback events,
  used to synchronize captions. These are not retained as a viewing or
  interaction history.
- **Settings:** caption size, text color, background, position, visibility,
  automatic-loading website preferences, and timestamps associated with saved
  subtitle records. Selected tab and frame identifiers are kept temporarily to
  coordinate the active player.

## How information is used

Subtitle file selection takes place in the extension's own interface.

CaptionDrop uses this information only to detect videos, display and synchronize
subtitles, apply caption settings, and restore saved subtitles for the matching
video. Website access is requested when needed for automatic loading or access
to embedded players. Users control these permissions through Chrome.

Caption text and subtitle cues are inserted into the selected webpage to display
subtitles, including through a native subtitle track when needed. Scripts running
on that webpage may be able to access this information. Filename, status, and
settings controls use closed shadow roots to reduce direct webpage access;
these are not a security boundary against a compromised browser process.
Only currently displayed text is published to the native subtitle track; the
remaining file stays in the extension's isolated context. Native subtitle cues
are cleared when native fullscreen ends. A webpage can
retain information it already read while the cues were available.

## Transmission and sharing

The extension processes subtitle files and video associations on the user's
device. It does not upload this information to the developer or to analytics or
advertising services, and it has no developer-operated backend.

CaptionDrop contains no advertising or analytics tracking. User data is not sold
or used for advertising, profiling, creditworthiness, lending, or purposes
unrelated to the extension's subtitle features.

## Storage and retention

Normal subtitle records and automatic-loading website preferences are stored in
Chrome's local extension storage. CaptionDrop does not use Chrome's sync storage
to synchronize this information between devices.

Saved subtitle memory is limited to 50 video records and approximately 8 MiB.
Only older records belonging to the same top-level and player-frame origins can
be removed to make room for a save. Other sites' records and legacy records
without ownership metadata are protected; a save fails if there is insufficient
space within its own site's records. Otherwise, saved records remain until they are replaced, deleted using
the extension's controls, or removed by uninstalling the extension. Deleting the
original SRT file does not delete the extension's saved copy. Clearing ordinary
browsing history or cached website files does not remove extension storage.

Incognito subtitles, filenames, and appearance settings stay only in the current
page’s memory. They are not saved to local or session extension storage, are not
restored on another visit, and are discarded when the page reloads or closes.
Legacy private subtitle records from earlier versions are removed during startup.
Selected tab and frame identifiers use session storage for player coordination.
Automatic-loading preferences cannot be added from private windows. Website
permissions remain managed by Chrome and may persist after private windows close.

Video-association and origin-ownership hashes are stable identifiers, not
encryption. Someone with access to local extension storage can test whether a
guessed video identifier or pair of origins matches a saved hash.

## User controls and deletion

Choose **Forget saved subtitles** in the player settings to delete the saved
subtitle record for that video. Captions already loaded remain available for
the current visit. This action does not revoke website permissions.

Website access can be revoked through Chrome's extension settings. Uninstalling
CaptionDrop removes its extension storage. The developer does not hold a server
copy of locally saved subtitle records.

## Limited Use

CaptionDrop's use of information obtained through Chrome APIs complies with the
Chrome Web Store User Data Policy, including its
[Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).
Information is used only for the subtitle features described in this policy.

## Changes to this policy

Changes to data handling will be reflected in this policy and the extension's
Chrome Web Store disclosures. The date above identifies the latest policy
revision.

## Contact

For privacy questions, contact the project maintainer through the
[CaptionDrop issue tracker](https://github.com/makewe1/CaptionDrop/issues).
Messages submitted there are public and are separate from the extension's local
subtitle storage.
