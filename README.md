# Halcyon Type

Ein Tipptrainer im Stil von monkeytype mit Live-Tastatur für Vial-Tastaturen – gebaut für die
splitkb **Halcyon**-Reihe (Kyria, Corne, Lily58, Elora, Ferris, Sofle), funktioniert aber mit jeder Vial-Firmware.

Die App liest Layout, Keymap, Layout-Optionen (Halcyon-Module), Encoder, Tap-Dances und den Tapping Term
direkt aus der Tastatur. Sie zeigt live jede gedrückte Taste, den aktiven Layer und alle Modifier,
auch wenn sie per Mod-Tap, One-Shot oder Layer-Taste kommen.

## Starten

```bash
python3 tools/serve.py
```

Dann <http://localhost:8137> in **Chrome, Edge, Brave oder Arc** öffnen. Safari und Firefox können kein WebHID.
Ohne Tastatur zum Ausprobieren: <http://localhost:8137/?demo> (Halcyon Kyria mit splitkbs Standard-Keymap).

## Bedienung

1. **Tastatur verbinden** → im Browser-Dialog die Halcyon auswählen. Danach verbindet die App sich beim
   nächsten Öffnen automatisch, auch nach dem Ab- und Anstecken.
2. **Entsperren**: Vial gibt die Schalter-Matrix erst nach einem Unlock heraus (Schutz gegen Keylogger).
   Die App zeigt, welche Tasten du halten musst (bei der Halcyon Kyria ab Werk **T + Y**), und füllt einen
   Balken (ca. 6 s). Das Entsperren gilt bis zum Abstecken der Tastatur.
   - **Live-Modus** (entsperrt): Jede physische Taste wird angezeigt, auch Layer-Tasten, Mod-Taps und
     One-Shots. Das funktioniert auch, wenn das Fenster im Hintergrund ist.
   - **Fokus-Modus** (gesperrt): Die App sieht nur, was als Tastendruck im fokussierten Fenster ankommt.
3. **Tippen**: Zeit oder Wörter, Deutsch/English, Satzzeichen, Zahlen und **Code** (Klammern und Operatoren,
   ideal zum Üben des Symbol-Layers). <kbd>Tab</kbd> startet einen neuen Test.
4. **Nächste Taste**: Die Tastatur markiert, wo das nächste Zeichen liegt. Muss dafür ein Layer gehalten
   werden oder ⇧ bzw. ⌥ dazu, werden diese Tasten gestrichelt mitmarkiert.
5. Nach dem Test: WPM, Genauigkeit, Raw, Konstanz, Verlauf und eine **Fehler-Heatmap** auf deiner Tastatur.

### Mit monkeytype zusammen

**Schwebendes Fenster** öffnet die Tastatur als immer-oben-Fenster (Document Picture-in-Picture).
Leg es über oder neben monkeytype.com: Im Live-Modus zeigt es deine Tasten, Layer und Modifier, während du
dort tippst. In monkeytype selbst wird dafür nichts installiert oder eingeschleust.
Ohne Picture-in-Picture: <http://localhost:8137/?view=keyboard> in einem eigenen Fenster öffnen.

### Einstellungen (⚙)

- **Tastaturlayout im System**: automatisch erkannt. Wählbar sind Deutsch (Mac), Deutsch (Windows/Linux) und US.
  Davon hängen die Beschriftungen ab (KC_Y wird zu „Z“, KC_SCLN zu „Ö“ …) und welche Taste ein Zeichen tippt.
- **Basis-Layer**: falls du per DF() z. B. auf Colemak umgeschaltet hast. DF-Tasten erkennt die App selbst.
- Layer-Chips: **Klick** hält einen Layer zur Ansicht fest, **Doppelklick** benennt ihn um.
- **Tastatur wieder sperren**: Vial-Unlock zurücknehmen.

## Grenzen

- Die App bildet QMKs Logik für Layer, Mod-Tap und Layer-Tap (Tapping Term, Permissive Hold,
  Hold on Other Key Press), One-Shot, Tri-Layer, TG/TO/DF/TT und Caps Word auf dem Rechner nach,
  denn die Firmware meldet ihren Layer-Zustand nicht. Combos, Key Overrides, Auto Shift und
  Doppel-Tap bei Tap Dance sind nicht nachgebildet.
- Vial-Protokoll ≥ 6 (QMK-Keycodes ab 2022) ist vorausgesetzt. Die Halcyon-Firmware erfüllt das.
- Die Vial-App und diese App sollten nicht gleichzeitig mit der Tastatur sprechen. Zwei Fenster dieser
  App übergeben sich die Tastatur gegenseitig.
- Sicherheit: Solange die Tastatur entsperrt ist, kann jedes Programm mit HID-Zugriff die Matrix lesen.
  Nach dem Abstecken ist sie wieder gesperrt.

## Entwicklung

Reines HTML/CSS/JS ohne Build-Schritt und ohne Abhängigkeiten. Code und Bezeichner sind englisch.

| Datei | Inhalt |
|---|---|
| `js/hid.js` | WebHID-Transport und Vial/VIA-Protokoll (Definition, Keymap, Unlock, Matrix) |
| `js/xz.js` | XZ/LZMA2-Decoder für die komprimierte Vial-Definition |
| `js/kle.js` | KLE-Parser und Platzierung wie in vial-gui (inkl. Layout-Optionen/Module) |
| `js/keycodes.js` | QMK-Keycodes: Dekodierung, Beschriftung, Systemlayouts US/DE |
| `js/state.js` | Nachbildung des Firmware-Zustands aus der Matrix; DOM-Modifier |
| `js/lookup.js` | Zeichen → Taste/Layer/Modifier (Hinweise, Heatmap), DOM-Code → Taste |
| `js/keyboard-view.js` | SVG-Tastatur |
| `js/typing.js`, `js/words.js` | Tipptest und Wortlisten |
| `js/main.js` | Verbindung, Entsperren, Polling, UI |

Tests (Node ≥ 20, Python 3 für die Testdaten):

```bash
node tools/test-app.mjs   # Protokoll gegen simulierte Vial-Firmware, Layout, Zustandsmodell, Labels
node tools/test-xz.mjs    # XZ-Decoder gegen Pythons lzma
node tools/build-demo.mjs # demo/halcyon-kyria.json neu erzeugen
```

Die Halcyon-Kyria-Dateien in `tools/fixtures/` stammen aus
[splitkb/qmk_userspace](https://github.com/splitkb/qmk_userspace) (Branch `halcyon`, GPL-2.0-or-later).
