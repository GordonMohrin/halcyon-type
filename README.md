# Split Keyboard for monkeytype

See your own keyboard live while you type on **monkeytype.com**: your real keymap with all layers, every key you
press, the next key to hit and the finger to use. Works with any keyboard running **Vial** (and VIA, see below),
without changing its firmware. Built for split keyboards such as the splitkb Halcyon series (Kyria, Corne,
Lily58, Elora, Ferris, Sofle).

You type in the real monkeytype with your own account; results and personal bests are saved there as usual.
Below the words you get:

- every key you press, live — including layer, mod-tap and one-shot keys (after unlocking, see below)
- the active layer switches the labels; holding Shift or AltGr/Option shows what each key types right now
- the **next key** outlined in monkeytype's main color; layer and Shift keys you need for it are dashed
- **hands** with the finger that should press the next key
- a short flash after each keystroke (correct/wrong), like monkeytype's own keymap
- colors and font taken from your monkeytype theme

## Install

Chrome, Edge, Brave and Arc work. Firefox and Safari cannot talk to USB keyboards (no WebHID).

1. Download `split-keyboard-for-monkeytype-<version>.zip` from the
   [latest release](../../releases/latest) and unzip it into a folder that stays put (not your Downloads folder).
2. Open `chrome://extensions` (Edge: `edge://extensions`) and switch on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped folder.
4. Open or reload monkeytype.com. Click **⌨ Split** in the bottom right corner → **Connect keyboard** and pick your
   keyboard. Close the Vial app first — only one program can talk to the keyboard at a time.

From then on the keyboard connects automatically whenever you open monkeytype. To update, download the new zip,
replace the folder's contents and click the reload icon of the extension in `chrome://extensions`.

Prefer userscripts? `monkeytype/halcyon-monkeytype.user.js` works in Tampermonkey or Violentmonkey.

## Locked and unlocked: why Vial asks you to unlock

Vial deliberately keeps one thing secret: **which keys are being pressed right now**. Any program on your computer
that can open the keyboard's USB interface could otherwise read every keystroke — including passwords — without
needing any special permission. That would make the keyboard a perfect keylogger. So Vial only reveals its switch
matrix after you prove you are physically at the keyboard: you hold a special key combination for a few seconds.

What this means here:

- **Locked** (default, nothing to do): the extension still reads your complete keymap with all layers — that is not
  secret. It sees a key once it types a character into monkeytype, and shows the layer that character is on.
  Pure layer keys (MO, LT …) send nothing to the computer, so a layer only appears with the first key you type on it.
- **Unlocked**: every key shows live as you press it, including layer and mod-tap keys while you hold them, and
  the extension can learn which key you prefer for characters that exist more than once (see below).
  Click **Unlock** in the ⌨ menu and hold the highlighted keys until the bar is full (about 6 seconds).
  The keyboard stays unlocked until you unplug it.

While it is unlocked, any program with access to the keyboard could read your keystrokes. Unplugging the keyboard
locks it again; **Lock** in the menu does it right away. Keyboards built with Vial's "insecure" option never lock.

