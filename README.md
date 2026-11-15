# Smart Shuffle for Spicetify

A free, personal-use [Spicetify](https://spicetify.app) extension that replaces random shuffle
with one that **learns what you like**: songs you finish rise, songs you skip fade, songs you
replay get a temporary boost. No ratings to enter, it just watches how you listen.

> **Not affiliated with, endorsed by, or sponsored by Spotify.** "Spotify" is a trademark of
> its owner. This project contains **no Spotify code**: it is entirely original and only talks
> to the client through the public Spicetify API.

## Free and non-commercial

This is a hobby project. It is free, MIT-licensed, has no ads, no accounts, no tracking and
no intent to make money. If Spotify (or anyone there) finds it interesting, I am happy to let
them use, adapt or build on it, with no strings attached. I have nothing against them. An
issue or a message is enough.

## What you get

- Smart queue: keeps 2 upcoming tracks of your chosen playlist, picked by learned score.
- Heart button in the player bar: "I like this one" (strong boost).
- Menu items (profile menu): use the current playlist, turn on/off, view scores,
  aggressiveness (gentle / default / radical), export backup, reset.
- UI built with the client's own design tokens, so it looks native in light/dark themes.
- 100% local: data stays in the client's local storage. No network calls, no telemetry.

## Install (Windows)

1. Install Spicetify and make sure it works: <https://spicetify.app>
2. Clone or download this repo, then in PowerShell:

```powershell
.\install.ps1
```

Manual install (any OS): copy `extension/smartshuffle.js` into your Spicetify `Extensions`
folder, then:

```bash
spicetify config extensions smartshuffle.js
spicetify apply
```

## Use

1. Start playing the playlist you want to shuffle smartly.
2. Profile menu > **Smart Shuffle: use the playlist playing now**.
3. Just listen. Use the heart for songs you love. Export a backup once in a while.

Tested on Spotify 1.3.9 with Spicetify 2.46. Client updates can break Spicetify; if so, run
`spicetify backup apply`.

## Please read: terms of service

Modifying the Spotify client (which Spicetify does) is against Spotify's terms. I know of no
documented bans from using Spicetify, but the risk is low, not zero. Use it on your own
account and at your own risk. This extension itself never contacts any server.

## How it works / development

See [docs/DESIGN.md](docs/DESIGN.md). Tests: `node extension/test.js`. Simulation:
`python sim/sim.py` (needs numpy).

## Português (resumo)

Extensão gratuita para o Spicetify que troca o shuffle aleatório por um que aprende o seu
gosto: ouvir até o fim sobe a nota, pular desce, repetir dá um impulso temporário. Sem código
da Spotify, sem fins lucrativos, sem afiliação com a Spotify; se eles tiverem interesse em
usar, fico à vontade em liberar. Tudo roda local, sem enviar dados. Instalação: rode
`.\install.ps1` (precisa do Spicetify). Depois, no menu do perfil, use "Smart Shuffle: usar a
playlist tocando agora". Modificar o cliente vai contra os
termos da Spotify; o risco é baixo, mas não é zero.

## License

[MIT](LICENSE)
