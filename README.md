# Clipeer

Share your clipboard between your devices, peer to peer, with no server of your own.

Clipeer syncs copied text between computers on **different networks**. Devices find each other through the
[Hyperswarm](https://github.com/holepunchto/hyperswarm) distributed network, connect directly (hole punching), and every
message is end-to-end encrypted with a key derived from your session code.

## Download

Get the latest build from the **[Releases](../../releases)** page:

| System | File |
| --- | --- |
| Windows | `Clipeer-<version>-win-x64.exe` |
| macOS (Apple Silicon) | `Clipeer-<version>-mac-arm64.dmg` |
| macOS (Intel) | `Clipeer-<version>-mac-x64.dmg` |
| Linux | `Clipeer-<version>-linux-x86_64.AppImage` |

The builds are **not code-signed**, so your system will warn you the first time:

- **macOS:** right-click the app → *Open*, or run `xattr -cr /Applications/Clipeer.app`.
- **Windows:** SmartScreen → *More info* → *Run anyway*.
- **Linux:** make the file executable (`chmod +x Clipeer-*.AppImage`). On Wayland, install `wl-clipboard`
  (version 2.3 or newer on KDE Plasma 6.5+).

## How to use

1. Open Clipeer on the first device and click **Generate new code**.
2. On the other devices, paste the code in **Join with a code**.
3. Copy something on one device: it shows up in the clipboard of the others.

After pairing, Clipeer starts hidden in the tray / menu bar. Click the tray icon (or use its menu) to open the window,
see the last 10 copied items, or quit.

## Security notes

- Anyone who knows the session code can read the shared clipboard. Don't share it, and use **End session** to discard it.
- The code is stored in plain text: `%APPDATA%\Clipeer\secret` on Windows, `~/.clipeer/secret` on macOS and Linux
  (override the folder with `CLIPEER_DIR`).
- Only text is synced, up to 1 MB per item. The history shown in the tray is kept in memory only.

## Development

Requires Node 22.

```bash
npm install
npm start
```

Local builds (run each on its own operating system):

```bash
npm run dist:mac     # dmg for arm64 and x64
npm run dist:linux   # AppImage
npm run dist:win     # NSIS installer (.exe)
```

## Releasing

The workflow in `.github/workflows/build.yml` builds Windows, macOS and Linux and publishes a GitHub Release.
The app version is taken from the tag:

```bash
git tag v1.3.0
git push origin v1.3.0
```

You can also run it by hand from the **Actions** tab (*Run workflow*): it builds and uploads the files as artifacts,
without publishing a release.
