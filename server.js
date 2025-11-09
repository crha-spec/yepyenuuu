const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// ✅ RENDER SELF-PING - 1 DAKİKA UYUMA SORUNU ÇÖZÜMÜ
const RENDER_SELF_PING_INTERVAL = 50000;
let selfPingUrl = null;

function startRenderSelfPing() {
  if (process.env.RENDER) {
    selfPingUrl = process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
    
    setInterval(async () => {
      try {
        const fetch = (await import('node-fetch')).default;
        await fetch(`${selfPingUrl}/health`, { 
          method: 'GET',
          timeout: 5000 
        });
        console.log(`❤️ Self-ping: ${new Date().toLocaleTimeString()}`);
      } catch (error) {
        console.log('⚠️ Self-ping failed:', error.message);
      }
    }, RENDER_SELF_PING_INTERVAL);
    
    console.log(`🔄 RENDER SELF-PING ACTIVE: ${selfPingUrl}`);
  }
}

// ✅ BELLEK TABANLI SİSTEM
const rooms = new Map();
const users = new Map();
const messages = new Map();
const pendingOffers = new Map();
const activeCalls = new Map();
const screenShareRequests = new Map();
const userPlaylists = new Map();
const connectionMonitor = new Map();

// ✅ STUN SUNUCULARI
function getIceServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.services.mozilla.com' },
    { urls: 'stun:stun.stunprotocol.org:3478' }
  ];
}

// ✅ SOCKET.IO - RENDER İÇİN OPTİMİZE
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 100 * 1024 * 1024,
  pingTimeout: 30000,
  pingInterval: 12000,
  connectTimeout: 20000,
  allowUpgrades: true
});

// Yardımcı Fonksiyonlar
function generateRoomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function generateUserColor(username) {
  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7'];
  const index = username ? username.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) : 0;
  return colors[index % colors.length];
}

function extractYouTubeId(url) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

function updateUserList(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  const userList = Array.from(room.users.values()).map(user => ({
    id: user.id,
    userName: user.userName,
    userPhoto: user.userPhoto,
    userColor: user.userColor,
    isOwner: user.isOwner,
    country: user.country,
    isInCall: activeCalls.has(user.id)
  }));
  
  io.to(roomCode).emit('user-list-update', userList);
}

// ✅ BAĞLANTI SAĞLIK KONTROLÜ
function startConnectionHealthCheck() {
  setInterval(() => {
    const now = Date.now();
    
    for (const [socketId, connection] of connectionMonitor.entries()) {
      const timeSinceLastPing = now - connection.lastPing;
      
      if (timeSinceLastPing > 40000) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          console.log(`🔌 Timeout disconnect: ${socketId}`);
          socket.disconnect(true);
        }
        connectionMonitor.delete(socketId);
      }
    }
  }, 20000);
}

// Middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ✅ RENDER HEALTH CHECK
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    connections: connectionMonitor.size,
    rooms: rooms.size,
    users: users.size,
    activeCalls: activeCalls.size,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
  });
});

// ✅ RENDER BUILD HOOK
app.post('/render-build-hook', (req, res) => {
  console.log('🔨 Render build hook received');
  res.status(200).json({ status: 'received' });
});

