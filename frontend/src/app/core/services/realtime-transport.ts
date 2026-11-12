import { Socket, io } from 'socket.io-client';

/**
 * The live connection behind RealtimeService. Two implementations with one contract:
 * - `SocketIoTransport`: the Node API's Socket.IO server (until the switch-over).
 * - `DjangoSocketTransport`: the Django API's plain WebSocket at `/ws/` (Channels).
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
    });
    this.socket.on('connect', () => this.events.fire('connect'));
    for (const event of SERVER_EVENTS)
      this.socket.on(event, (data: unknown) => this.events.fire(event, data));
    this.socket.on('disconnect', (reason) => {
      this.events.fire('disconnect');
      if (reason === 'io server disconnect') this.events.fire('unauthorized');
    });
    this.socket.on('connect_error', () => {
      this.events.fire('disconnect');
      if (!this.socket.active) this.events.fire('unauthorized');
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

/** Close code the Django server uses for a missing, invalid or expired token. */
export const CLOSE_UNAUTHORIZED = 4401;
const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;

interface Pending {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Django Channels socket. Protocol (backend-django/apps/realtime/consumers.py):
 * `{type: 'auth', token}` first, then `{type: 'ready'}`; requests carry an `id` and are answered
 * by `{type: 'ack', id, data}`; server events are `{type: <event>, data}`.
 * Network drops reconnect with backoff; a 4401 close asks for a fresh token instead.
 */
export class DjangoSocketTransport implements RealtimeTransport {
  private readonly events = new Emitter();
  private readonly pending = new Map<number, Pending>();
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private nextId = 1;
  private attempts = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly token: () => string | null,
    private readonly createSocket: (url: string) => WebSocket = (u) => new WebSocket(u),
  ) {
    this.open();
  }

  get isConnected(): boolean {
    return this.ready;
  }

  on(event: string, handler: Handler): void {
    this.events.on(event, handler);
  }

  off(event: string, handler: Handler): void {
    this.events.off(event, handler);
  }

  request<T>(type: string, data: unknown, timeoutMs: number): Promise<T> {
    const ws = this.ws;
    if (!this.ready || !ws) return Promise.reject(new Error('Not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Timed out'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type, id, data }));
    });
  }

  send(type: string, data: unknown): void {
    if (this.ready) this.ws?.send(JSON.stringify({ type, data }));
  }

  reconnect(): void {
    this.closed = false;
    this.clearRetry();
    this.drop();
    this.open();
  }

  close(): void {
    this.closed = true;
    this.clearRetry();
    this.drop();
  }

  private open(): void {
    const ws = this.createSocket(this.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.token() }));
    ws.onmessage = (message) => this.receive(message.data);
    ws.onclose = (event) => {
      if (this.ws !== ws) return; // an old socket we replaced
      this.ws = null;
      this.lost();
      if (this.closed) return;
      if (event.code === CLOSE_UNAUTHORIZED) this.events.fire('unauthorized');
      else this.scheduleRetry();
    };
  }

  private receive(raw: unknown): void {
    let frame: { type?: string; id?: number; data?: unknown };
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (frame.type) {
      case 'ready':
        this.ready = true;
        this.attempts = 0;
        this.heartbeat = setInterval(() => this.ws?.send('{"type":"ping"}'), HEARTBEAT_MS);
        this.events.fire('connect');
        return;
      case 'ack': {
        const pending = frame.id === undefined ? undefined : this.pending.get(frame.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(frame.id!);
        pending.resolve(frame.data);
        return;
      }
      case 'pong':
      case 'error':
        return;
      default:
        if (frame.type) this.events.fire(frame.type, frame.data);
    }
  }

  /** Detach and close the current socket without triggering a reconnect. */
  private drop(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.close(1000);
    }
    this.lost();
  }

  private lost(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Disconnected'));
      this.pending.delete(id);
    }
    if (this.ready) {
      this.ready = false;
      this.events.fire('disconnect');
    }
  }

  private scheduleRetry(): void {
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed) this.open();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
