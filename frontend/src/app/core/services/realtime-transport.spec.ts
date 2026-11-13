import { describe, expect, it } from 'vitest';
import { NoopRealtimeTransport } from './realtime-transport';

describe('NoopRealtimeTransport', () => {
  it('instantiates disconnected and safely rejects requests', async () => {
    const transport = new NoopRealtimeTransport();
    expect(transport.isConnected).toBe(false);
    await expect(transport.request('test', {}, 1000)).rejects.toThrow('Realtime transport is disabled');
    // Ensure harmless calls do not throw
    transport.send('test', {});
    transport.reconnect();
    transport.close();
  });
});
