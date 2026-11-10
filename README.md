# Min ström

Spotpriser på el för Sveriges fyra elområden (SE1–SE4), hämtade från Nord Pool. Ingen reklam, ingen spårning och inget konto.

## Funktioner

- Pris just nu för valt elområde, plus aktuellt pris i alla fyra områden
- Stapeldiagram för idag och imorgon (morgondagens priser kommer runt kl. 13), per timme eller per kvart
- Lägsta, högsta och genomsnittligt pris för dagen
- Billigaste sammanhängande perioden på 1, 3 och 6 timmar framåt, bra för disk, tvätt och laddning
- Valfri moms (25 %) och eget elhandelspåslag
- Fungerar offline med senast hämtade priser
- Ljust och mörkt tema som följer telefonen

## Installera på telefonen

Appen är en webbapp (PWA) och behöver ingen App Store eller Google Play.

1. Publicera den (se nedan) och öppna adressen i telefonen.
2. **iPhone (Safari):** Dela-knappen → *Lägg till på hemskärmen*.
   **Android (Chrome):** Menyn ⋮ → *Installera app* / *Lägg till på startskärmen*.

## Publicera gratis med GitHub Pages

1. Slå ihop koden till grenen `main`.
2. Gå till *Settings → Pages* i repot och välj **Source: GitHub Actions**.
3. Arbetsflödet `.github/workflows/pages.yml` publicerar appen på
   `https://<ditt-användarnamn>.github.io/<repo>/`.

## Köra lokalt

```sh
python3 -m http.server 8000
# öppna http://localhost:8000
```

## Datakällor

- Primär: Nord Pools dataportal (`dataportal-api.nordpoolgroup.com`, day-ahead, SEK/MWh)
- Reserv: [elprisetjustnu.se](https://www.elprisetjustnu.se), som bygger på samma Nord Pool-data

Priserna är spotpriser. Nätavgift, energiskatt och elhandelsbolagets avgifter ingår inte, förutom ett eventuellt eget påslag som du anger.
