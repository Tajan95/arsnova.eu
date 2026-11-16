# 3A: Slotzulassung, Konkurrenz und Abbruch

Basis: `v1.3.0`, Commit `87c39334619fbcb0c5782b061da1ba0df0ba3142`.
Die Anwendung wird nicht geändert. Untersucht wird der originale
`openWeightLlmClient.ts`, einschließlich echter Node-HTTP-Übertragung,
Zod-Validierung und Summary-V2-Vertrag.

## Abgrenzung

`build.mjs` bündelt die Releasequellen mit ihren installierten Abhängigkeiten.
Zwei ausdrücklich benannte Modulgrenzen werden isoliert: Registrierung der
Session-Purge-Callbacks und DB-basierte Kontextbeschaffung. Keine davon wird
in diesen Szenarien aufgerufen. Der Summary-Kontext wird aus synthetischen
Analyse-Daten durch die originale Funktion
`prepareModerationSummaryContextFromAnalysis` vorbereitet. Client,
Admission-Zustand, HTTP-Transport und Schemaprüfung bleiben unverändert.

Dies ist keine vollständige App-/Datenbank-/UI-Prüfung. Der historische
Label-Consumer fehlt in diesem Release weiterhin. Summary V2 gibt bei
Belegung `busy` zurück; erst die App-Queue entscheidet über ihren sichtbaren
Fallback. Die Queue wird hier nicht ausgeführt. Für Labels wird der vorhandene
Live-Wrapper mit deterministischem Fallback geprüft; Lernzielableitung liefert
bei Belegung `busy` mit manueller Wiederholung.

## Ausführung

Aus dem Repositorywurzelverzeichnis mit installierten Abhängigkeiten:

```bash
node experiments/thema3/3a/build.mjs
node experiments/thema3/.build/run-controlled.mjs ../referat-results/3a
```

Der kontrollierte Testserver hört ausschließlich auf einer zufälligen
Loopback-Portnummer. Er liefert synthetische JSON-Antworten und simuliert
Bearbeitungszeit. Das ist **keine Modellmessung**. Der Client verwendet echte
HTTP-Anfragen; der Server protokolliert separat Beginn, Ende und Abbruch
seiner laufenden Arbeiten.

39 kontrollierte Fälle:

- Sechs geordnete Paarungen, jeweils drei Wiederholungen: 18 Fälle.
- Dreifachkonkurrenz mit jedem Auftrag zuerst, jeweils drei Wiederholungen:
  neun Fälle.
- Abbruch und Timeout für alle drei Typen mit anschließendem erfolgreichen
  Wiederverwenden: sechs Fälle.
- Server arbeitet trotz HTTP-Abbruch zunächst weiter; Remote-Slotprüfung
  weist den sofortigen Retry ab: drei Fälle.
- Zwei getrennte Node-Prozesse erhalten gleichzeitig eine positive
  Slot-Vorabprüfung: drei kontrollierte Gegenbeispiele zur atomaren
  prozessübergreifenden Reservierung.

Der letzte Servermodus erlaubt absichtlich zwei aktive HTTP-Arbeiten. Das
beweist, dass der Client zwei POSTs zulassen kann; es behauptet nicht, dass
`llama-server --parallel 1` zwei Modellberechnungen gleichzeitig ausführt.
Eine nachgelagerte Runtime-Warteschlange bleibt gesondert zu untersuchen.

## Reale private Runtime

Voraussetzung ist die tatsächlich laufende, isolierte Release-Runtime mit
geprüftem Modell. Zugangsdaten werden ausschließlich über die Umgebung
übergeben. Sie werden nicht in Ergebnisse geschrieben.

```bash
export OPEN_WEIGHT_LLM_ENABLED=true
export OPEN_WEIGHT_LLM_URL=http://127.0.0.1:18080
# OPEN_WEIGHT_LLM_TOKEN sicher aus eigener lokaler Konfiguration übernehmen.
export REFERAT_REPETITIONS=3
node experiments/thema3/.build/run-real.mjs ../referat-results/real
```

Alternativ zur URL ist `OPEN_WEIGHT_LLM_SOCKET_PATH` vorgesehen; beide
Transportoptionen dürfen nicht zugleich gesetzt werden. Mit
`REFERAT_SUMMARY_REQUEST_FILE` kann eine zuvor schemageprüfte V2-Datei aus
3C als identischer Kontextanker verwendet werden.

