import * as net from 'net';

export type NdjsonHandler = (event: unknown, rawLine: string) => void;

/**
 * Minimal NDJSON server. It listens on a random port on 127.0.0.1 only, so the
 * recording stays inside the machine. The port is handed to gdb through the
 * STACKVIZ_PORT environment variable.
 */
export class NdjsonServer {
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();
  private port = 0;
  private listening = false;

  public get boundPort(): number {
    return this.port;
  }

  public start(onEvent: NdjsonHandler): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (this.server) {
        reject(new Error('The StackViz TCP server is already running.'));
        return;
      }

      const server = net.createServer((socket) => {
        this.sockets.add(socket);
        socket.setEncoding('utf8');

        let buffer = '';
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          let index = buffer.indexOf('\n');
          while (index >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            this.dispatch(line, onEvent);
            index = buffer.indexOf('\n');
          }
          // Guard against a peer that never sends a newline.
          if (buffer.length > 4 * 1024 * 1024) {
            buffer = '';
          }
        });
        socket.on('error', () => {
          // The peer went away; the session teardown handles the rest.
        });
        socket.on('close', () => {
          this.sockets.delete(socket);
          if (buffer.trim().length > 0) {
            this.dispatch(buffer, onEvent);
          }
          buffer = '';
        });
      });

      server.on('error', (error) => {
        if (!this.listening) {
          reject(error);
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          this.listening = true;
          this.port = address.port;
          resolve(this.port);
        } else {
          reject(new Error('Could not determine the port of the StackViz TCP server.'));
        }
      });

      this.server = server;
    });
  }

  public stop(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    this.listening = false;
  }

  private dispatch(line: string, onEvent: NdjsonHandler): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      onEvent(undefined, trimmed);
      return;
    }
    onEvent(parsed, trimmed);
  }
}
