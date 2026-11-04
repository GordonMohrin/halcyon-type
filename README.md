# Halcyon Type

Live-Anzeige deiner Vial-Tastatur für **monkeytype.com**, gebaut für die splitkb **Halcyon**-Reihe
(Kyria, Corne, Lily58, Elora, Ferris, Sofle). Funktioniert mit jeder Vial-Firmware.

Du tippst ganz normal im echten monkeytype mit deinem Account, Ergebnisse und Bestleistungen landen wie immer dort.
Unter den Wörtern erscheint deine eigene Tastatur samt Keymap, Layern und Modifiern, direkt aus der Firmware gelesen:

- jede gedrückte Taste live, auch Layer-, Mod-Tap- und One-Shot-Tasten
- der aktive Layer schaltet die Beschriftung um; bei gehaltenem Shift oder Option zeigen die Tasten, was sie gerade tippen
- die **nächste Taste** ist in monkeytypes Hauptfarbe umrandet; Layer- und Shift-Tasten, die dafür nötig sind, gestrichelt
- **Hände** darunter mit dem Finger, der die nächste Taste drücken sollte
- kurzes Aufblinken nach jedem Anschlag (richtig/falsch) wie bei monkeytypes eigener Keymap
- Farben und Schrift kommen aus deinem monkeytype-Theme

## In monkeytype installieren

**Variante A – Chrome-Erweiterung** (empfohlen)
1. `chrome://extensions` öffnen und oben rechts den **Entwicklermodus** einschalten.
2. **Entpackte Erweiterung laden** und den Ordner `monkeytype/extension` aus diesem Repo wählen.
3. monkeytype.com neu laden. Unten rechts erscheint **⌨ Halcyon**: anklicken, **Tastatur verbinden**, die Halcyon wählen.
4. **Entsperren**: Die App zeigt die Tasten, die du halten musst (Halcyon Kyria ab Werk **T + Y**, ca. 6 s).
   Solange blockiert sie die Eingabe in monkeytype, damit nichts im Test landet.

**Variante B – Userscript**: `monkeytype/halcyon-monkeytype.user.js` in Tampermonkey oder Violentmonkey installieren.

Ab dann verbindet sich die Tastatur beim Öffnen von monkeytype automatisch. Das Entsperren gilt bis zum Abstecken.
Im Menü **⌨ Halcyon** stellst du außerdem ein:
- Systemlayout (Deutsch Mac/Windows, US)
- Basis-Layer
- Hände, Hinweise und Layer-Leiste an oder aus
- Encoder und Module zeigen
- monkeytypes eigene Keymap ausblenden
- Größe

Nach Änderungen am Code: `node tools/build-monkeytype.mjs`, dann unter `chrome://extensions` die Erweiterung neu laden.

## Lizenz

GPL-3.0-or-later, siehe [LICENSE](LICENSE). Aussehen und Verhalten der Tastatur sind an monkeytypes Keymap angelehnt
([monkeytypegame/monkeytype](https://github.com/monkeytypegame/monkeytype), GPL-3.0):
- `sub-alt`-Tasten und `sub`-Beschriftung
- nächste Taste in der Hauptfarbe
- 250 ms Treffer-/Fehler-Blinken
- Homing-Striche auf den Zeigefinger-Tasten

## Eigenständige Version (ohne monkeytype)

Zusätzlich gibt es einen eigenen Tipptrainer mit derselben Tastatur-Anzeige (Fehler-Heatmap, Code-Modus,
schwebendes Fenster).

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
| `js/hands.js` | Finger-Zuordnung aus der Geometrie und Hände-Anzeige |
| `js/main.js` | eigenständige App: Verbindung, Entsperren, Polling, UI |
| `monkeytype/overlay.js`, `overlay.css` | Overlay für monkeytype.com |
| `tools/build-monkeytype.mjs` | bündelt das Overlay zu Erweiterung und Userscript |
| `tools/mt-fixture.html` | Nachbildung von monkeytypes Test-DOM zum lokalen Testen |

Tests (Node ≥ 20, Python 3 für die Testdaten):

```bash
node tools/test-app.mjs   # Protokoll gegen simulierte Vial-Firmware, Layout, Zustandsmodell, Labels
node tools/test-xz.mjs    # XZ-Decoder gegen Pythons lzma
node tools/build-demo.mjs # demo/halcyon-kyria.json neu erzeugen
node tools/build-monkeytype.mjs  # Erweiterung + Userscript bauen
```

Die Halcyon-Kyria-Dateien in `tools/fixtures/` stammen aus
[splitkb/qmk_userspace](https://github.com/splitkb/qmk_userspace) (Branch `halcyon`, GPL-2.0-or-later).