// Socket.io Events
io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);
  
  connectionMonitor.set(socket.id, {
    userName: 'Anonymous',
    roomCode: null,
    lastPing: Date.now(),
    connectedAt: Date.now()
  });

  socket.emit('ice-servers', { servers: getIceServers() });

  let currentUser = null;
  let currentRoomCode = null;

  // ✅ PING-PONG SİSTEMİ
  const pingInterval = setInterval(() => {
    if (socket.connected) {
      socket.emit('ping', { timestamp: Date.now() });
      
      const conn = connectionMonitor.get(socket.id);
      if (conn) {
        conn.lastPing = Date.now();
        connectionMonitor.set(socket.id, conn);
      }
    }
  }, 10000);

  socket.on('pong', () => {
    const conn = connectionMonitor.get(socket.id);
    if (conn) {
      conn.lastPing = Date.now();
      connectionMonitor.set(socket.id, conn);
    }
  });

  // 🎯 ODA OLUŞTURMA
  socket.on('create-room', (data) => {
    try {
      const { userName, userPhoto, roomName, password } = data;
      
      let roomCode;
      do {
        roomCode = generateRoomCode();
      } while (rooms.has(roomCode));
      
      const room = {
        code: roomCode,
        name: roomName,
        password: password || null,
        owner: socket.id,
        users: new Map(),
        video: null,
        playbackState: { playing: false, currentTime: 0, playbackRate: 1 },
        messages: [],
        createdAt: new Date(),
        screenSharing: null
      };
      
      currentUser = {
        id: socket.id,
        userName: userName,
        userPhoto: userPhoto || `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="${generateUserColor(userName)}" width="100" height="100"/><text x="50" y="60" font-size="40" text-anchor="middle" fill="white">${userName.charAt(0)}</text></svg>`,
        userColor: generateUserColor(userName),
        isOwner: true,
        country: 'Türkiye'
      };
      
      room.users.set(socket.id, currentUser);
      rooms.set(roomCode, room);
      users.set(socket.id, { roomCode, ...currentUser });
      
      currentRoomCode = roomCode;
      socket.join(roomCode);
      
      connectionMonitor.set(socket.id, {
        ...connectionMonitor.get(socket.id),
        userName: userName,
        roomCode: roomCode
      });
      
      const shareableLink = `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000'}?room=${roomCode}`;
      
      socket.emit('room-created', {
        roomCode,
        roomName,
        isOwner: true,
        shareableLink,
        userColor: currentUser.userColor
      });
      
      console.log(`✅ Room created: ${roomCode} by ${userName}`);
      
    } catch (error) {
      console.error('❌ Create room error:', error);
      socket.emit('error', { message: 'Oda oluşturulamadı!' });
    }
  });

  // 🔑 ODAYA KATILMA
  socket.on('join-room', (data) => {
    try {
      const { roomCode, userName, userPhoto, password } = data;
      const room = rooms.get(roomCode.toUpperCase());
      
      if (!room) {
        socket.emit('error', { message: 'Oda bulunamadı!' });
        return;
      }
      
      if (room.password && room.password !== password) {
        socket.emit('error', { message: 'Şifre yanlış!' });
        return;
      }
      
      currentUser = {
        id: socket.id,
        userName: userName,
        userPhoto: userPhoto || `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="${generateUserColor(userName)}" width="100" height="100"/><text x="50" y="60" font-size="40" text-anchor="middle" fill="white">${userName.charAt(0)}</text></svg>`,
        userColor: generateUserColor(userName),
        isOwner: room.owner === socket.id,
        country: 'Türkiye'
      };
      
      room.users.set(socket.id, currentUser);
      users.set(socket.id, { roomCode, ...currentUser });
      currentRoomCode = roomCode;
      socket.join(roomCode);
      
      connectionMonitor.set(socket.id, {
        ...connectionMonitor.get(socket.id),
        userName: userName,
        roomCode: roomCode
      });
      
      const roomMessages = messages.get(roomCode) || [];
      
      socket.emit('room-joined', {
        roomCode: room.code,
        roomName: room.name,
        isOwner: room.owner === socket.id,
        userColor: currentUser.userColor,
        previousMessages: roomMessages.slice(-50),
        activeVideo: room.video,
        playbackState: room.playbackState,
        screenSharing: room.screenSharing
      });
      
      socket.to(roomCode).emit('user-joined', { userName: currentUser.userName });
      updateUserList(roomCode);
      
      console.log(`✅ User joined: ${userName} -> ${roomCode}`);
      
    } catch (error) {
      console.error('❌ Join room error:', error);
      socket.emit('error', { message: 'Odaya katılamadı!' });
    }
  });

  // 🎬 VIDEO YÜKLEME
  socket.on('upload-video', (data) => {
    try {
      if (!currentRoomCode || !currentUser || !currentUser.isOwner) {
        socket.emit('error', { message: 'Yetkiniz yok' });
        return;
      }
      
      const { videoBase64, title } = data;
      const room = rooms.get(currentRoomCode);
      
      room.video = {
        url: videoBase64,
        title: title || 'Video',
        uploadedBy: currentUser.userName,
        uploadedAt: new Date()
      };
      
      io.to(currentRoomCode).emit('video-uploaded', {
        videoUrl: videoBase64,
        title: title || 'Video',
        uploadedBy: currentUser.userName
      });
      
      socket.emit('upload-progress', { status: 'completed', progress: 100 });
      
    } catch (error) {
      console.error('❌ Upload error:', error);
      socket.emit('error', { message: 'Video yüklenemedi!' });
    }
  });

  // 📺 YOUTUBE PAYLAŞMA
  socket.on('share-youtube-link', (data) => {
    try {
      if (!currentRoomCode || !currentUser) return;
      
      const { youtubeUrl, title } = data;
      const videoId = extractYouTubeId(youtubeUrl);
      const room = rooms.get(currentRoomCode);
      
      if (!videoId) {
        socket.emit('error', { message: 'Geçersiz YouTube linki' });
        return;
      }
      
      room.video = {
        type: 'youtube',
        videoId: videoId,
        url: youtubeUrl,
        title: title || 'YouTube Video',
        uploadedBy: currentUser.userName
      };

      room.playbackState = {
        playing: true,
        currentTime: 0,
        playbackRate: 1,
        videoId: videoId
      };
      
      io.to(currentRoomCode).emit('youtube-video-shared', {
        videoId: videoId,
        title: title || 'YouTube Video',
        sharedBy: currentUser.userName,
        playbackState: room.playbackState
      });
      
    } catch (error) {
      console.error('❌ YouTube share error:', error);
    }
  });

  // 🎮 VIDEO KONTROLÜ
  socket.on('video-control', (controlData) => {
    if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
    
    const room = rooms.get(currentRoomCode);
    room.playbackState = { ...room.playbackState, ...controlData };
    
    io.to(currentRoomCode).emit('video-control', room.playbackState);
  });

  socket.on('youtube-control', (controlData) => {
    if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
    
    const room = rooms.get(currentRoomCode);
    room.playbackState = { ...room.playbackState, ...controlData };
    
    socket.to(currentRoomCode).emit('youtube-control', room.playbackState);
  });

  // 🗑️ VIDEO SİLME
  socket.on('delete-video', () => {
    if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
    
    const room = rooms.get(currentRoomCode);
    room.video = null;
    room.playbackState = { playing: false, currentTime: 0, playbackRate: 1 };
    
    io.to(currentRoomCode).emit('video-deleted');
  });

  // 📨 MESAJ GÖNDERME
  socket.on('message', (messageData) => {
    try {
      if (!currentRoomCode || !currentUser) return;
      
      const message = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
        userName: currentUser.userName,
        userPhoto: currentUser.userPhoto,
        userColor: currentUser.userColor,
        text: messageData.text,
        type: messageData.type || 'text',
        fileUrl: messageData.fileUrl,
        fileName: messageData.fileName,
        fileSize: messageData.fileSize,
        time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        country: currentUser.country,
        timestamp: new Date(),
        edited: false,
        deleted: false,
        reactions: {},
        seenBy: [currentUser.userName]
      };
      
      const roomMessages = messages.get(currentRoomCode) || [];
      roomMessages.push(message);
      
      if (roomMessages.length > 100) {
        messages.set(currentRoomCode, roomMessages.slice(-100));
      } else {
        messages.set(currentRoomCode, roomMessages);
      }
      
      io.to(currentRoomCode).emit('message', message);
      
    } catch (error) {
      console.error('❌ Message error:', error);
    }
  });

  // ✏️ MESAJ DÜZENLEME
  socket.on('edit-message', (data) => {
    try {
      const { messageId, newText } = data;
      if (!currentRoomCode || !currentUser) return;
      
      const roomMessages = messages.get(currentRoomCode) || [];
      const messageIndex = roomMessages.findIndex(msg => msg.id === messageId);
      
      if (messageIndex !== -1 && roomMessages[messageIndex].userName === currentUser.userName) {
        roomMessages[messageIndex].text = newText;
        roomMessages[messageIndex].edited = true;
        roomMessages[messageIndex].editTime = new Date().toLocaleTimeString('tr-TR');
        
        io.to(currentRoomCode).emit('message-edited', {
          messageId: messageId,
          newText: newText,
          editTime: roomMessages[messageIndex].editTime
        });
      }
    } catch (error) {
      console.error('❌ Edit message error:', error);
    }
  });

  // 🗑️ MESAJ SİLME
  socket.on('delete-message', (data) => {
    try {
      const { messageId } = data;
      if (!currentRoomCode || !currentUser) return;
      
      const roomMessages = messages.get(currentRoomCode) || [];
      const messageIndex = roomMessages.findIndex(msg => msg.id === messageId);
      
      if (messageIndex !== -1 && roomMessages[messageIndex].userName === currentUser.userName) {
        roomMessages[messageIndex].deleted = true;
        roomMessages[messageIndex].deletedTime = new Date().toLocaleTimeString('tr-TR');
        
        io.to(currentRoomCode).emit('message-deleted', {
          messageId: messageId,
          deletedBy: currentUser.userName,
          deletedTime: roomMessages[messageIndex].deletedTime
        });
      }
    } catch (error) {
      console.error('❌ Delete message error:', error);
    }
  });

  // ❤️ MESAJ REAKSİYONU
  socket.on('message-reaction', (data) => {
    try {
      const { messageId, reaction } = data;
      if (!currentRoomCode || !currentUser) return;
      
      const roomMessages = messages.get(currentRoomCode) || [];
      const messageIndex = roomMessages.findIndex(msg => msg.id === messageId);
      
      if (messageIndex !== -1) {
        if (!roomMessages[messageIndex].reactions) {
          roomMessages[messageIndex].reactions = {};
        }
        
        if (roomMessages[messageIndex].reactions[currentUser.userName] === reaction) {
          delete roomMessages[messageIndex].reactions[currentUser.userName];
        } else {
          roomMessages[messageIndex].reactions[currentUser.userName] = reaction;
        }
        
        io.to(currentRoomCode).emit('message-reaction-updated', {
          messageId: messageId,
          reactions: roomMessages[messageIndex].reactions
        });
      }
    } catch (error) {
      console.error('❌ Message reaction error:', error);
    }
  });

  // 👀 MESAJ GÖRÜLDÜ
  socket.on('message-seen', (data) => {
    try {
      const { messageId } = data;
      if (!currentRoomCode || !currentUser) return;
      
      const roomMessages = messages.get(currentRoomCode) || [];
      const messageIndex = roomMessages.findIndex(msg => msg.id === messageId);
      
      if (messageIndex !== -1 && !roomMessages[messageIndex].seenBy.includes(currentUser.userName)) {
        roomMessages[messageIndex].seenBy.push(currentUser.userName);
        
        io.to(currentRoomCode).emit('message-seen-updated', {
          messageId: messageId,
          seenBy: roomMessages[messageIndex].seenBy
        });
      }
    } catch (error) {
      console.error('❌ Message seen error:', error);
    }
  });

  // 🖥️ EKRAN PAYLAŞIMI İSTEĞİ
  socket.on('request-screen-share', () => {
    try {
      if (!currentRoomCode || !currentUser) return;
      
      const room = rooms.get(currentRoomCode);
      if (!room) return;
      
      let ownerSocketId = null;
      room.users.forEach((user, socketId) => {
        if (user.isOwner) {
          ownerSocketId = socketId;
        }
      });
      
      if (ownerSocketId) {
        screenShareRequests.set(socket.id, {
          requesterName: currentUser.userName,
          requesterSocketId: socket.id,
          roomCode: currentRoomCode,
          timestamp: new Date()
        });
        
        io.to(ownerSocketId).emit('screen-share-request', {
          requesterName: currentUser.userName,
          requesterSocketId: socket.id
        });
      }
    } catch (error) {
      console.error('❌ Screen share request error:', error);
    }
  });

  // 🖥️ EKRAN PAYLAŞIMI ONAYI
  socket.on('approve-screen-share', (data) => {
    try {
      const { requesterSocketId } = data;
      if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
      
      const request = screenShareRequests.get(requesterSocketId);
      if (request) {
        const room = rooms.get(currentRoomCode);
        room.screenSharing = {
          userName: request.requesterName,
          socketId: requesterSocketId,
          startedAt: new Date()
        };
        
        io.to(requesterSocketId).emit('screen-share-approved');
        
        io.to(currentRoomCode).emit('screen-share-started', {
          userName: request.requesterName
        });
        
        screenShareRequests.delete(requesterSocketId);
      }
    } catch (error) {
      console.error('❌ Screen share approval error:', error);
    }
  });

  // 🖥️ EKRAN PAYLAŞIMI REDDİ
  socket.on('reject-screen-share', (data) => {
    try {
      const { requesterSocketId } = data;
      if (!currentRoomCode || !currentUser || !currentUser.isOwner) return;
      
      const request = screenShareRequests.get(requesterSocketId);
      if (request) {
        io.to(requesterSocketId).emit('screen-share-rejected');
        screenShareRequests.delete(requesterSocketId);
      }
    } catch (error) {
      console.error('❌ Screen share rejection error:', error);
    }
  });

  // 🖥️ EKRAN PAYLAŞIMI DURDURMA
  socket.on('stop-screen-share', () => {
    try {
      if (!currentRoomCode) return;
      
      const room = rooms.get(currentRoomCode);
      if (room && room.screenSharing) {
        const sharerName = room.screenSharing.userName;
        room.screenSharing = null;
        
        io.to(currentRoomCode).emit('screen-share-stopped', {
          userName: sharerName
        });
      }
    } catch (error) {
      console.error('❌ Stop screen share error:', error);
    }
  });

  // 📞 WEBRTC ARAMALAR
  socket.on('start-call', (data) => {
    try {
      const { targetUserName, offer, type, callerName } = data;
      console.log(`📞 Arama başlatılıyor: ${callerName} -> ${targetUserName}, Tip: ${type}`);
      
      let targetSocketId = null;
      users.forEach((user, socketId) => {
        if (user.userName === targetUserName && user.roomCode === currentRoomCode) {
          targetSocketId = socketId;
        }
      });
      
      if (targetSocketId) {
        io.to(targetSocketId).emit('ice-servers', { servers: getIceServers() });
        
        const callData = {
          callerSocketId: socket.id,
          callerName: callerName,
          targetSocketId: targetSocketId,
          targetUserName: targetUserName,
          type: type,
          roomCode: currentRoomCode,
          startTime: new Date(),
          status: 'ringing'
        };
        
        activeCalls.set(socket.id, callData);
        activeCalls.set(targetSocketId, callData);
        
        io.to(targetSocketId).emit('incoming-call', { 
          offer, 
          callerName, 
          type,
          callerSocketId: socket.id 
        });
        
        console.log(`📞 Arama bildirimi gönderildi: ${callerName} -> ${targetUserName}`);
      } else {
        socket.emit('call-error', { message: 'Kullanıcı bulunamadı' });
      }
    } catch (error) {
      console.error('❌ Start call error:', error);
      socket.emit('call-error', { message: 'Arama başlatılamadı' });
    }
  });

  socket.on('webrtc-answer', (data) => {
    try {
      const { targetSocketId, answer } = data;
      console.log(`📞 WebRTC answer gönderiliyor: ${socket.id} -> ${targetSocketId}`);
      
      if (targetSocketId) {
        io.to(targetSocketId).emit('webrtc-answer', {
          answer,
          answererSocketId: socket.id,
          answererName: currentUser?.userName
        });
      }
    } catch (error) {
      console.error('❌ WebRTC answer error:', error);
    }
  });

  socket.on('webrtc-ice-candidate', (data) => {
    try {
      const { targetSocketId, candidate } = data;
      
      if (targetSocketId) {
        io.to(targetSocketId).emit('webrtc-ice-candidate', {
          candidate,
          senderSocketId: socket.id
        });
      }
    } catch (error) {
      console.error('❌ WebRTC ICE candidate error:', error);
    }
  });

  socket.on('reject-call', (data) => {
    try {
      const { callerSocketId } = data;
      const callData = activeCalls.get(socket.id);
      
      if (callData) {
        io.to(callerSocketId).emit('call-rejected', { 
          rejectedBy: currentUser?.userName 
        });
        
        activeCalls.delete(callData.callerSocketId);
        activeCalls.delete(callData.targetSocketId);
        
        updateUserList(currentRoomCode);
        
        console.log(`❌ Arama reddedildi: ${callData.callerName} -> ${callData.targetUserName}`);
      }
    } catch (error) {
      console.error('❌ Reject call error:', error);
    }
  });

  socket.on('end-call', (data) => {
    try {
      const { targetSocketId } = data;
      const callData = activeCalls.get(socket.id);
      
      if (callData) {
        const otherPartyId = callData.callerSocketId === socket.id ? callData.targetSocketId : callData.callerSocketId;
        
        if (otherPartyId) {
          io.to(otherPartyId).emit('call-ended', { 
            endedBy: currentUser?.userName 
          });
        }
        
        activeCalls.delete(callData.callerSocketId);
        activeCalls.delete(callData.targetSocketId);
        
        updateUserList(currentRoomCode);
        
        console.log(`📞 Arama sonlandırıldı: ${callData.callerName} <-> ${callData.targetUserName}`);
      } else if (targetSocketId) {
        io.to(targetSocketId).emit('call-ended', { 
          endedBy: currentUser?.userName 
        });
        
        activeCalls.delete(socket.id);
        activeCalls.delete(targetSocketId);
        
        updateUserList(currentRoomCode);
      }
    } catch (error) {
      console.error('❌ End call error:', error);
    }
  });

  // 🔌 BAĞLANTI KESİLDİĞİNDE
  socket.on('disconnect', (reason) => {
    console.log('🔌 User disconnected:', socket.id, reason);
    
    clearInterval(pingInterval);
    connectionMonitor.delete(socket.id);
    
    const callData = activeCalls.get(socket.id);
    if (callData) {
      const otherPartyId = callData.callerSocketId === socket.id 
        ? callData.targetSocketId 
        : callData.callerSocketId;
      
      if (otherPartyId) {
        io.to(otherPartyId).emit('call-ended', { 
          endedBy: 'Sistem (bağlantı kesildi)',
          reason: 'connection_lost'
        });
        activeCalls.delete(otherPartyId);
      }
      activeCalls.delete(socket.id);
    }
    
    if (currentRoomCode) {
      const room = rooms.get(currentRoomCode);
      if (room && room.screenSharing && room.screenSharing.socketId === socket.id) {
        room.screenSharing = null;
        io.to(currentRoomCode).emit('screen-share-stopped', {
          userName: currentUser?.userName || 'Kullanıcı',
          reason: 'disconnect'
        });
      }
    }

if (currentUser && currentRoomCode) {
      const room = rooms.get(currentRoomCode);
      if (room) {
        room.users.delete(socket.id);
        users.delete(socket.id);
        
        socket.to(currentRoomCode).emit('user-left', { 
          userName: currentUser.userName 
        });
        updateUserList(currentRoomCode);
        pendingOffers.delete(socket.id);
        screenShareRequests.delete(socket.id);
        
        if (room.users.size === 0) {
          setTimeout(() => {
            if (rooms.get(currentRoomCode)?.users.size === 0) {
              rooms.delete(currentRoomCode);
              messages.delete(currentRoomCode);
              console.log(`🗑️ Empty room deleted: ${currentRoomCode}`);
            }
          }, 600000);
        }
      }
    }
  });

}); // ✅ io.on('connection') KAPANIŞI - ÇOK ÖNEMLİ!

