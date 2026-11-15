# Installs the Smart Shuffle extension into Spicetify (Windows).
# Requires Spicetify already installed and working: https://spicetify.app
$ErrorActionPreference = "Stop"

if (-not (Get-Command spicetify -ErrorAction SilentlyContinue)) {
    Write-Error "spicetify not found in PATH. Install it first: https://spicetify.app"
}

$src = Join-Path $PSScriptRoot "extension\smartshuffle.js"
$dst = Join-Path $env:APPDATA "spicetify\Extensions"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item $src $dst -Force

spicetify config extensions smartshuffle.js
spicetify apply
Write-Host "Done. In Spotify: profile menu > 'Smart Shuffle: use the playlist playing now'."
