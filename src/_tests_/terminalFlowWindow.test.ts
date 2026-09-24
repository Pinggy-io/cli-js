import { describe, expect, test } from '@jest/globals';
import { FlowWindow } from '../devices/terminal/flowWindow.js';

const WINDOW = 1000;

describe('the terminal flow window', () => {
    test('remaining is window minus what is in flight', () => {
        const window = new FlowWindow(WINDOW);
        expect(window.remaining()).toBe(WINDOW);

        window.recordSent(400);
        expect(window.remaining()).toBe(600);

        window.recordAck(250);
        expect(window.remaining()).toBe(850);
    });

    test('a full window reads 0 and closes, which is what stops the read loop', () => {
        const window = new FlowWindow(WINDOW);
        window.recordSent(WINDOW);

        expect(window.remaining()).toBe(0);
        expect(window.isOpen()).toBe(false);

        window.recordAck(1);
        expect(window.isOpen()).toBe(true);
    });

    test('remaining never goes negative, even when a frame overshoots the window', () => {
        const window = new FlowWindow(WINDOW);
        window.recordSent(WINDOW + 500);

        expect(window.remaining()).toBe(0);
        expect(window.isOpen()).toBe(false);
    });

    // The property the whole design leans on: acks are cumulative totals, not increments.
    test('a dropped ack self-heals on the next one', () => {
        const window = new FlowWindow(WINDOW);
        window.recordSent(900);

        // The ack for 300 never arrives. The next one carries the full total anyway.
        window.recordAck(600);

        expect(window.acked).toBe(600);
        expect(window.remaining()).toBe(700);
    });

    test('an ack beyond what was sent is clamped, not believed', () => {
        const window = new FlowWindow(WINDOW);
        window.recordSent(100);

        window.recordAck(999999);

        expect(window.acked).toBe(100);
        expect(window.remaining()).toBe(WINDOW);
    });

    test('an out-of-order ack never moves the counter backwards', () => {
        const window = new FlowWindow(WINDOW);
        window.recordSent(900);
        window.recordAck(700);

        window.recordAck(300);

        expect(window.acked).toBe(700);
    });

    test('a nonsense ack is ignored rather than throwing', () => {
        const window = new FlowWindow(WINDOW);
        window.recordSent(500);
        window.recordAck(400);

        window.recordAck(Number.NaN);
        window.recordAck(-1);

        expect(window.acked).toBe(400);
    });

    test('a window needs a size from welcome, and refuses to invent one', () => {
        expect(() => new FlowWindow(0)).toThrow();
        expect(() => new FlowWindow(Number.NaN)).toThrow();
        expect(() => new FlowWindow(-262144)).toThrow();
    });
});
