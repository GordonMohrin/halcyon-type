# Backlog

Feature requests (FR) and bugs for Split Keyboard for monkeytype. Newest first in each list.

## Open

### Bugs
- (none known)

### Feature requests
- [ ] **Chrome Web Store release**: first-run explanation (unlock lasts until unplugged, close the Vial app),
  store listing with 1280×800 screenshots, privacy policy page, test in a fresh Chrome profile, rename repo and file
  names to the new name. Then Chrome Web Store and Edge Add-ons.

### Tests
- [ ] Test with a real VIA keyboard (so far only against simulated VIA firmware).
- [ ] Re-check the W-CORNE after the Vial detection rework (it was unplugged during the check).

## Limits (not solvable without firmware changes)
- While locked, pure layer keys (MO, LT …) are invisible because they send nothing to the computer. A layer shows
  with the first key typed on it. To see it while holding, unlock once (lasts until unplugged). A firmware extension
  that reports the layer state was tried and dropped: users should not have to flash anything.

## Done
- [x] 0.3.0 – UI, docs and error messages in English; README explains unlocking and keylogger protection.
- [x] FR: VIA keyboards (extension and standalone trainer): load the layout file once, kept per keyboard, live at once.
- [x] Bug: VIA firmware slipped through as "Vial protocol 255"; detection fixed.
- [x] FR: Remember the keymap – show the last keymap read while not connected.
- [x] FR: Preferred keys in the standalone trainer too.
- [x] EurKEY host layout (US with umlauts on AltGr); can't be detected automatically, pick it in the menu.
- [x] Elora after the Vial detection rework: detected as Vial 6, live, preferences kept, keymap stored.
- [x] W-CORNE (Vial without lock, 4×12, 46 keys): connects live without unlocking, layout and labels right,
  L1/L2 switch live while held.
- [x] FR: "Other keyboard" in the menu; monkeytype reconnects the keyboard used last.
- [x] Elora live: "!" via the layer-2 key learned; menu shows "2 preferred keys remembered" + Forget.
- [x] Bug: learning ignored keys with built-in Shift (e.g. `S(KC_1)` = "!" on layer 2).
- [x] Bug: learning waited for page key events and did nothing when another window had focus. Now from the matrix.
- [x] Bug: reloading during an unlock left the keymap empty (0 layers). The unlock is now finished first.
- [x] Elora live: locked ("!" on layer 2 via preference, "1" on the base layer), modifier bar without overlap,
  unlocked "3 via layer 1" learned and shown as hint.
- [x] 0.2.0 – FR: name "Split Keyboard for monkeytype", icons, store zip in `dist/`.
- [x] 0.2.0 – FR: characters on several keys: remember the key used last and show it; while locked pick the key via
  this preference and the expected character.
- [x] 0.2.0 – Bug: Ctrl, Alt, Win and Shift overlapped in the layer/modifier bar.
- [x] 0.2.0 – FR: works without firmware changes (layer report removed from fork and app).
- [x] 0.1.x – build, tests and launcher on Windows.
