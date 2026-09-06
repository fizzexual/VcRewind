/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * VcRewind
 *
 * Medal-style "clip that" button for Discord voice calls: keeps the last N seconds of what
 * you hear (and optionally your mic) and saves them to a file on demand.
 *
 * How it works: Discord's native voice engine can write a WebRTC "AEC dump" to
 * <userData>/module_data/discord_voice/aecdump<N>, one file per minute, containing the
 * playout stream (everyone else) and your processed mic. The plugin turns that dump on while
 * you are in voice, prunes old files, and on clip parses the tail into PCM (native.ts / dump.ts),
 * encodes it to Opus in the renderer (ogg.ts) and writes it to your clips folder.
 */

import { ApplicationCommandInputType } from "@api/Commands";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, MediaEngineStore, SelectedChannelStore, showToast, Toasts, UploadHandler, useStateFromStores } from "@webpack/common";

import { encodeOggOpus, makeWav } from "./ogg";

const Native = VencordNative.pluginHelpers.VcRewind as PluginNative<typeof import("./native")>;
const RTCConnectionStore = findStoreLazy("RTCConnectionStore");
const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const settings = definePluginSettings({
    bufferSeconds: {
        type: OptionType.SLIDER,
        description: "Clip length: how many seconds of the call to save when you press the button",
        markers: [15, 30, 45, 60, 90, 120, 180, 240, 300],
        default: 60,
        stickToMarkers: false
    },
    includeMic: {
        type: OptionType.BOOLEAN,
        description: "Include your own microphone in clips (only while unmuted)",
        default: true
    },
    format: {
        type: OptionType.SELECT,
        description: "File format",
        options: [
            { label: "Opus (.ogg, small, plays inline on Discord)", value: "ogg", default: true },
            { label: "WAV (lossless, ~11 MB per minute)", value: "wav" }
        ]
    },
    bitrate: {
        type: OptionType.SELECT,
        description: "Opus bitrate",
        options: [
            { label: "64 kbps", value: 64000 },
            { label: "96 kbps", value: 96000, default: true },
            { label: "128 kbps", value: 128000 },
            { label: "160 kbps", value: 160000 }
        ]
    },
    folder: {
        type: OptionType.STRING,
        description: "Folder to save clips in. Leave empty for Videos\\Discord Clips",
        default: ""
    },
    uploadToChat: {
        type: OptionType.BOOLEAN,
        description: "Also attach the clip to the text channel you are looking at",
        default: false
    },
    keybind: {
        type: OptionType.STRING,
        description: "Keybind to save a clip, e.g. F8 or Ctrl+Shift+K",
        default: "F8"
    },
    showButton: {
        type: OptionType.BOOLEAN,
        description: "Show the clip button next to mute/deafen",
        default: true,
        restartNeeded: true
    },
    notify: {
        type: OptionType.BOOLEAN,
        description: "Show a notification when a clip is saved (click it to open the folder)",
        default: true
    }
});

let dumpOn = false;
let pruneTimer: ReturnType<typeof setInterval> | undefined;
let busy = false;

function isConnected() {
    return RTCConnectionStore?.getState?.() === "RTC_CONNECTED";
}

function keepCount() {
    return Math.ceil(settings.store.bufferSeconds / 60) + 2;
}

function setDump(on: boolean) {
    if (dumpOn === on) return;
    dumpOn = on;
    FluxDispatcher.dispatch({ type: "MEDIA_ENGINE_SET_AEC_DUMP", enabled: on });
    clearInterval(pruneTimer);
    pruneTimer = undefined;
    if (on) {
        pruneTimer = setInterval(() => Native.prune(keepCount()).catch(() => { }), 30_000);
    } else {
        Native.prune(keepCount()).catch(() => { });
    }
}

function onRtcChange() {
    if (isConnected()) setDump(true);
    else if (dumpOn) setDump(false);
}

function pad(n: number) {
    return String(n).padStart(2, "0");
}

function stamp(d: Date) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function fmtDuration(seconds: number) {
    const s = Math.round(seconds);
    return s >= 60 ? `${Math.floor(s / 60)}m ${pad(s % 60)}s` : `${s}s`;
}

