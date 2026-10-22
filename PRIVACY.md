# CaptionDrop Privacy Policy

Last updated: 22 October 2026

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
  identify videos. Saved video associations contain normalized URLs or provider
  identifiers. Page and video titles are used to label detected videos and are
  not saved in subtitle records.
- **Playback state:** the video's current playback time and playback events,
  used to synchronize captions. These are not retained as a viewing or
  interaction history.
- **Settings:** caption size, text color, background, position, visibility,
  automatic-loading website preferences, and timestamps associated with saved
  subtitle records. Selected tab and frame identifiers are kept temporarily to
  coordinate the active player.

## How information is used

CaptionDrop uses this information only to detect videos, display and synchronize
subtitles, apply caption settings, and restore saved subtitles for the matching
video. Website access is requested when needed for automatic loading or access
to embedded players. Users control these permissions through Chrome.

Caption text and subtitle cues are inserted into the selected webpage to display
subtitles, including through a native subtitle track when needed. Scripts running
on that webpage may be able to access this information.

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

Subtitle memory is limited to 50 video records and approximately 8 MiB in each
storage context. Older records are removed when necessary to remain within these
limits. Otherwise, saved records remain until they are replaced, deleted using
the extension's controls, or removed by uninstalling the extension. Deleting the
original SRT file does not delete the extension's saved copy.

Incognito subtitle records use session storage and are cleared after the last
Incognito window closes. Selected tab and frame identifiers also use session
storage. Website permissions and automatic-loading preferences are managed
separately and may persist after private windows close.

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
