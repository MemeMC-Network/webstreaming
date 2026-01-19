/**
 * Socket.IO Serverless Handler for Vercel
 * Handles WebRTC signaling for peer-to-peer screen sharing
 */

const { Server } = require('socket.io');

// Store active rooms and peers
const rooms = new Map();
const peers = new Map();

let io;

module.exports = (req, res) => {
  if (!res.socket.server.io) {
    console.log('Initializing Socket.IO server...');
    
    io = new Server(res.socket.server, {
      path: '/socket.io',
      addTrailingSlash: false,
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true
      },
      transports: ['polling', 'websocket'],
      allowEIO3: true,
      // Optimize for Vercel serverless
      pingTimeout: 60000,
      pingInterval: 25000,
      upgradeTimeout: 30000,
      maxHttpBufferSize: 1e8,
      perMessageDeflate: false,
      // Important for serverless
      connectTimeout: 45000,
      httpCompression: false
    });

    io.on('connection', (socket) => {
      console.log(`Client connected: ${socket.id}`);

      // Generate or join room with sharing code
      socket.on('generate-code', (callback) => {
        const code = generateSharingCode();
        rooms.set(code, {
          host: socket.id,
          viewer: null,
          createdAt: Date.now()
        });
        peers.set(socket.id, { code, role: 'host' });
        socket.join(code);
        
        console.log(`Room created: ${code} by ${socket.id}`);
        callback({ success: true, code });
      });

      // Join room as viewer
      socket.on('join-room', (code, callback) => {
        const room = rooms.get(code);
        
        if (!room) {
          return callback({ success: false, message: 'Invalid sharing code' });
        }
        
        if (room.viewer) {
          return callback({ success: false, message: 'Room is full' });
        }

        room.viewer = socket.id;
        peers.set(socket.id, { code, role: 'viewer' });
        socket.join(code);
        
        console.log(`Viewer ${socket.id} joined room ${code}`);
        
        // Notify host that viewer joined
        io.to(room.host).emit('viewer-joined', socket.id);
        
        callback({ success: true, hostId: room.host });
      });

      // WebRTC signaling - offer
      socket.on('offer', (data) => {
        console.log(`Offer from ${socket.id} to ${data.to}`);
        io.to(data.to).emit('offer', {
          offer: data.offer,
          from: socket.id
        });
      });

      // WebRTC signaling - answer
      socket.on('answer', (data) => {
        console.log(`Answer from ${socket.id} to ${data.to}`);
        io.to(data.to).emit('answer', {
          answer: data.answer,
          from: socket.id
        });
      });

      // WebRTC signaling - ICE candidate
      socket.on('ice-candidate', (data) => {
        console.log(`ICE candidate from ${socket.id} to ${data.to}`);
        io.to(data.to).emit('ice-candidate', {
          candidate: data.candidate,
          from: socket.id
        });
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        
        const peer = peers.get(socket.id);
        if (peer) {
          const room = rooms.get(peer.code);
          if (room) {
            if (room.host === socket.id) {
              // Host disconnected, notify viewer and close room
              if (room.viewer) {
                io.to(room.viewer).emit('host-disconnected');
              }
              rooms.delete(peer.code);
            } else if (room.viewer === socket.id) {
              // Viewer disconnected
              room.viewer = null;
              io.to(room.host).emit('viewer-disconnected');
            }
          }
          peers.delete(socket.id);
        }
      });
    });

    // Cleanup old rooms every 5 minutes
    setInterval(() => {
      const now = Date.now();
      const ONE_HOUR = 60 * 60 * 1000;
      
      for (const [code, room] of rooms.entries()) {
        if (now - room.createdAt > ONE_HOUR) {
          rooms.delete(code);
          console.log(`Cleaned up expired room: ${code}`);
        }
      }
    }, 5 * 60 * 1000);

    res.socket.server.io = io;
  }
  
  res.end();
};

/**
 * Generate random sharing code
 */
function generateSharingCode() {
  const part1 = Math.floor(Math.random() * 900 + 100);
  const part2 = Math.floor(Math.random() * 900 + 100);
  const part3 = Math.floor(Math.random() * 900 + 100);
  return `${part1}-${part2}-${part3}`;
}
