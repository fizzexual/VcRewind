# VcRewind

Medal-style **"clip that"** button for Discord voice calls, as a Vencord plugin.
Keeps the last 15 seconds to 5 minutes of what you heard in the call (and optionally your own mic)
and saves it to a file the moment you press the button, hit the keybind, or run `/clip`.

**✅ Verified: 6 September 2026** on Discord Stable (Electron 42 / Chrome 148) with Vencord `main`.

## Features

- Button next to mute/deafen in the account panel (glows while a call is being buffered)
- Keybind (default `F8`) and `/clip` slash command
- Clip length from 15 s to 5 min, adjustable slider
- Opus `.ogg` output (about 0.7 MB per minute at 96 kbps, plays inline on Discord) or lossless WAV
- Optional: include your own microphone
- Optional: attach the clip to the text channel you are looking at
- Notification with a click-to-open-folder action
- No screen capture, no loopback devices, no extra drivers

## How it works

Discord's native voice engine can write a WebRTC *AEC dump*: one file per minute in
`%APPDATA%\discord\module_data\discord_voice\aecdump<N>` containing the playout stream
(everyone you hear, stereo 48 kHz) and your processed microphone (mono 48 kHz), each with an
epoch timestamp. The plugin:

1. Turns that dump on whenever you are connected to voice and off when you leave.
2. Prunes old dump files every 30 seconds so only a bit more than your clip length stays on disk
   (roughly 29 MB per buffered minute).
3. On clip, the main-process helper (`native.ts` + `dump.ts`) parses the newest contiguous files,
   takes the tail, mixes mic into the stereo playout, and hands 16-bit PCM to the renderer.
4. The renderer (`ogg.ts`) encodes it to Opus with WebCodecs and wraps it in an Ogg container
   (or writes WAV), then the helper saves it to your clips folder.

Your mic is only present in the processed stream while you are unmuted, so muted stretches stay silent.

## Installation

Requires a Vencord source install (Node 22+, pnpm 11+).

```bash
mkdir -p /path/to/Vencord/src/userplugins/vcRewind.desktop
cp index.tsx native.ts dump.ts ogg.ts /path/to/Vencord/src/userplugins/vcRewind.desktop/
cd /path/to/Vencord && pnpm build && pnpm inject
```

Restart Discord fully (the plugin has a main-process part, a reload is not enough), then enable
**VcRewind** in Settings → Vencord → Plugins.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Clip length | 60 s | 15 s to 5 min |
| Include my microphone | on | Only while unmuted |
| File format | Opus (.ogg) | WAV is about 11 MB per minute |
| Opus bitrate | 96 kbps | 64 to 160 |
| Folder | `Videos\Discord Clips` | Any absolute path |
| Attach to current channel | off | Opens Discord's upload prompt with the clip |
| Keybind | `F8` | e.g. `Ctrl+Shift+K`; plain letters are ignored while typing |
| Show button | on | Restart needed |
| Notification | on | Click it to open the folder |

Clips are named `Discord Clip YYYY-MM-DD HH-MM-SS.ogg` using the time the clip starts.

## Caveats

- Desktop app only. The dump is a feature of Discord's native voice engine; Vesktop and the browser have no equivalent.
- Everything you hear through Discord voice is captured, including soundboard sounds. Game audio is not.
- The dump is a Discord debug feature. If Discord removes or changes it, the plugin stops working.
- Disabling the plugin deletes all buffered dump files and turns the dump off.
- Recording other people may be regulated where you live. Get consent where required.

## License

GPL-3.0-or-later, same as Vencord.
