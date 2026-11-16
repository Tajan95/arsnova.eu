# 3C: Kontextauswahl und Packingcache am Release 1.3.0

## Zweck und unveränderte Basis

Basis: `87c39334619fbcb0c5782b061da1ba0df0ba3142` (`v1.3.0`). Der Versuch
führt die **unveränderten** Exporte aus `moderationPromptContextPacking.ts`
und `moderationSummaryContext.ts` sowie die echten Shared-Zod-Schemas aus.
Er verändert keine Anwendungskonfiguration und implementiert keine neue
Produktfunktion. Vor jedem Lauf wird geprüft, dass Backend- und Shared-Code
gegenüber dem Baseline-Commit unverändert sind.

Der eigene Testtreiber liefert synthetische Analysekontexte. Der Import-Hook
in `loader.mjs` ersetzt ausschließlich die Datenbeschaffung durch
`buildModerationPromptContext` sowie die Registrierung des Purge-Callbacks.
Die Datenbank, Host-Authentisierung, Redis-Purge-Verteilung und die Erzeugung
von Themen/Kompassaggregaten werden damit **nicht** getestet. Die Datensätze
werden durch die Originalschemas geprüft; die Freigabe des Hosts wird durch
das synthetische Eingabeobjekt vorausgesetzt, nicht nachgewiesen.

## Ausführung

Voraussetzungen: Node 24 mit `registerHooks`/`stripTypeScriptTypes` sowie die
Abhängigkeiten des separaten Versuchspakets (insbesondere echtes `zod`).
Die zentralen Setup-Schritte des Versuchspakets verwenden die Versionen des
Release-Lockfiles. Kein `npm install` der vollständigen Anwendung ist nötig.

Im Repositoryverzeichnis:

```bash
node --import ./experiments/thema3/3c/loader.mjs \
  ./experiments/thema3/3c/run.mjs \
  /ABSOLUTER/PFAD/ZU/ERGEBNISSEN/3c
```

Das letzte Argument bezeichnet das Ergebnisverzeichnis. Es sollte außerhalb
des Repositorys liegen. Laufzeitdaten werden nicht committed. Die Anwendung
benötigt für diesen Komponententest keine Datenbank und keinen Modellserver.

## Versuchsdesign

1. **Sechs-Fragen-Anker:** Die originale Fixture mit den Themenpaaren
   Regressionsbeispiele, Prüfungsrelevanz und Anwesenheit wird unverändert
   durch die Summary-Vorbereitung geschickt. Der direkte reichhaltige
   Packingversuch und der reale Q&A-Fallback werden unterschieden.
2. **Begrenzte Kandidaten:** Die modellierten Forumgrößen sind 6, 50, 500,
   5.000 und 25.000 Beiträge. Tatsächlich in den Kandidatengraphen gelangen
   maximal 40 oder 200 synthetische, nicht identische Fragen. Die 5.000
   Teilnehmenden sind eine Bezugsgröße im Kontext. Es werden weder 5.000
   Browser verbunden noch 25.000 Datenbankzeilen gelesen. Der Vergleich
   40/200 ist eine ausdrücklich bezeichnete Vorselektionsvariante des
   Versuchs, kein vorhandener Schalter `QA_SUMMARY_MAX_SOURCES` für den
   produktiven V2-Pfad.
3. **Konstantes Budget:** Alle Zellen verwenden exakt das Releaseprofil
   mit 4.096 Kontexttokens, 640 Ausgabereserve und 128 Sicherheitsreserve.
   Der Input-Grenzwert ist damit 3.328 konservativ geschätzte Einheiten
   einschließlich Instruktionen, Definitionen und serialisiertem Kontext.
   Der verwendete UTF-8-Byte-Zähler ist **kein Modelltokenizer**.
4. **Vorbereitungskosten:** Je Zelle drei Aufwärmläufe und 15 gemessene
   Ausführungen des originalen `prepareModerationSummaryContextFromAnalysis`.
   Erfasst wird die lokale CPU-Wandzeit einschließlich Schema-/Packingarbeit,
   ohne Datenbankbeschaffung, HTTP, Modell-Prefill oder Generierung.
