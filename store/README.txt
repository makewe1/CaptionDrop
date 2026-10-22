CaptionDrop — Chrome Web Store listing assets

Recommended category: Accessibility
Current icon: ../icons/icon-128.png (simple monochrome taichi-inspired mark)

Text fields
- description.txt: detailed store description, ready to paste.
- short-description.txt: 125-character summary (within the 132-character limit).
- category.txt: recommended category name.
- ../PRIVACY.md: privacy policy for the public repository policy URL.

Screenshots
1. screenshots/01-local-subtitles.png — local subtitles on a sample HTML5 video.
2. screenshots/02-caption-appearance.png — actual appearance controls and repositioned captions.

Both images are 1280 x 800 pixels, 24-bit RGB PNG, without an alpha channel.
They show the real extension on a clearly labeled sample video page. The
surrounding page frames the demonstration; it does not claim a particular
streaming provider's integration. No user profile or personal content was used.

Upload either image to meet the one-screenshot minimum, or upload both in the
order above. The store accepts at most five screenshots.

Recreate the screenshots with:
  node scripts/store-screenshots.mjs

The capture script uses a temporary browser profile and a disposable extension
copy with access to the local demonstration host. It does not change the
distributed extension's manifest. Images are captured directly in the browser,
not generated or edited afterward.

References checked 2026-10-17
https://developer.chrome.com/docs/webstore/best-practices
https://developer.chrome.com/docs/webstore/images
https://developer.chrome.com/docs/webstore/prepare