// ========================================
// 📡 STATIC FILES & ROUTES
// ========================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========================================
// 🚀 SERVER START
// ========================================

startConnectionHealthCheck();
startRenderSelfPing();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🚀 VIDEO PLATFORM SERVER - RENDER 2025 OPTIMIZED       ║
║                                                            ║
║   📡 Port: ${PORT}                                        ║
║   ❤️  Status: HEALTHY                                     ║
║   🔄 Self-Ping: ACTIVE                                     ║
║   📞 WebRTC: ENABLED (STUN)                                ║
║   🖥️  Screen Share: ENABLED                               ║
║   💬 Chat: ADVANCED (Edit/Delete/Reactions)                ║
║   🌍 Global Reach: 300+ KM                                 ║
║   📊 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB                                      ║
║                                                            ║
║   ✅ 1 MINUTE SLEEP PROBLEM: FIXED                        ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
  console.log(`🔗 Server URL: ${selfPingUrl || `http://localhost:${PORT}`}`);
  console.log(`⏰ Started at: ${new Date().toLocaleString('tr-TR')}`);
});

// ========================================
// 🛡️ ERROR HANDLERS
// ========================================

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, closing server gracefully...');
  
  // Tüm aktif bağlantıları bilgilendir
  io.emit('server-shutdown', { message: 'Server yeniden başlatılıyor...' });
  
  server.close(() => {
    console.log('✅ Server closed successfully');
    
    // Cleanup
    rooms.clear();
    users.clear();
    messages.clear();
    activeCalls.clear();
    screenShareRequests.clear();
    connectionMonitor.clear();
    
    process.exit(0);
  });
  
  // Force shutdown after 30 seconds
  setTimeout(() => {
    console.error('⚠️ Forcing shutdown after 30s timeout');
    process.exit(1);
  }, 30000);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  console.error('Stack:', error.stack);
  
  // Log ama crash etme (production için)
  if (process.env.NODE_ENV === 'production') {
    console.error('⚠️ Continuing despite uncaught exception...');
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  
  // Log ama crash etme (production için)
  if (process.env.NODE_ENV === 'production') {
    console.error('⚠️ Continuing despite unhandled rejection...');
  } else {
    process.exit(1);
  }
});

