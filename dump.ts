/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * VcRewind
 *
 * Parser for Discord's WebRTC "AEC dump" files (module_data/discord_voice/aecdump<N>).
 * Runs in the main process (imported by native.ts). No Electron imports here so it can be unit-tested with plain node.
 *
 * File format: repeated [uint32 LE length][protobuf webrtc.audioproc.Event]
 *   Event.type           field 1  varint  0=INIT 1=REVERSE_STREAM 2=STREAM 3=CONFIG
 *   Event.init           field 2  Init { sample_rate=1, num_reverse_channels=5, reverse_sample_rate=6, timestamp_ms=10 }
 *   Event.reverse_stream field 3  ReverseStream { data=1 }              int16 interleaved, what you hear (everyone else)
 *   Event.stream         field 4  Stream { input_data=1, output_data=2 } int16 mono, your mic (raw / processed)
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync } from "fs";
import { join } from "path";

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;

const FRAMES_PER_RECORD = 480; // 10 ms at 48 kHz

export interface DumpInfo {
    path: string;
    index: number;
    size: number;
    startMs: number;
}

export interface ParsedDump {
    startMs: number;
    sampleRate: number;
    reverseChannels: number;
    /** interleaved int16 stereo, 10 ms per chunk */
    reverse: Buffer[];
    /** int16 mono, 10 ms per chunk */
    mic: Buffer[];
}

export interface Clip {
    /** interleaved int16 stereo at 48 kHz */
    pcm: Int16Array;
    frames: number;
    /** epoch ms of the first sample (approximate) */
    startMs: number;
}

function varint(b: Buffer, o: number): [number, number] {
    let result = 0, shift = 0, i = o;
    for (; ;) {
        if (i >= b.length) throw new Error("truncated varint");
        const x = b[i++];
        result += (x & 0x7f) * 2 ** shift;
        if (!(x & 0x80)) break;
        shift += 7;
        if (shift > 56) throw new Error("varint too long");
    }
    return [result, i];
}

type Field = { num: number; wire: number; value: number; start: number; len: number; };

function fields(b: Buffer, start: number, end: number): Field[] {
    const out: Field[] = [];
    let i = start;
    while (i < end) {
        const [key, j] = varint(b, i);
        i = j;
        const num = Math.floor(key / 8), wire = key & 7;
        if (wire === 0) {
            const [v, k] = varint(b, i);
            out.push({ num, wire, value: v, start: i, len: k - i });
            i = k;
        } else if (wire === 2) {
            const [len, k] = varint(b, i);
            out.push({ num, wire, value: len, start: k, len });
            i = k + len;
        } else if (wire === 1) {
            out.push({ num, wire, value: 0, start: i, len: 8 });
            i += 8;
        } else if (wire === 5) {
            out.push({ num, wire, value: 0, start: i, len: 4 });
            i += 4;
        } else {
            throw new Error("unsupported wire type " + wire);
        }
    }
    return out;
}

/** Scans the first few records for the Init event and returns its timestamp_ms (0 if not found). */
function parseHeader(b: Buffer): number {
    let i = 0;
    for (let n = 0; n < 8 && i + 4 <= b.length; n++) {
        const len = b.readUInt32LE(i);
        i += 4;
        if (i + len > b.length) return 0;
        let ev: Field[];
        try { ev = fields(b, i, i + len); } catch { return 0; }
        if (ev.find(f => f.num === 1)?.value === 0) {
            const init = ev.find(f => f.num === 2);
            if (!init) return 0;
            return fields(b, init.start, init.start + init.len).find(f => f.num === 10)?.value ?? 0;
        }
        i += len;
    }
    return 0;
}

/** Reads only the head of the file to get the Init timestamp. */
export function readStartMs(path: string): number {
    const fd = openSync(path, "r");
    try {
        const head = Buffer.alloc(4096);
        const n = readSync(fd, head, 0, head.length, 0);
        return parseHeader(head.subarray(0, n));
    } finally {
        closeSync(fd);
    }
}