5. **Cachevergleich:** 40/200 Kandidaten und 5/30 Sekunden TTL werden
   faktoriell verglichen. Die reale Klasse `ModerationPromptPackingCache`
   erhält eine kontrollierte virtuelle Uhr und 61 Zugriffe in simulierten
   Sekunden 0–60. Revisionsänderungen erfolgen nie, alle fünf oder alle
   20 Sekunden. Die 5-s-TTL ist eine Laborgegenvariante über den vorhandenen
   Konstruktor, kein behaupteter Deployment-Schalter. Die Aufruffrequenz von
   1 Hz untersucht den Cache isoliert und ersetzt nicht den Host-Cooldown
   oder eine gemessene Veranstaltungs-Lastverteilung.
6. **Semantische Änderungen:** Unveränderter Snapshot, reine
   Stimmenänderung samt Neuberechnung der individuellen Scores und
   Stimmenrevision, Bestätigungszeitstempel eines Lernziels sowie Wechsel
   von Entwurf zu bestätigt. Die übrigen Themen-/Kompassaggregate bleiben
   für diesen isolierten Invalidierungstest fest; ihr Neuaufbau wird nicht
   untersucht.
7. **Text-/Metadatensensitivität:** Bei 25.000 modellierten Beiträgen und
   200 Kandidaten werden 20, 80, 200 und 500 Zeichen pro Text bei vorhandenem
   bzw. ausdrücklich nicht erhobenem Stimmenmetadatum verglichen. Das
   Weglassen der Stimmen ist Informationsverlust; es wird nicht als
   gleichwertige Qualitätsverbesserung bewertet.

## Ausführungsergebnis vom 16.11.2026

Der Lauf auf der dokumentierten Codex-Umgebung mit Node `v24.22.1` bestand
**26 Prüfbedingungen**. Er enthält 150 gemessene Vorbereitungen und
1.464 Cachezugriffe mit virtueller Ablaufzeit. Zeitwerte sind lokale
Komponentenmessungen dieser Umgebung, keine Produktionskapazität.

Der Sechs-Fragen-Anker überschreitet mit seinen vollständigen Metadaten
bereits das Grundbudget. Die originale Summary-Vorbereitung greift deshalb
auf den Q&A-Textfallback zurück. Das Ergebnis enthält **einen von sechs
Fragetexten**, einen konservativen Inputwert von **3.138** und einen
expliziten Trunkierungshinweis für fünf Fragen. Dieser konkrete Payload
steht in `anchor-summary-request.json` auch für einen getrennten echten
Runtimeversuch bereit.

Die skalierten Fixtures liefern dagegen **null Fragetexte**. Ihre
Grundmetadaten passen ins Budget, aber kein vollständiges Fragebündel
passt zusätzlich hinein. Der ursprüngliche Fallback wird ausschließlich
bei Überschreitung durch die Grundmetadaten ausgelöst, nicht bei einer
Auswahl von null Fragetexten. Das ist eine reproduzierte Grenze dieses
synthetischen Kontexts; daraus folgt noch kein nachgewiesener Fehler der
Host-Oberfläche oder jeder realen Veranstaltung.

Bei 25.000/200 beträgt der Input der leeren Auswahl **2.859**, womit noch
469 Einheiten bis 3.328 übrig bleiben. In der kontrollierten Variante mit
20 Textzeichen und nicht erhobenen Stimmen passt **ein Fragetext** bei
**3.290** hinein. Mit vorhandenen Stimmenmetadaten oder ab 80 Textzeichen
passt in diesen Fixtures kein Fragetext. Quellenkennungen, Objektstruktur
und Metadaten zählen mit. Eine Forumzahl ist daher kein Maß für die
tatsächlich an das Modell übergebenen Texte.

