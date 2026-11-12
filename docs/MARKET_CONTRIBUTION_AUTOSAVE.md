# Market contribution autosave

Owner decision, 12 November 2026: all existing market card contribution fields
save without a Save Contribution button, not only images.

Text, numeric, multiline and compound fields submit on leaving the complete
field editor or pressing Enter (Shift+Enter keeps multiline input). Relation,
reference, option, checkbox and date choices submit immediately. Image changes
submit only after successful upload; removal submits immediately. Failed image
uploads do not create a contribution or dismiss the upload error.

Prescription choices and add-row controls submit automatically. Switching a
line's type keeps its editor open and rebases the expected value from the actual
server response, including when moderation leaves the public value unchanged.
Removing the last prescription line retains its explicit deletion confirmation.
New-card creation and moderation decisions remain explicit actions.

The existing contribution API, authority, expectedValue concurrency checks,
idempotency and review rules are unchanged. Errors keep the draft and provide
Retry, reusing the same idempotency key for the unchanged request. No production
cards, images, prices or prescriptions are created for regression testing.
Browser regression: tests/browser-market-autosave.ts (intercepted local API).