export function parseDump(b: Buffer): ParsedDump {
    const out: ParsedDump = { startMs: 0, sampleRate: SAMPLE_RATE, reverseChannels: CHANNELS, reverse: [], mic: [] };
    let i = 0;
    while (i + 4 <= b.length) {
        const len = b.readUInt32LE(i);
        i += 4;
        if (i + len > b.length) break; // file is still being written
        let ev: Field[];
        try { ev = fields(b, i, i + len); } catch { break; }
        const type = ev.find(f => f.num === 1)?.value;
        if (type === 0) {
            const init = ev.find(f => f.num === 2);
            if (init) {
                // Discord re-inits mid-file (e.g. output switches to 7.1); keep the first Init's timestamp
                for (const f of fields(b, init.start, init.start + init.len)) {
                    if (f.num === 10 && !out.startMs) out.startMs = f.value;
                    else if (f.num === 6) out.sampleRate = f.value;
                    else if (f.num === 5) out.reverseChannels = f.value;
                }
            }
        } else if (type === 1) {
            const rs = ev.find(f => f.num === 3);
            if (rs) {
                const data = fields(b, rs.start, rs.start + rs.len).find(f => f.num === 1 && f.wire === 2);
                if (data) out.reverse.push(b.subarray(data.start, data.start + data.len));
            }
        } else if (type === 2) {
            const st = ev.find(f => f.num === 4);
            if (st) {
                const sub = fields(b, st.start, st.start + st.len);
                const data = sub.find(f => f.num === 2 && f.wire === 2) ?? sub.find(f => f.num === 1 && f.wire === 2);
                if (data) out.mic.push(b.subarray(data.start, data.start + data.len));
            }
        }
        i += len;
    }
    return out;
}

export function listDumps(dir: string): DumpInfo[] {
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const out: DumpInfo[] = [];
    for (const name of names) {
        const m = /^aecdump(\d+)$/.exec(name);
        if (!m) continue;
        const path = join(dir, name);
        try {
            const { size } = statSync(path);
            if (size < 8) continue;
            out.push({ path, index: Number(m[1]), size, startMs: readStartMs(path) });
        } catch { /* file vanished */ }
    }
    return out.sort((a, b) => a.startMs - b.startMs || a.index - b.index);
}

/** Average bytes per 10 ms record, sampled from the head of the file (stereo ~3.9 KB, 7.1 ~9.6 KB). */
function bytesPerRecord(path: string): number {
    const fd = openSync(path, "r");
    try {
        const head = Buffer.alloc(256 * 1024);
        const n = readSync(fd, head, 0, head.length, 0);
        let i = 0, recs = 0;
        while (i + 4 <= n) {
            const len = head.readUInt32LE(i);
            if (i + 4 + len > n) break;
            i += 4 + len;
            recs++;
        }
        return recs > 4 ? i / recs : 3873;
    } catch {
        return 3873;
    } finally {
        closeSync(fd);
    }
}

/** Rough seconds of audio in the newest contiguous run of dump files (from file sizes, no full parse). */
export function bufferedSeconds(dir: string): number {
    const dumps = listDumps(dir);
    if (!dumps.length) return 0;
    let total = 0;
    let nextStart = Infinity;
    for (let k = dumps.length - 1; k >= 0; k--) {
        const d = dumps[k];
        const secs = d.size / bytesPerRecord(d.path) / 100;
        if (nextStart !== Infinity && nextStart - (d.startMs + secs * 1000) > 2500) break; // different call
        total += secs;
        nextStart = d.startMs;
    }
    return total;
}

/**
 * Builds the last `seconds` of audio from the newest contiguous run of dump files.
 * Everyone else (stereo) mixed with your processed mic (mono) when includeMic is set.
 */
