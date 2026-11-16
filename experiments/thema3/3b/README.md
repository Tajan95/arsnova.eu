# 3B: reproduzierbares Mehrveranstaltungsmodell

Dieses Experiment simuliert Konkurrenz **an einem gemeinsamen Client-/Inferenzslot**.
Es startet weder ARSnova noch ein Modell und ist keine Messung von 5.000 Clients.
Die Bezugsbasis ist `v1.3.0`, Commit
`87c39334619fbcb0c5782b061da1ba0df0ba3142`. Die Anwendung bleibt unverändert.

## Durchführung

Nur Python 3 mit Standardbibliothek ist erforderlich. Aus dem Repository-Root:

```bash
python3 -m unittest discover -s experiments/thema3/3b -v
python3 experiments/thema3/3b/simulate.py --illustrative --out /tmp/thema3-illustration
python3 experiments/thema3/3b/simulate.py --calibration /pfad/calibration.json --out /tmp/thema3-calibrated
```

Der erste Simulationslauf nutzt **frei erfundene Beispielzeiten** von 2/12/30 Sekunden
für Label/Summary/Lernziel. Sein Evidenzstatus lautet ausdrücklich
`UNCALIBRATED_ILLUSTRATION_NOT_CAPACITY_EVIDENCE`. Er dient der Funktionskontrolle und
Erklärung des Modells, nicht als Kapazitätsnachweis. Ein kalibrierter Lauf akzeptiert
stattdessen tatsächliche Messproben aller drei Auftragstypen.

## Kalibrierung

Die JSON-Datei enthält diese Felder:

| Feld                          | Inhalt                                                        |
| ----------------------------- | ------------------------------------------------------------- |
| `schema_version`              | Zahl `1`                                                      |
| `evidence`                    | `real_private_runtime`; nur nach echten privaten Modellläufen |
| `baseline_commit`             | Vollständiger oben genannter Commit                           |
| `environment_manifest`        | Pfad oder Referenz auf die tatsächlich verwendete Umgebung    |
| `samples.topic_label`         | Nicht leere Liste gemessener Labelaufrufe                     |
| `samples.qa_summary`          | Nicht leere Liste gemessener Summaryaufrufe                   |
| `samples.learning_objectives` | Nicht leere Liste gemessener Lernzielaufrufe                  |

Jede Probe enthält positive endliche `duration_ms` und ein boolesches `success`.
Optional können `input_tokens`, `output_tokens`, Fixture- und Laufkennungen ergänzt
werden. Fehlgeschlagene oder abgebrochene Modellaufträge bleiben mit ihrer
tatsächlich belegten Zeit und `success: false` enthalten. Sofortige Busy-Abweisungen
sind **keine Dienstzeitproben**. Proben werden mit Zurücklegen gezogen. Wenige Proben
bilden keine belastbare Verteilung; ein einzelner Wert pro Typ ist nur eine grobe
Kalibrierung. Der Simulator kann Herkunftsangaben prüfen, aber nicht deren Wahrheit
automatisch beweisen. Rohprotokolle müssen mitgeliefert werden.

Bei HTTP-Abbruch muss die Messung zeigen, wann die Runtime wieder verfügbar ist.
Nur die kurze Dauer bis zur Abbruchantwort als Slotbelegung einzusetzen, wäre falsch,
wenn der Modellserver danach noch weiterrechnet. Ebenfalls dürfen lange Summary-
Clientläufe nicht als erfolgreicher App-Pfad ausgegeben werden: Der unveränderte
äußere Summary-Prozessortimer beträgt im Tag standardmäßig 8 Sekunden.

## Lastmodell und Gegenalternative

Standardmäßig werden 100 Veranstaltungen mit rechnerisch je 50 Teilnehmenden
betrachtet. Jede Veranstaltung löst **eine Host-Aktion je 120 Sekunden** aus; in
30 Minuten entstehen damit insgesamt 1.500 Aktionen. Die Gewichtung beträgt
45 % Label, 45 % Summary und 10 % Lernziel. Diese Ankunfts- und Mischannahmen sind
auch bei gemessenen Dienstzeiten **eigene Modellannahmen**, keine beobachtete Nutzung.

Sechs Fälle verwenden dieselben Dienstzeitproben und denselben Seed `20261116`:

1. Gleichmäßig versetzte periodische Host-Aktionen: sofortige Abweisung oder FIFO.
2. Synchronisierte Unterrichtswellen mit zufälliger Reihenfolge bei Gleichstand:
   sofortige Abweisung oder FIFO.
3. Synchronisierte Wellen mit dauerhaft gleicher Reihenfolge: sofortige Abweisung
   oder FIFO. Dieser bewusst ungünstige Fall macht mögliche Benachteiligung sichtbar.