// ========================================
// 📊 PERIODIC STATS LOGGING
// ========================================

setInterval(() => {
  const stats = {
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    connections: connectionMonitor.size,
    rooms: rooms.size,
    users: users.size,
    activeCalls: activeCalls.size,
    screenShares: Array.from(rooms.values()).filter(r => r.screenSharing).length
  };
  
  console.log(`📊 Stats: ${JSON.stringify(stats)}`);
}, 300000); // Her 5 dakikada bir

// ========================================
// 🧹 PERIODIC CLEANUP
// ========================================

setInterval(() => {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  
  // Eski ekran paylaşım isteklerini temizle
  for (const [socketId, request] of screenShareRequests.entries()) {
    if (now - request.timestamp.getTime() > 5 * 60 * 1000) { // 5 dakika
      screenShareRequests.delete(socketId);
      console.log(`🧹 Cleaned old screen share request: ${socketId}`);
    }
  }
  
  // Boş odaları temizle
  for (const [roomCode, room] of rooms.entries()) {
    if (room.users.size === 0 && now - room.createdAt.getTime() > ONE_HOUR) {
      rooms.delete(roomCode);
      messages.delete(roomCode);
      console.log(`🧹 Cleaned empty room: ${roomCode}`);
    }
  }
  
  console.log(`🧹 Cleanup completed: ${screenShareRequests.size} requests, ${rooms.size} rooms`);
}, 600000); // Her 10 dakikada bir

// ========================================
// 🎯 GRACEFUL SHUTDOWN HELPER
// ========================================

function gracefulShutdown(signal) {
  console.log(`🛑 ${signal} received, starting graceful shutdown...`);
  
  // Stop accepting new connections
  server.close(() => {
    console.log('✅ HTTP server closed');
    
    // Close all socket connections
    io.close(() => {
      console.log('✅ Socket.io server closed');
      process.exit(0);
    });
  });
  
  // Force close after 30 seconds
  setTimeout(() => {
    console.error('⚠️ Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
}

// Register shutdown handlers
['SIGTERM', 'SIGINT'].forEach(signal => {
  process.on(signal, () => gracefulShutdown(signal));
});

// ========================================
// 🎉 STARTUP COMPLETE
// ========================================

console.log('✅ All systems operational');
console.log('🎉 Server initialization complete');
console.log('📝 Logs will appear below...');
console.log('═'.repeat(60));
