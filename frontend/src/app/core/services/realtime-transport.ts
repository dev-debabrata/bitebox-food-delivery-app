import { Socket, io } from 'socket.io-client';

/**
 * The live connection behind RealtimeService:
 * - `SocketIoTransport`: the Node API's Socket.IO server.
 * - `NoopRealtimeTransport`: harmless no-op transport when realtime is disabled.
 *
 * Lifecycle events are delivered like server events: `connect` (signed in and ready),
 * `disconnect`, and `unauthorized` (the server refused the token: refresh it and `reconnect()`).
 */
export interface RealtimeTransport {
  readonly isConnected: boolean;
  on(event: string, handler: (data: any) => void): void;
  off(event: string, handler: (data: any) => void): void;
  /** A request the server acknowledges (Socket.IO `emitWithAck`). Rejects on timeout. */
  request<T>(type: string, data: unknown, timeoutMs: number): Promise<T>;
  /** Fire and forget. Dropped when not connected. */
  send(type: string, data: unknown): void;
  reconnect(): void;
  close(): void;
}

type Handler = (data: any) => void;

class Emitter {
  private readonly handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
  }

  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }

  fire(event: string, data?: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
  }
}

export class NoopRealtimeTransport implements RealtimeTransport {
  readonly isConnected = false;
  on(_event: string, _handler: (data: any) => void): void {}
  off(_event: string, _handler: (data: any) => void): void {}
  request<T>(_type: string, _data: unknown, _timeoutMs = 5000): Promise<T> {
    return Promise.reject(new Error('Realtime transport is disabled'));
  }
  send(_type: string, _data: unknown): void {}
  reconnect(): void {}
  close(): void {}
}

/** Server events forwarded from Socket.IO. */
const SERVER_EVENTS = ['order:updated', 'order:location', 'notification:new'];

export class SocketIoTransport implements RealtimeTransport {
  private readonly events = new Emitter();
  private readonly socket: Socket;

  constructor(origin: string, token: () => string | null) {
    this.socket = io(origin, {
      path: '/socket.io',
      auth: (cb) => cb({ token: token() }),
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 3,
    });
    this.socket.on('connect', () => this.events.fire('connect'));
    for (const event of SERVER_EVENTS)
      this.socket.on(event, (data: unknown) => this.events.fire(event, data));
    this.socket.on('disconnect', (reason) => {
      this.events.fire('disconnect');
      if (reason === 'io server disconnect') this.events.fire('unauthorized');
    });
    this.socket.on('connect_error', (err) => {
      this.events.fire('disconnect');
      if (err?.message && /unauthorized|jwt|token|forbidden/i.test(err.message)) {
        this.events.fire('unauthorized');
      }
    });
  }

  get isConnected(): boolean {
    return this.socket.connected;
  }

  on(event: string, handler: Handler): void {
    this.events.on(event, handler);
  }

  off(event: string, handler: Handler): void {
    this.events.off(event, handler);
  }

  request<T>(type: string, data: unknown, timeoutMs: number): Promise<T> {
    return this.socket.timeout(timeoutMs).emitWithAck(type, data) as Promise<T>;
  }

  send(type: string, data: unknown): void {
    if (this.socket.connected) this.socket.emit(type, data);
  }

  reconnect(): void {
    this.socket.connect();
  }

  close(): void {
    this.socket.disconnect();
  }
}