export function readTail(dir: string, seconds: number, includeMic: boolean): Clip {
    const wanted = Math.max(1, Math.round(seconds * SAMPLE_RATE));
    const dumps = listDumps(dir);
    const parsed: ParsedDump[] = [];
    let have = 0;
    let nextStart = Infinity;

    for (let k = dumps.length - 1; k >= 0 && have < wanted; k--) {
        let p: ParsedDump;
        try { p = parseDump(readFileSync(dumps[k].path)); } catch { continue; }
        const frames = p.reverse.length * FRAMES_PER_RECORD;
        if (!frames) continue;
        const endMs = p.startMs + frames / SAMPLE_RATE * 1000;
        if (nextStart !== Infinity && nextStart - endMs > 2500) break; // gap: previous call, stop here
        parsed.unshift(p);
        have += frames;
        nextStart = p.startMs;
    }

    if (!have) return { pcm: new Int16Array(0), frames: 0, startMs: 0 };

    const frames = Math.min(have, wanted);
    const pcm = new Int16Array(frames * CHANNELS);

    // Fill from the end backwards so both streams are tail-aligned.
    let pos = frames; // next frame index to fill (exclusive)
    outer: for (let k = parsed.length - 1; k >= 0; k--) {
        const p = parsed[k];
        const micOffset = p.mic.length - p.reverse.length;
        for (let r = p.reverse.length - 1; r >= 0; r--) {
            if (pos <= 0) break outer;
            const rev = p.reverse[r];
            const mic = includeMic ? p.mic[r + micOffset] : undefined;
            // Each chunk is 10 ms; the playout channel count can change mid-file (stereo, 5.1, 7.1)
            const ch = Math.max(1, Math.round(rev.length / (FRAMES_PER_RECORD * 2)));
            const n = Math.min(FRAMES_PER_RECORD, Math.floor(rev.length / (2 * ch)));
            const startFrame = pos - n;
            const skip = startFrame < 0 ? -startFrame : 0;
            for (let f = skip; f < n; f++) {
                const m = mic && f * 2 + 1 < mic.length ? mic.readInt16LE(f * 2) : 0;
                const base = f * ch * 2;
                let l: number, rr: number;
                if (ch === 1) {
                    l = rr = rev.readInt16LE(base);
                } else {
                    l = rev.readInt16LE(base);
                    rr = rev.readInt16LE(base + 2);
                    if (ch > 2) {
                        // FL FR C LFE SL SR BL BR: fold centre and surrounds in, drop LFE
                        const c = rev.readInt16LE(base + 4);
                        let sl = 0, sr = 0;
                        for (let k = 4; k < ch; k++) {
                            const v = rev.readInt16LE(base + k * 2);
                            if (k % 2 === 0) sl += v; else sr += v;
                        }
                        l += 0.707 * (c + sl);
                        rr += 0.707 * (c + sr);
                    }
                }
                let vl = l + m, vr = rr + m;
                if (vl > 32767) vl = 32767; else if (vl < -32768) vl = -32768;
                if (vr > 32767) vr = 32767; else if (vr < -32768) vr = -32768;
                const o = (startFrame + f) * CHANNELS;
                pcm[o] = vl;
                pcm[o + 1] = vr;
            }
            pos = startFrame;
        }
    }

    const last = parsed[parsed.length - 1];
    const endMs = last.startMs + last.reverse.length * FRAMES_PER_RECORD / SAMPLE_RATE * 1000;
    return { pcm, frames, startMs: Math.round(endMs - frames / SAMPLE_RATE * 1000) };
}

/** Deletes all but the newest `keep` dump files (and their capture<N>.wav siblings). Returns deleted count. */
export function pruneDumps(dir: string, keep: number): number {
    const dumps = listDumps(dir);
    const victims = dumps.slice(0, Math.max(0, dumps.length - keep));
    let n = 0;
    for (const d of victims) {
        for (const p of [d.path, join(dir, `capture${d.index}.wav`)]) {
            try { unlinkSync(p); n++; } catch { /* in use or gone */ }
        }
    }
    // capture files without a live dump sibling
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { /* ignore */ }
    const live = new Set(dumps.slice(Math.max(0, dumps.length - keep)).map(d => d.index));
    for (const name of names) {
        const m = /^capture(\d+)\.wav$/.exec(name);
        if (m && !live.has(Number(m[1]))) {
            try { unlinkSync(join(dir, name)); n++; } catch { /* ignore */ }
        }
    }
    return n;
}

export function deleteAllDumps(dir: string): number {
    return pruneDumps(dir, 0);
}
