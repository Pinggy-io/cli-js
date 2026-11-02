import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { BUNDLE_MILLIS, FrameSplitter, rawBundleBytes } from '../devices/terminal/frameSplitter.js';

const BUNDLE_BYTES = 100;

describe('the terminal frame splitter', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('a full bundle leaves at once, without waiting for the timer', () => {
        const frames: Buffer[] = [];
        const splitter = new FrameSplitter((chunk) => frames.push(chunk), BUNDLE_BYTES);

        splitter.push(Buffer.alloc(BUNDLE_BYTES, 0x61));

        expect(frames).toHaveLength(1);
        expect(frames[0]).toHaveLength(BUNDLE_BYTES);
    });

    // A person typing produces 1-byte writes. Without the timer that is 1 frame per keystroke.
    test('1 byte in is 1 frame out after the delay, not 1 frame per byte before it', () => {
        const frames: Buffer[] = [];
        const splitter = new FrameSplitter((chunk) => frames.push(chunk), BUNDLE_BYTES);

        splitter.push(Buffer.from('a'));
        splitter.push(Buffer.from('b'));
        splitter.push(Buffer.from('c'));
        expect(frames).toHaveLength(0);

        jest.advanceTimersByTime(BUNDLE_MILLIS);

        expect(frames).toHaveLength(1);
        expect(frames[0].toString()).toBe('abc');
    });

    test('a chunk larger than the cap is split, never truncated', () => {
        const frames: Buffer[] = [];
        const splitter = new FrameSplitter((chunk) => frames.push(chunk), BUNDLE_BYTES);

        splitter.push(Buffer.alloc(BUNDLE_BYTES * 2 + 25, 0x62));
        jest.advanceTimersByTime(BUNDLE_MILLIS);

        expect(frames.map((frame) => frame.length)).toEqual([BUNDLE_BYTES, BUNDLE_BYTES, 25]);
        const total = frames.reduce((sum, frame) => sum + frame.length, 0);
        expect(total).toBe(BUNDLE_BYTES * 2 + 25);
    });

    test('bytes survive the split in order, byte for byte', () => {
        const frames: Buffer[] = [];
        const splitter = new FrameSplitter((chunk) => frames.push(chunk), 4);
        const source = Buffer.from('the quick brown fox');

        splitter.push(source);
        jest.advanceTimersByTime(BUNDLE_MILLIS);

        expect(Buffer.concat(frames).toString()).toBe(source.toString());
    });

    test('the timer does not fire again once everything has left', () => {
        const frames: Buffer[] = [];
        const splitter = new FrameSplitter((chunk) => frames.push(chunk), BUNDLE_BYTES);

        splitter.push(Buffer.alloc(BUNDLE_BYTES, 0x63));
        jest.advanceTimersByTime(BUNDLE_MILLIS * 10);

        expect(frames).toHaveLength(1);
    });

    test('flush sends what is held, and holds nothing afterwards', () => {
        const frames: Buffer[] = [];
        const splitter = new FrameSplitter((chunk) => frames.push(chunk), BUNDLE_BYTES);

        splitter.push(Buffer.from('half'));
        splitter.flush();

        expect(frames).toHaveLength(1);
        expect(splitter.buffered).toBe(0);

        jest.advanceTimersByTime(BUNDLE_MILLIS * 2);
        expect(frames).toHaveLength(1);
    });

    test('dispose drops what is held and cancels the timer', () => {
        const frames: Buffer[] = [];
        const splitter = new FrameSplitter((chunk) => frames.push(chunk), BUNDLE_BYTES);

        splitter.push(Buffer.from('dropped'));
        splitter.dispose();
        jest.advanceTimersByTime(BUNDLE_MILLIS * 2);

        expect(frames).toHaveLength(0);
    });

    test('an empty chunk arms nothing', () => {
        const frames: Buffer[] = [];
        const splitter = new FrameSplitter((chunk) => frames.push(chunk), BUNDLE_BYTES);

        splitter.push(Buffer.alloc(0));
        jest.advanceTimersByTime(BUNDLE_MILLIS * 2);

        expect(frames).toHaveLength(0);
    });
});

describe('the raw bundle size', () => {
    // Base64 costs 33%. A bundle sized at the frame cap would produce a frame a third over it, and
    // an oversized frame closes the socket rather than truncating.
    test('its base64 fits inside max_frame_bytes, envelope included', () => {
        for (const maxFrameBytes of [8192, 32768, 65536]) {
            const raw = rawBundleBytes(maxFrameBytes);
            const encoded = Buffer.alloc(raw).toString('base64').length;
            expect(encoded).toBeLessThan(maxFrameBytes);
        }
    });

    test('a 32 KB frame carries about 24 KB of shell output', () => {
        expect(rawBundleBytes(32768)).toBeGreaterThan(23000);
        expect(rawBundleBytes(32768)).toBeLessThan(24576);
    });

    test('a frame cap with no room for a payload is refused', () => {
        expect(() => rawBundleBytes(64)).toThrow();
    });
});
