# Eigene Versuche für Thema 3A–3C

Arbeitsbasis: **v1.3.0**, Commit
`87c39334619fbcb0c5782b061da1ba0df0ba3142`.
Die Dateien in diesem Verzeichnis sind die Versuchsvariante; der Anwendungscode
bleibt unverändert. Ein späterer Commit dieses Arbeitszweigs enthält zusätzlich
die Testtreiber, ersetzt aber nicht den dokumentierten Baseline-Commit.

## Start mit einem separaten Checkout

Voraussetzungen: Git, Node.js 24, npm und Python 3. Der erste Start lädt nur die
kleinen Testabhängigkeiten, nicht die vollständige Anwendung und kein LLM.
Die direkten npm-Versionen entsprechen dem Lockfile des Release-Tags.

```bash
git clone --branch referat/thema-3-v1.3.0 https://github.com/Tajan95/arsnova.eu.git arsnova-referat
cd arsnova-referat
bash experiments/thema3/run-components.sh ../referat-ergebnisse
```

Der vorhandene Entwicklungscheckout kann bestehen bleiben. Ausgaben und
Zugangsdaten werden nicht in Git aufgenommen.

## Was tatsächlich ausgeführt wird

| Teil                 | Nachweis                                                                                       | Ausdrückliche Grenze                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Bestehende Verträge  | Zwölf vorhandene modellfreie Runtime-/Compose-Prüfungen                                        | Keine laufenden Container und keine Modellleistung                         |
| [3A](./3a/README.md) | Originalclient, kontrollierte HTTP-Konkurrenz und Abbruch; separater Runner für reale Inferenz | Direkter Client, keine vollständige Host-/DB-/UI-Kette                     |
| [3B](./3b/README.md) | Geprüfter Simulator, reale Dienstzeitproben als Eingabe                                        | Simulierte Last und globale FIFO-Gegenalternative, keine 5.000 Liveclients |
| [3C](./3c/README.md) | Originalpacking, Hash und Cache mit synthetischen Analysekontexten                             | Kontextbeschaffung ersetzt; kein DB-Lasttest und kein Qualitätsnachweis    |

Das Skript führt keinen ungekennzeichneten Modellbenchmark aus. Reale
Inferenz benötigt das im Release gepinnte Modell und eine isolierte private
Runtime. Modellmanifest, Docker-Entrypoint und Betriebsanleitung liegen im
Repository unter `docker/open-weight-llm` und `docs/operations`.

Für den realen Runner ist ausschließlich eine eigene Laborruntime zu verwenden.
Die Aufrufe und Umgebungsvariablen stehen im [3A-Leitfaden](./3a/README.md).
Die Modellgröße beträgt etwa 2,5 GB; ein erster Start benötigt Downloadzeit
und ausreichend RAM. Zugangstoken werden nicht in Befehlsbeispiele eingetragen.

Nach einem vollständig abgeschlossenen realen Lauf:

```bash
python3 experiments/thema3/3b/simulate.py \
  --calibration ../referat-ergebnisse/real/calibration.json \
  --out ../referat-ergebnisse/3b-kalibriert
```

Der reale Lauf erfasst auch Fehlversuche. Lange direkte Summary-Clientläufe mit
90 Sekunden Limit sind keine erfolgreichen Läufe der App-Queue mit ihrem
äußeren 8-Sekunden-Timer. Warmups und kontrollierte Stub-Zeiten dürfen nicht
in die Modellkalibrierung eingehen.

Die am 16.11.2026 erzeugten Rohdaten, das genaue Umgebungsmanifest und der
Ergebnisbericht werden gesondert im Referats-Arbeitspaket bereitgestellt.
Sie enthalten synthetische Prüfungsdaten, keine produktiven Veranstaltungen.
Die Messumgebung führt die exakte gepinnte OCI-Binärdatei nativ aus; sie ist
kein Nachweis des vorgesehenen Docker-/Zwei-Host-Betriebs.
