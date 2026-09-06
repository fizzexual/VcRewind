/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * VcRewind
 *
 * Main-process helpers. Exposed to the renderer as VencordNative.pluginHelpers.VcRewind
 */

import { app, IpcMainInvokeEvent, shell } from "electron";
import { mkdir, writeFile } from "fs/promises";
import { isAbsolute, join, normalize } from "path";

import { bufferedSeconds, CHANNELS, deleteAllDumps, pruneDumps, readTail, SAMPLE_RATE } from "./dump";

function dumpDir() {
    return join(app.getPath("userData"), "module_data", "discord_voice");
}

function defaultFolder() {
    return join(app.getPath("videos"), "Discord Clips");
}

function resolveFolder(folder: string) {
    const f = typeof folder === "string" ? folder.trim() : "";
    return f && isAbsolute(f) ? normalize(f) : defaultFolder();
}

export function getDefaultFolder(_: IpcMainInvokeEvent) {
    return defaultFolder();
}

export function getStatus(_: IpcMainInvokeEvent) {
    const dir = dumpDir();
    return { dir, bufferedSeconds: bufferedSeconds(dir) };
}

/** Returns the last `seconds` of call audio as interleaved int16 stereo PCM bytes. */
export function getClip(_: IpcMainInvokeEvent, seconds: number, includeMic: boolean) {
    const clip = readTail(dumpDir(), Math.max(1, Math.min(3600, Number(seconds) || 60)), !!includeMic);
    return {
        pcm: new Uint8Array(clip.pcm.buffer, clip.pcm.byteOffset, clip.pcm.byteLength),
        frames: clip.frames,
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        startMs: clip.startMs
    };
}

export async function writeClip(_: IpcMainInvokeEvent, folder: string, filename: string, bytes: Uint8Array) {
    const dir = resolveFolder(folder);
    const safeName = String(filename).replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/^[-. ]+|[-. ]+$/g, "").slice(0, 150) || "clip";
    await mkdir(dir, { recursive: true });
    const path = join(dir, safeName);
    await writeFile(path, bytes);
    return path;
}

export function prune(_: IpcMainInvokeEvent, keep: number) {
    return pruneDumps(dumpDir(), Math.max(1, Math.floor(Number(keep) || 3)));
}

export function deleteAll(_: IpcMainInvokeEvent) {
    return deleteAllDumps(dumpDir());
}

export function showInFolder(_: IpcMainInvokeEvent, path: string) {
    if (typeof path === "string" && isAbsolute(path)) shell.showItemInFolder(normalize(path));
}
