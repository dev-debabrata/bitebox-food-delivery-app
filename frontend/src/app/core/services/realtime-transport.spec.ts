import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_UNAUTHORIZED, DjangoSocketTransport } from './realtime-transport';

/** Just enough of a browser WebSocket for the transport. */
class FakeSocket {
  sent: unknown[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code: number): void {
    this.closedWith = code;
  }
  // test helpers
  serverOpens(): void {
    this.onopen?.();
  }
  serverSends(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverCloses(code: number): void {
    this.onclose?.({ code });
  }
}

describe('DjangoSocketTransport', () => {
  let sockets: FakeSocket[];
  let transport: DjangoSocketTransport;
  const latest = () => sockets[sockets.length - 1];

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    transport = new DjangoSocketTransport(
      'ws://api.test/ws/',
      () => 'token-1',
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    );
  });

  afterEach(() => {
    transport.close();
    vi.useRealTimers();
  });

  function signIn(): void {
    latest().serverOpens();
    latest().serverSends({ type: 'ready' });
  }

  it('signs in with the first frame and reports connect only once ready', () => {
    const connected = vi.fn();
    transport.on('connect', connected);
    latest().serverOpens();
    expect(latest().sent).toEqual([{ type: 'auth', token: 'token-1' }]);
    expect(transport.isConnected).toBe(false);
    latest().serverSends({ type: 'ready' });
    expect(transport.isConnected).toBe(true);
    expect(connected).toHaveBeenCalledTimes(1);
  });

  it('delivers server events and answers requests by id', async () => {
    signIn();
    const events = vi.fn();
    transport.on('order:updated', events);
    latest().serverSends({ type: 'order:updated', data: { id: 'o1', status: 'confirmed' } });
    expect(events).toHaveBeenCalledWith({ id: 'o1', status: 'confirmed' });

    const answer = transport.request('track:join', { orderId: 'o1' }, 5000);
    const sent = latest().sent.at(-1) as { type: string; id: number; data: unknown };
    expect(sent).toEqual({ type: 'track:join', id: sent.id, data: { orderId: 'o1' } });
    latest().serverSends({ type: 'ack', id: sent.id, data: { ok: true, tracking: true } });
    await expect(answer).resolves.toEqual({ ok: true, tracking: true });
  });

  it('times out unanswered requests and refuses them while offline', async () => {
    await expect(transport.request('rider:location', {}, 100)).rejects.toThrow('Not connected');
    signIn();
    const answer = transport.request('rider:location', {}, 100);
    vi.advanceTimersByTime(101);
    await expect(answer).rejects.toThrow('Timed out');
  });

  it('asks for a fresh token on 4401 instead of retrying with the old one', () => {
    signIn();
    const unauthorized = vi.fn();
    const disconnected = vi.fn();
    transport.on('unauthorized', unauthorized);
    transport.on('disconnect', disconnected);
    latest().serverCloses(CLOSE_UNAUTHORIZED);
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1); // no automatic retry

    transport.reconnect(); // after the refresh
    expect(sockets).toHaveLength(2);
  });

  it('reconnects with backoff after a network drop, and not after close()', () => {
    signIn();
    latest().serverCloses(1006);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    latest().serverCloses(1006);
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3); // 2 s the second time

    transport.close();
    expect(latest().closedWith).toBe(1000);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(3);
  });

  it('sends heartbeats while connected and drops fire-and-forget frames while offline', () => {
    transport.send('track:leave', { orderId: 'o1' });
    expect(latest().sent).toEqual([]);
    signIn();
    vi.advanceTimersByTime(25_000);
    expect(latest().sent.at(-1)).toEqual({ type: 'ping' });
    transport.send('track:leave', { orderId: 'o1' });
    expect(latest().sent.at(-1)).toEqual({ type: 'track:leave', data: { orderId: 'o1' } });
  });
});