Der Runner erhebt einen separat markierten Aufwärmlauf je Typ, danach drei
Baseline-Wiederholungen je Typ, drei reale Dreifachkonkurrenzen und je einen
Caller-Abbruch mit anschließendem echten Label-Auftrag als Wiederverwendungsprobe.
Die originalen Clientgrenzen bleiben standardmäßig bei
30/90/120 Sekunden für Label/Summary/Lernziel. Der Summary-Caller-Abbruch
nach acht Sekunden ist eine ausdrücklich bezeichnete Testvariante entsprechend
dem äußeren Queuebudget; er ist kein ausgeführter Test der App-Queue.

Eine lokale HTTP-Weiterleitung zeichnet `usage`, `timings`, `finish_reason`
und die vollständige synthetische Modellantwort des echten Servers auf und
leitet den Client-Abbruch weiter. JSON-, Schema- und Referenzfehler werden
zusätzlich dokumentiert. Separate `/slots`-Abfragen ohne Fail-Flag beobachten
die Anzahl der als `is_processing` gemeldeten Slots ungefähr alle 100 ms. Ereignisse zwischen Abfragen
können damit nicht ausgeschlossen werden. Für Abbruchfälle wird festgehalten,
ob zuvor tatsächlich ein belegter Slot beobachtet wurde.

Für eine Kontrolle ohne HTTP-Weiterleitung lässt sich
`REFERAT_DIRECT_TRANSPORT=true` setzen. Dann spricht der unveränderte
Client direkt mit der Runtime; Token-/Antwortdiagnostik der Weiterleitung
entfällt, das unabhängige Slot-Monitoring bleibt aktiv. Dies hilft,
beobachtete verzögerte Freigaben nicht vorschnell der Runtime oder dem
Client zuzuschreiben, solange ein Einfluss der Weiterleitung offen ist.

Gezielte Folgeläufe sind mit `REFERAT_TASKS=qa_summary` und
`REFERAT_PHASES=baseline` möglich. Standardphasen sind
`warmup,baseline,concurrency,abort`; standardmäßig laufen alle drei Typen.
Jeder Folgelauf benötigt ein eigenes Ausgabeverzeichnis, damit ursprüngliche
Messungen erhalten bleiben.

`calibration.json` übernimmt ausschließlich reale Baseline-Beobachtungen;
Aufwärmläufe, Sofortabweisungen und kontrollierte HTTP-Tests werden nicht
als Modellleistung verwendet. Die Dienstzeit ist der konservative Zeitraum
vom Clientstart bis zur ersten bestätigten freien Slotantwort nach dem
Clientergebnis. Die reine Clientlaufzeit bleibt zusätzlich erhalten. Das
verhindert, dass ein frühes Client-Timeout als bereits frei gewordene
Runtimekapazität behandelt wird. Der zusätzliche Beobachtungs-/HTTPaufwand
ist keine reine GPU-/CPU-Rechenzeit.

Die pro Sample gespeicherten KV-Cachezahlen sind ebenfalls zu beachten.
Die erste Messreihe mit wiederholten festen Eingaben traf im Runtimecache
145 von 146 Label-, 792 von 793 Summary- und 309 von 310 Lernziel-Eingabetokens;
jeweils nur ein Prompttoken wurde neu verarbeitet. Das sind Messungen mit
weitgehend vorgewärmtem Runtimecache, keine Kapazitätsmessung für beliebig
wechselnde neue Kontexte. Ein in einer Simulation ausgeschalteter
Anwendungs-Ergebniscache deaktiviert diesen Runtime-KV-Cache nicht.
Anwendungs-Packingcache, Anwendungs-Ergebniswiederverwendung und
Runtime-KV-Wiederverwendung müssen getrennt bleiben.

Rohdaten: `controlled-results.json`, `controlled-matrix.csv` beziehungsweise
`real-results.json`, `synthetic-requests.json` und `calibration.json`.
Ergebnisse und Zugangsdaten gehören nicht in den Git-Commit.

Die erste echte Messreihe wurde vor der Ergänzung der Rohantwortdiagnostik
ausgeführt: Dort wurden zunächst nur `usage`/`timings` und der
Belegt-Status über `/slots?fail_on_no_slot=1` aufgezeichnet. Gezielte,
getrennt gespeicherte Folgeläufe liefern Rohantwortdiagnostik,
`is_processing`-Zählung und erfolgreiche Wiederverwendungsproben. Diese
Unterschiede dürfen beim Zusammenfassen nicht rückwirkend verschwinden.
