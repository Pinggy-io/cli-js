import { describe, test, expect } from '@jest/globals';
import { describeDisconnect } from '../devices/deviceAgent.js';

// The dashboard sends system/disconnect, then closes with 4001. Retrying after revoked or deleted
// would reconnect every 5 seconds forever, failing authentication each time.
describe('system/disconnect', () => {
    test.each(['revoked', 'deleted', 'replaced'])('%s stops the agent', (reason) => {
        expect(describeDisconnect(reason).outcome).toBe('terminal');
    });

    test('revoked says the credential was revoked', () => {
        expect(describeDisconnect('revoked').message).toMatch(/credential revoked/i);
    });

    test('deleted says the device was deleted', () => {
        expect(describeDisconnect('deleted').message).toMatch(/device deleted/i);
    });

    test('shutdown is the only reason that reconnects', () => {
        expect(describeDisconnect('shutdown').outcome).toBe('retry');
    });

    test('a reason this build has never heard of stops the agent and names the reason', () => {
        const { outcome, message } = describeDisconnect('some-future-reason');
        expect(outcome).toBe('terminal');
        expect(message).toContain('some-future-reason');
    });
});
