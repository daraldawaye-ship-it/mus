# Automatic Android/browser notification permission

The authenticated shell now silently checks the Web Push configuration and
re-subscribes registered devices when native notification permission is already
granted. When permission is still `default`, the application requests the
browser's native Allow/Deny permission on the first **trusted click or keyboard
activation** after sign-in. This is required because browsers generally prevent
notification permission prompts launched during page load.

No separate in-app opt-in button is necessary for the initial prompt. If the
user dismisses the native prompt, the site does not repeatedly ask during the
same browser tab session. Denied permission remains denied until the user
changes browser/device settings. Existing device settings remain available for
diagnosis, tests and manual recovery.

The PWA service worker requests visible, non-silent notification delivery and
vibration, but Android/iOS and notification channels control whether a sound,
heads-up popup or lock-screen preview actually appears. Websites cannot toggle
system notification permission or override the user's OS settings. No backend,
database, or accounting state changes are involved.