| Modellierter Gesamtbestand | Kandidaten | Median Vorbereitung |       p95 | Enthaltene Fragetexte |
| -------------------------- | ---------: | ------------------: | --------: | --------------------: |
| 500                        |         40 |            5,335 ms | 13,871 ms |                     0 |
| 500                        |        200 |           27,284 ms | 35,408 ms |                     0 |
| 5.000                      |         40 |            4,445 ms |  7,235 ms |                     0 |
| 5.000                      |        200 |           18,973 ms | 31,949 ms |                     0 |
| 25.000                     |         40 |            4,088 ms |  9,554 ms |                     0 |
| 25.000                     |        200 |           20,702 ms | 26,674 ms |                     0 |

Diese Zeiten belegen CPU-Aufwand der Konstruktion auch bei unbrauchbarer
Textabdeckung. Sie belegen **keine** bessere Moderationsqualität, keine
vollständige Modellzusammenfassung und keine erfolgreiche 5.000er-Session.
Die größeren Forumzahlen sind im Versuch nur Metadaten; allein daraus
darf keine Skalierung der Datenbankzugriffe abgeleitet werden.

Bei unveränderten Daten liefert die 30-s-TTL **58 Treffer aus 61 Zugriffen**,
die 5-s-TTL **48/61**. Bei Revisionen alle fünf Sekunden liefern beide
**48/61**. Bei Revisionen alle 20 Sekunden liefert 30 s **57/61**, 5 s
**48/61**. Das gilt für beide untersuchten Kandidatenbegrenzungen und
Forumgrößen. Der semantische Hash prüft Änderungen unabhängig von der TTL;
eine kürzere TTL liefert in diesen Fällen keine zusätzlich nachgewiesene
Aktualität, verursacht aber mehr Packingarbeit. Ein Treffer erspart dabei
nicht die vorgelagerte Kontextbeschaffung: Das Original-Wrapperverfahren
forderte im Cold-/Warm-Versuch zweimal einen frischen Kontext an.

Eine Stimmenänderung invalidierte den Cache und änderte den Snapshothash.
Der bloße Bestätigungszeitstempel eines Lernziels änderte den semantischen
Hash nicht; der Wechsel von Entwurf zu bestätigt änderte ihn. Trotz
entfernter Lernzielsektion im Q&A-Fallback bleibt die relevante Revision
im Hashmaterial berücksichtigt.

## Entscheidungsfolge und offene Nachweise

- Den vorhandenen semantischen Cache nicht durch einen bloßen
  Session-ID-/TTL-Cache ersetzen. Stimmen- und Bestätigungsänderungen sind
  fachlich relevante Invalidierungsfälle.
- Bei gleichem Tokenbudget reicht ein größerer Kandidatenpool nicht als
  Begründung für mehr Informationsabdeckung. Die finale Textabdeckung muss
  vor einer generativen Anfrage erfasst und im Ergebnis genannt werden.
- Einen leeren Promptkontext nicht als Zusammenfassung des gesamten Forums
  darstellen. Der Versuch ändert die Anwendung bewusst nicht; ein etwaiger
  Guard oder eine kompaktere Darstellung wäre eine gesonderte Gegenvariante.
- Prefill, reale Modelltokenzahl, Ausgabegüte, vollständiges Analysealter,
  Datenbank-/Autorisierungsaufwand und Livebetrieb unter Last sind hier
  **offen**. Sie benötigen zusätzliche reale Messungen und können nicht aus
  diesen Packingzeiten hochgerechnet werden.

## Ergebnisdateien

- `summary.json`: komprimierte Messwerte, Provenienz und Grenzen.
- `raw.json`: einzelne Zeitwerte und Cacheentscheidungen.
- `checks.json`: alle ausgeführten Prüfbedingungen.
- `baseline-config.json`: direkt aus Releaseexporten gelesene Limits.
- `anchor-summary-request.json`: schema-validierte konkrete SummaryV2-Eingabe.

Zusätzliches Versionsdetail: Der Tag hat 30 s Labelclient-, 90 s Summaryclient-
und **120 s Lernzielclient-Timeout**; der äußere Summary-Prozessortimer hat
8 s. Spätere 300-s-Lernzielwerte gehören nicht zu dieser Tag-Baseline.
