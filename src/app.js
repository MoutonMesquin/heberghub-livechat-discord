// Assemblage HTTP + Socket.IO + chat, sans démarrer l'écoute (utilisé par server.js et les tests).

import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { attachChat, compileTrust, connectionFilter } from './chat.js';
import { createHttpApp } from './http.js';

export function createApp({ config, discord, logger }) {
  const app = createHttpApp({ config, discord });
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: config.allowedOrigins, methods: ['GET', 'POST'] },
    allowRequest: connectionFilter({ allowedOrigins: config.allowedOrigins, trust: compileTrust(config.trustProxy) }),
    maxHttpBufferSize: 16 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });
  io.engine.on('connection_error', (err) => logger.debug('socket_rejected', { code: err.code, detail: err.message }));
  const chat = attachChat({ io, config, discord, logger });

  return {
    httpServer,
    io,
    chat,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer.address())));
    },
    async close() {
      await chat.close();
      await new Promise((resolve) => io.close(() => resolve()));
    },
  };
}
