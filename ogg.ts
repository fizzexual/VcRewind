/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * VcRewind
 *
 * Minimal Ogg Opus muxer + WebCodecs Opus encoder (renderer side), plus a WAV wrapper.
 */

export interface OpusPacket {
    data: Uint8Array;
    /** duration in microseconds */
    duration: number;
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = i << 24;
        for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) : r << 1;
        t[i] = r >>> 0;
    }
    return t;
})();

function crc32(bytes: Uint8Array): number {
    let c = 0;
    for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    return c;
}

function oggPage(packets: Uint8Array[], granule: number, serial: number, seq: number, flags: number): Uint8Array {
    const lacing: number[] = [];
    for (const p of packets) {
        let len = p.length;
        while (len >= 255) { lacing.push(255); len -= 255; }
        lacing.push(len);
    }
    if (lacing.length > 255) throw new Error("too many segments for one page");

    const body = packets.reduce((n, p) => n + p.length, 0);
    const page = new Uint8Array(27 + lacing.length + body);
    const dv = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
    page[4] = 0;
    page[5] = flags;
    dv.setBigInt64(6, BigInt(granule), true);
    dv.setUint32(14, serial, true);
    dv.setUint32(18, seq, true);
    dv.setUint32(22, 0, true); // crc placeholder
    page[26] = lacing.length;
    page.set(lacing, 27);
    let off = 27 + lacing.length;
    for (const p of packets) { page.set(p, off); off += p.length; }
    dv.setUint32(22, crc32(page), true);
    return page;
}

function opusHead(channels: number, preSkip: number, sampleRate: number): Uint8Array {
    const b = new Uint8Array(19);
    const dv = new DataView(b.buffer);
    b.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
    b[8] = 1;
    b[9] = channels;
    dv.setUint16(10, preSkip, true);
    dv.setUint32(12, sampleRate, true);
    dv.setInt16(16, 0, true);
    b[18] = 0;
    return b;
}

function opusTags(vendor = "VcRewind"): Uint8Array {
    const v = new TextEncoder().encode(vendor);
    const b = new Uint8Array(8 + 4 + v.length + 4);
    const dv = new DataView(b.buffer);
    b.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // "OpusTags"
    dv.setUint32(8, v.length, true);
    b.set(v, 12);
    dv.setUint32(12 + v.length, 0, true);
    return b;
}

export function muxOggOpus(packets: OpusPacket[], channels: number, sampleRate: number, head?: Uint8Array): Blob {
    const serial = (Math.random() * 0xffffffff) >>> 0;
    const headBytes = head && head.length >= 19 ? head : opusHead(channels, 312, sampleRate);
    const preSkip = new DataView(headBytes.buffer, headBytes.byteOffset, headBytes.byteLength).getUint16(10, true);

    const pages: Uint8Array[] = [];
    let seq = 0;
    pages.push(oggPage([headBytes], 0, serial, seq++, 0x02)); // BOS
    pages.push(oggPage([opusTags()], 0, serial, seq++, 0x00));

    let samples = 0;
    let group: Uint8Array[] = [];
    let groupSegs = 0;
    const flush = (last: boolean) => {
        if (!group.length) return;
        pages.push(oggPage(group, samples + preSkip, serial, seq++, last ? 0x04 : 0x00)); // EOS on last
        group = [];
        groupSegs = 0;
    };
    for (const p of packets) {
        const segs = Math.floor(p.data.length / 255) + 1;
        if (group.length >= 40 || groupSegs + segs > 255) flush(false);
        group.push(p.data);
        groupSegs += segs;
        samples += Math.round(p.duration * sampleRate / 1e6);
    }
    flush(true);
    return new Blob(pages as BlobPart[], { type: "audio/ogg" });
}

function toUint8(desc: AllowSharedBufferSource): Uint8Array {
    if (desc instanceof ArrayBuffer) return new Uint8Array(desc.slice(0));
    if (desc instanceof SharedArrayBuffer) return new Uint8Array(desc.slice(0) as unknown as ArrayBuffer);
    const v = desc as ArrayBufferView;
    return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);
}

/**
 * Encodes interleaved int16 PCM to Opus with WebCodecs and wraps it in an Ogg container.
 * Throws if AudioEncoder is unavailable or the codec is unsupported.
 */
export async function encodeOggOpus(pcm: Int16Array, sampleRate: number, channels: number, bitrate: number): Promise<Blob> {
    if (typeof AudioEncoder === "undefined") throw new Error("AudioEncoder unavailable");
    const config: AudioEncoderConfig = { codec: "opus", sampleRate, numberOfChannels: channels, bitrate };
    const support = await AudioEncoder.isConfigSupported(config);
    if (!support.supported) throw new Error("Opus not supported by AudioEncoder");

    const packets: OpusPacket[] = [];
    let head: Uint8Array | undefined;
    let failure: Error | null = null;

    const encoder = new AudioEncoder({
        output: (chunk, meta) => {
            const desc = meta?.decoderConfig?.description;
            if (desc && !head) head = toUint8(desc);
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            packets.push({ data, duration: chunk.duration ?? 20000 });
        },
        error: e => { failure = e; }
    });
    encoder.configure(config);

    const FRAME = Math.round(sampleRate / 50); // 20 ms
    const totalFrames = Math.floor(pcm.length / channels);
    for (let f = 0; f < totalFrames; f += FRAME) {
        if (failure) break;
        const n = Math.min(FRAME, totalFrames - f);
        const audio = new AudioData({
            format: "s16",
            sampleRate,
            numberOfFrames: n,
            numberOfChannels: channels,
            timestamp: Math.round(f / sampleRate * 1e6),
            data: pcm.subarray(f * channels, (f + n) * channels) as unknown as BufferSource
        });
        encoder.encode(audio);
        audio.close();
        while (encoder.encodeQueueSize > 64) await new Promise(r => setTimeout(r, 4));
    }
    if (!failure) await encoder.flush();
    try { encoder.close(); } catch { /* ignore */ }
    if (failure) throw failure;

    return muxOggOpus(packets, channels, sampleRate, head);
}

/** Wraps interleaved int16 PCM in a WAV container. */
export function makeWav(pcm: Int16Array, sampleRate: number, channels: number): Blob {
    const header = new ArrayBuffer(44);
    const dv = new DataView(header);
    const bytes = pcm.length * 2;
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); dv.setUint32(4, 36 + bytes, true); str(8, "WAVE");
    str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * channels * 2, true);
    dv.setUint16(32, channels * 2, true); dv.setUint16(34, 16, true);
    str(36, "data"); dv.setUint32(40, bytes, true);
    return new Blob([header, pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + bytes) as ArrayBuffer], { type: "audio/wav" });
}