The extension itself sends nothing anywhere: everything stays in your browser (see [Privacy](#privacy)).

## Menu (⌨ Split)

- System layout: Automatic, US, EurKEY, German (Windows/Linux), German (Mac). It decides the labels (KC_Y shows
  as "Z" on German) and which key types a character. EurKEY can't be detected automatically — pick it here.
- Base layer, if you switched to e.g. Colemak with a DF() key
- Hands, next-key hint and the layer/modifier bar on or off
- Show encoders & modules, hide monkeytype's own keymap, size
- Other keyboard: switch between several keyboards; the last one used reconnects automatically

### Characters on more than one key

If a character exists on several keys (say "1" in the number row and on a layer), the extension remembers the key
you used last and shows that one as the next key. It learns while unlocked, straight from the keyboard, no matter
which window has focus. While locked it uses what it learned plus the key it suggested for the expected character.
**Forget** in the menu clears it.

### VIA keyboards

Keyboards with VIA instead of Vial work too. VIA firmware does not contain the layout, so the menu asks once for the
keyboard's VIA definition (JSON), e.g. from [the-via/keyboards](https://github.com/the-via/keyboards); it is kept per
keyboard. VIA never locks, so the view is live right away. Requires VIA protocol 12 (QMK from 2022 on).

### Without a connection

The last keymap read is kept. When the keyboard is unplugged or connected in another tab, the extension shows it from
storage ("stored") with a button to connect.

## Privacy

The extension only runs on monkeytype.com. It reads your keyboard over WebHID and keystrokes on the page to draw the
keyboard. Nothing is sent to any server; settings, your keymap and learned key preferences are stored in the browser's
local storage for monkeytype.com and can be removed by clearing that site's data.

## Limits

- The extension replays QMK's logic for layers, mod-tap and layer-tap (tapping term, permissive hold,
  hold on other key press), one-shot, tri-layer, TG/TO/DF/TT and Caps Word, because the firmware doesn't report its
  layer state. Combos, key overrides, auto shift and tap-dance double taps are not replayed.
- Vial protocol 6 or newer (QMK keycodes from 2022) is required.
- The Vial app and this extension should not talk to the keyboard at the same time.

## Standalone trainer (without monkeytype)

The repository also contains a standalone typing trainer with the same keyboard view (error heatmap, code mode,
floating window):

```bash
python3 tools/serve.py
```

Then open <http://localhost:8137> in Chrome or Edge. Without a keyboard: <http://localhost:8137/?demo>.
On Windows, `tools/start-windows.cmd` starts the server and opens the trainer.

## Development

Plain HTML/CSS/JS without dependencies.

| File | Content |
|---|---|
| `js/hid.js` | WebHID transport and Vial/VIA protocol (definition, keymap, unlock, matrix) |
| `js/xz.js` | XZ/LZMA2 decoder for the compressed Vial definition |
| `js/kle.js` | KLE parser and key placement as in vial-gui (incl. layout options/modules) |
| `js/keycodes.js` | QMK keycodes: decoding, labels, host layouts |
| `js/state.js` | firmware state replayed from the matrix; locked-mode snapshot; DOM modifiers |
| `js/lookup.js` | character → key/layer/modifiers (hints, preferences), DOM code → key |
| `js/keyboard-view.js` | SVG keyboard |
| `js/typing.js`, `js/words.js` | typing test and word lists |
| `js/hands.js` | finger assignment from the geometry and hands view |
| `js/main.js` | standalone trainer |
| `monkeytype/overlay.js`, `overlay.css` | the monkeytype extension |
| `tools/build-monkeytype.mjs` | bundles the extension, the userscript and the zip in `dist/` |
| `tools/mt-fixture.html` | copy of monkeytype's test DOM for local testing |

```bash
node tools/test-app.mjs          # protocol against simulated Vial/VIA firmware, layout, state model, labels
node tools/test-xz.mjs           # XZ decoder against Python's lzma
node tools/build-monkeytype.mjs  # build extension, userscript and dist/*.zip
node tools/make-icons.mjs        # redraw the icons
```

Feature requests and known issues: [BACKLOG.md](BACKLOG.md).

## License

GPL-3.0-or-later, see [LICENSE](LICENSE). The keyboard's look and behavior follow monkeytype's keymap
([monkeytypegame/monkeytype](https://github.com/monkeytypegame/monkeytype), GPL-3.0): `sub-alt` keys and `sub`
legends, next key in the main color, 250 ms hit/miss flash, homing bars on the index keys.
The Halcyon Kyria files in `tools/fixtures/` come from [splitkb/qmk_userspace](https://github.com/splitkb/qmk_userspace)
(branch `halcyon`, GPL-2.0-or-later).
