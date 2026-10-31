-- One-time owner-requested switch to dark for existing users in every scope:
-- the public site and all companies. Keep each user's chosen accent color.
-- New profiles use DEFAULT_APPEARANCE (dark); future explicit choices can
-- still be changed from the appearance dialog.
UPDATE appearance
   SET mode = 'dark'
 WHERE mode = 'light';