async function clip(channelId?: string) {
    if (busy) return;
    busy = true;
    try {
        const res = await Native.getClip(settings.store.bufferSeconds, settings.store.includeMic);
        if (!res.frames) {
            showToast("VcRewind: nothing buffered yet. Join a voice channel and wait a few seconds.", Toasts.Type.FAILURE);
            return;
        }

        const bytesIn = res.pcm.byteOffset % 2 === 0 ? res.pcm : new Uint8Array(res.pcm);
        const pcm = new Int16Array(bytesIn.buffer, bytesIn.byteOffset, Math.floor(bytesIn.byteLength / 2));
        const duration = res.frames / res.sampleRate;

        let blob: Blob;
        let ext: string;
        if (settings.store.format === "wav") {
            blob = makeWav(pcm, res.sampleRate, res.channels);
            ext = "wav";
        } else {
            try {
                blob = await encodeOggOpus(pcm, res.sampleRate, res.channels, Number(settings.store.bitrate) || 96000);
                ext = "ogg";
            } catch (e) {
                console.error("[VcRewind] Opus encoding failed, falling back to WAV", e);
                blob = makeWav(pcm, res.sampleRate, res.channels);
                ext = "wav";
            }
        }

        const filename = `Discord Clip ${stamp(new Date(res.startMs || Date.now()))}.${ext}`;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const path = await Native.writeClip(settings.store.folder, filename, bytes);

        if (settings.store.notify) {
            showNotification({
                title: "Clip saved",
                body: `${fmtDuration(duration)} · ${filename}\nClick to open the folder`,
                color: "#eb459e",
                onClick: () => Native.showInFolder(path)
            });
        } else {
            showToast(`Clip saved (${fmtDuration(duration)})`, Toasts.Type.SUCCESS);
        }

        if (settings.store.uploadToChat) {
            const channel = ChannelStore.getChannel(channelId ?? SelectedChannelStore.getChannelId());
            if (channel) UploadHandler.promptToUpload([new File([bytes], filename, { type: blob.type })], channel, 0);
        }
    } catch (e) {
        console.error("[VcRewind] failed to save clip", e);
        showToast("VcRewind: failed to save clip, see console", Toasts.Type.FAILURE);
    } finally {
        busy = false;
    }
}

function matchesKeybind(e: KeyboardEvent) {
    const parts = (settings.store.keybind || "").split("+").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return false;
    const key = parts.pop()!;
    const ctrl = parts.includes("ctrl") || parts.includes("control");
    const shift = parts.includes("shift");
    const alt = parts.includes("alt");
    if (e.ctrlKey !== ctrl || e.shiftKey !== shift || e.altKey !== alt) return false;
    const k = e.key.toLowerCase(), code = e.code.toLowerCase();
    return k === key || code === key || (key.length === 1 && code === "key" + key);
}

function onKeyDown(e: KeyboardEvent) {
    if (!matchesKeybind(e)) return;
    // A plain letter keybind should not fire while typing
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName));
    if (typing && !e.ctrlKey && !e.altKey && !/^f\d+$/i.test(e.key)) return;
    e.preventDefault();
    clip();
}

function ClipIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5a7 7 0 1 1-6.3 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M5 4v5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="12" cy="12" r="2.2" fill="currentColor" />
        </svg>
    );
}

function ClipButton(props: { nameplate?: unknown; }) {
    const connected = useStateFromStores([RTCConnectionStore], () => isConnected());
    const tip = connected
        ? `Save the last ${fmtDuration(settings.store.bufferSeconds)} of this call (${settings.store.keybind})`
        : "VcRewind: join a voice channel to start buffering";
    return (
        <PanelButton
            tooltipText={tip}
            icon={ClipIcon}
            role="button"
            aria-label="Save voice clip"
            redGlow={connected}
            plated={props?.nameplate != null}
            onClick={() => clip()}
        />
    );
}

export default definePlugin({
    name: "VcRewind",
    description: "Medal-style clip button for voice calls: saves the last 15s-5min of what you heard (and your mic) to a file. Button next to mute/deafen, keybind, or /clip",
    authors: [{ name: "fizzexual", id: 0n }],
    settings,

    patches: [
        {
            // Account panel (mute / deafen / settings buttons)
            find: "accountContainerRef:",
            predicate: () => settings.store.showButton,
            replacement: {
                match: /children:\[(?=\(0,\i\.jsx\)\(\i,\{accountContainerRef:)/,
                replace: "children:[$self.renderButton(arguments[0]),"
            }
        }
    ],

    commands: [
        {
            name: "clip",
            description: "Save the last seconds of the voice call to a file",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_, ctx) => { clip(ctx.channel.id); }
        }
    ],

    renderButton: (props: any) => (
        <ErrorBoundary noop>
            <ClipButton nameplate={props?.nameplate} />
        </ErrorBoundary>
    ),

    clip,

    start() {
        // Discord persists the dump flag; pick up whatever state it is in
        dumpOn = !!(MediaEngineStore as any).getAecDump?.();
        window.addEventListener("keydown", onKeyDown);
        RTCConnectionStore.addChangeListener(onRtcChange);
        onRtcChange();
        if (!isConnected() && dumpOn) setDump(false);
    },

    stop() {
        window.removeEventListener("keydown", onKeyDown);
        RTCConnectionStore.removeChangeListener(onRtcChange);
        setDump(false);
        Native.deleteAll().catch(() => { });
    }
});
