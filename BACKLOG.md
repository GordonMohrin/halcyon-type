# Backlog

Feature-Wünsche (FR) und Bugs für Split Keyboard for monkeytype. Neueste oben in jeder Liste.

## Offen

### Bugs
- (keine bekannten)

### Feature-Wünsche
- [ ] **Store-Release vorbereiten**: Texte auf Englisch (Deutsch als Übersetzung), Erklärung beim ersten Start
  (Entsperren gilt bis zum Abstecken, Vial-App dabei schließen), Datenschutzerklärung (alles bleibt lokal),
  Store-Eintrag mit Screenshots 1280×800, Test in frischem Chrome-Profil, Repo und Dateinamen auf den neuen Namen
  umstellen. Danach Chrome Web Store (Konto: Gordon) und Edge Add-ons.
- [ ] **Weitere Tastaturen**: Vial hat Vorrang und läuft. VIA-Tastaturen wären möglich (Keymap lesbar, Matrix ohne
  Entsperren), es fehlt aber die Layout-Beschreibung: aus VIAs öffentlicher Sammlung oder als Datei vom Nutzer.
- [ ] **Keymap merken**: gelesene Keymap speichern und sofort aus dem Speicher zeigen, mit Hinweis
  „aus dem Speicher – zum Aktualisieren verbinden“, z. B. wenn die Tastatur gerade in einem anderen Tab hängt.
  Hinweis: Lesen der Layer braucht kein Entsperren.
- [ ] **Bevorzugte Tasten in der eigenständigen App**: Lernen und Nutzen gibt es bisher nur im monkeytype-Overlay.

### Tests
- [ ] Elora live: „!“ über die Layer-2-Taste lernen (nach dem Fix für eingebaute Modifier), Menü „Vergessen“.
- [ ] Zweite Tastatur testen.
- [ ] Systemlayout „Automatisch“ erkennt auf Gordons Windows „US“: prüfen, ob das stimmt.

## Grenzen (nicht lösbar ohne Firmware-Änderung)
- Gesperrt sieht die App reine Layer-Tasten (MO, LT …) nicht, weil sie dem PC nichts schicken. Ein Layer erscheint
  erst mit der ersten Taste, die darauf tippt. Für die Anzeige schon beim Halten einmal entsperren (gilt bis zum
  Abstecken). Eine Firmware-Erweiterung wurde ausprobiert und wieder verworfen: Nutzer sollen nichts flashen müssen.

## Erledigt
- [x] Bug: Lernen ignorierte Tasten mit eingebautem Shift (z. B. `S(KC_1)` = „!“ auf Layer 2).
- [x] Bug: Lernen hing an Tastenereignissen der Seite und tat nichts, wenn ein anderes Fenster den Fokus hatte.
  Jetzt direkt aus der Matrix.
- [x] Bug: Neu geladen während eines laufenden Entsperrens → leere Keymap (0 Layer). Jetzt wird das Entsperren
  zuerst abgeschlossen.
- [x] Test Elora live: gesperrt (Layer 2 für „!“ über Vorliebe, „1“ auf der Basis), Modifier-Leiste ohne
  Überlappung, entsperrt „3 über Layer 1“ gelernt und als Hinweis gezeigt.
- [x] 0.2.0 – FR: Name „Split Keyboard for monkeytype“, Icons, Store-ZIP in `dist/`.
- [x] 0.2.0 – FR: Liegt ein Zeichen auf mehreren Tasten, merkt sich die App den zuletzt benutzten Weg und zeigt ihn.
  Gesperrt wählt sie die Taste über diese Vorliebe und das erwartete Zeichen.
- [x] 0.2.0 – Bug: In der Layer-/Modifier-Leiste lagen Strg, Alt, Win und Shift übereinander.
- [x] 0.2.0 – FR: Funktioniert ohne Firmware-Änderung (Layer-Meldung aus Fork und App entfernt).
- [x] 0.1.x – Build, Tests und Starter für Windows.