`reject` bildet die Regel „belegter Slot → sofort zurückweisen“ abstrakt ab.
`fifo` ist eine **globale Laborgegenalternative mit acht Plätzen einschließlich
des laufenden Auftrags**. Sie ist ausdrücklich nicht die bestehende Summary-Queue
und keine erlaubte Änderung der geltenden Runtimevorgabe. Es gibt keine Präemption.
Ein abgeschlossenes Ereignis wird vor einer genau gleichzeitig eintreffenden
Anfrage verarbeitet. Vor dem Ende des Ankunftsfensters angenommene Arbeit wird
zu Ende simuliert; Erfolge innerhalb des Fensters und nach dem Leerlaufen werden
getrennt ausgewiesen.

Parameter: `--seed`, `--sessions`, `--horizon-s`, `--period-s`, `--cooldown-s`,
`--cache-probability` und optional `--hourly-cost-eur`. Ein Cooldown bezieht sich
im Modell auf die zuletzt angenommene Aktion je Host und ist eine alternative
Zulassungsregel, nicht die Behauptung einer globalen ARSnova-Konfiguration.
Ein Cachetreffer setzt ein vorheriges erfolgreiches Ergebnis desselben Typs und
derselben Veranstaltung voraus. Seine Wahrscheinlichkeit ist eine ausdrückliche
Annahme für gültige Wiederverwendung; tatsächliche Hash-/TTL-/Quellenregeln werden
hier nicht ausgeführt. Der Default ist null. Kosten bleiben ohne explizite Eingabe
leer; eingegebene Kosten umfassen Leerlauf und das Leeren der Warteschlange.
Zusätzlich wird immer der preisfreie Faktor `modeled_hours_per_success` berechnet:
beobachtete Modellzeit einschließlich Leerlauf/Nachlauf in Stunden geteilt durch
erfolgreiche Modelljobs. Erst die Multiplikation mit einem tatsächlich belegten
Stundenpreis ergibt Kosten je erfolgreichem Job. Bei null Erfolgen bleibt der
Faktor undefiniert (`null`).

`calibration_statistics` nennt pro Typ Probenzahl, mittlere Belegungszeit und
beobachteten Erfolgsanteil. Für die angenommene Mischung ist
`E[S] = 0,45 × S_Label + 0,45 × S_Summary + 0,10 × S_Lernziel`.
Die angebotene Last ist `rho = (Veranstaltungen / Aktionsperiode) × E[S]`.
`60 / E[S]` Jobs pro Minute ist nur ein arithmetischer Sättigungsrichtwert eines
ständig belegten Slots für diesen Mix. Mit dem gewichteten Erfolgsanteil
multipliziert ergibt sich ein Richtwert brauchbarer Antworten. Auch fehlgeschlagene
Modellläufe belegen den Slot; sie dürfen aus dem Nenner nicht entfernt werden.
Diese Rechnung ist keine gemessene Durchsatz- oder Produktionskapazität.

## Ergebnisse und Bedeutung

`summary.json` enthält Annahmen, Kalibrierungsreferenz und Kennzahlen.
`comparison.csv` vergleicht die sechs Fälle; weitere CSV-Dateien enthalten jeden
Auftrag sowie Werte je Veranstaltung. Erfasst werden erfolgreiche Modelljobs,
Fehler, Busy-/Cooldown-Abweisungen, Cachetreffer, Slotbelegung, Wartezeit, Antwortzeit,
Veranstaltungen ohne Modell-Erfolg und der Jain-Index der Erfolgsverteilung.

Das Analysealter ist hier die Zeit vom Snapshot bei Ankunft bis zur Antwort.
Eine Warteschlange erhöht dieses Alter. Bei Cachewiederverwendung wird der ursprüngliche
Snapshotzeitpunkt beibehalten. Zusätzlich wird pro Veranstaltung das Alter des
letzten erfolgreich gelieferten Summary-Snapshots am Ende des Ankunftsfensters
ausgegeben; fehlt ein Summary-Ergebnis, steht dort `null` statt einer erfundenen Null.

Die Simulation führt keine echte Summary-App-Queue, Autorisierung, Datenbank,
Kontextvorbereitung, Quellen-Revalidierung, 8.9b-Klassifikation, Netzwerkverteilung
oder Circuit-Breaker-Logik aus. Sie simuliert keine automatischen Retries und fügt
keine zusätzlichen Deadlines hinzu. Ein begrenzter Vergleich gegen reale
Laboranfragen bleibt für die Validierung des Modells notwendig.

**Zulässige Entscheidung:** Bedingungen benennen, unter denen sofortige Abweisung
oder eine begrenzte Warteschlange Frische und Verteilung verschlechtert oder verbessert.
**Unzulässige Schlussfolgerung:** Aus diesem Modell eine nachgewiesene Produktions-
kapazität von 100 Veranstaltungen bzw. 5.000 Teilnehmenden ableiten.
