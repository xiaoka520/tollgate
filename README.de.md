# Tollgate — Deutsche Kurzfassung

> **Verwandle jede HTTP-API in eine API, die KI-Agenten pro Aufruf bezahlen können — Abrechnung in Echtzeit, abgewickelt on-chain auf Solana.**

🇬🇧 [English README](README.md) · 🟢 [Live-Demo starten](https://xiaoka520.github.io/tollgate-live/)

---

## Das Problem

KI-Agenten können Code schreiben, aber sie können die APIs, die sie aufrufen, nicht bezahlen. Jeder
kostenpflichtige Dienst im Internet ist hinter einer Bezahlschranke für **Menschen** versteckt:
Kreditkarte, Rechnung, monatliches Abo. Ein Agent, der nur eine einzige Antwort braucht, kann nichts
davon nutzen.

## Die Lösung

Tollgate ist ein Gateway, das Du **vor** eine bestehende API stellst. Es ändert an der API selbst
nichts — aber es macht sie pro Aufruf bezahlbar:

1. **Agent ruft auf** — ohne Zahlung: Der Aufruf endet mit HTTP **402 Payment Required** und einem
   maschinenlesbaren Angebot (Preis, Empfänger, Netwerk, Referenz, Ablaufzeit).
2. **Agent bezahlt on-chain** — eine einzige Solana-Transaktion: Transfer in Lamports + eine
   Memo-Notiz + die Referenz aus dem Angebot als Read-only-Account.
3. **Gateway verifiziert on-chain** — es liest die Transaktionen der Referenz, prüft, dass der
   Empfänger tatsächlich mindestens den geforderten Betrag erhalten hat, und gibt dann erst den
   eigentlichen API-Aufruf weiter.
4. **Antwort + Quittung** — die Antwort kommt zurück, zusammen mit Signatur und Explorer-Link in den
   Headern. Jede bezahlte Anfrage ist später on-chain nachprüfbar.

Kein Konto, kein Abo, keine Kreditkarte: Der Agent bezahlt genau das, was er benutzt.

## Live-Demo (devnet)

**🟢 <https://xiaoka520.github.io/tollgate-live/>** — stabiler Einstiegspunkt zur laufenden
Devnet-Instanz. Button *„Run the paying agent"* drücken und eine echte Abwicklung beobachten.

**🎬 Demo-Video (2:36):**
<https://github.com/xiaoka520/tollgate/releases/download/demo-v1/tollgate-demo.mp4>

Im Video zu sehen: 402-Angebot → echte Überweisung → Verifikation im Cluster → Antwort mit
Quittung. Nichts ist simuliert.

## Nachweis auf devnet

- Abwicklungssignatur: `5uD1c9R1Mr9sU5E6eKk3HdpQXC5x6YWAGFmgX7zUT9tHZwar6kRKwWKqapu7BZdJPpL7xidhPmvGzmzsEpD3UTw8`
- Slot: `503970304`, Fehler: keiner, Gebühr: `5000` Lamports
- Explorer: <https://explorer.solana.com/tx/5uD1c9R1Mr9sU5E6eKk3HdpQXC5x6YWAGFmgX7zUT9tHZwar6kRKwWKqapu7BZdJPpL7xidhPmvGzmzsEpD3UTw8?cluster=devnet>
- End-to-End-Test: **14/14 Prüfungen bestanden** (402-Angebot, Bezahlung, Verifikation, Weiterleitung,
  Abrechnungsstatistik, Quittungs-Header), Abwicklung in rund 4,6 Sekunden.

## Solana-Integration

- **Zahlungsfluss:** reiner System-Program-Transfer in Lamports — kein eigenes Programm nötig,
  dadurch keine zusätzlichen Angriffsflächen und keine Deploy-Kosten.
- **Zuordnung:** ein zufälliger Referenz-Pubkey pro Rechnung macht jede Zahlung eindeutig
  auffindbar (`getSignaturesForAddress`).
- **Nachweis:** kein Vertrauen in den Agenten — das Gateway vergleicht `postBalances` und
  `preBalances` des Empfängers und verlangt mindestens den angebotenen Betrag.
- **Nachvollziehbarkeit:** das SPL-Memo-Programm schreibt eine lesbare Notiz in jede Zahlung.

## Betrieb (Docker)

```bash
git clone https://github.com/xiaoka520/tollgate.git
cd tollgate
cp .env.example .env          # Netzwerk, RPC-URL, Preis, Port anpassen
docker compose up -d
```

Ohne Docker:

```bash
npm install
npm run build
npm start                     # Standardport 8099
```

### Konfiguration

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `TOLLGATE_NETWORK` | `devnet` | Netzwerk-Label (`devnet` oder `mainnet-beta`) |
| `TOLLGATE_RPC_URL` | `https://api.devnet.solana.com` | RPC-Endpunkt |
| `TOLLGATE_PRICE_LAMPORTS` | `1000000` | Preis pro Aufruf (1 SOL = 1e9 Lamports) |
| `TOLLGATE_INVOICE_TTL` | `900` | Gültigkeit einer Rechnung in Sekunden |
| `TOLLGATE_PUBLIC_URL` | leer | Öffentliche Basis-URL für Quittungslinks |
| `PORT` | `8099` | HTTP-Port |

### Eigene API hinter das Gateway stellen

```bash
curl -s -X POST http://127.0.0.1:8099/api/gateways \
  -H 'content-type: application/json' \
  -d '{"name":"Meine API","upstream":"https://api.example.com","priceSol":0.001}'
```

Danach ist die API unter `/g/<gateway-id>/...` erreichbar — jeder Aufruf wird abgerechnet.

## Tests

```bash
npm run test:e2e http://127.0.0.1:8099   # vollständiger Durchlauf gegen eine laufende Instanz
```

## Rechtliches / Sicherheit

- Private Schlüssel liegen ausschließlich lokal unter `.data/` und gehören **nicht** ins Repository.
- Devnet-SOL ist wertlos; für Mainnet-Betrieb bitte zuerst mit kleinen Beträgen testen.
- Das Gateway ist als Referenzimplementierung gedacht: vor Produktiveinsatz Rate-Limits, Reverse
  Proxy mit TLS und ein sauberes Schlüsselmanagement ergänzen.

## Lizenz

MIT
