/**
 * Skibidi Screen Share - Real WebRTC Implementation
 * 
 * This file handles real-time screen sharing using WebRTC with optimizations
 * for low latency suitable for gaming and high-performance applications.
 */

// ============================================
// DOM Elements
// ============================================
const sharingCodeInput = document.getElementById('sharingCode');
const connectBtn = document.getElementById('connectBtn');
const generateBtn = document.getElementById('generateBtn');
const statusMessage = document.getElementById('statusMessage');
const connectionStatus = document.getElementById('connectionStatus');
const statusText = document.getElementById('statusText');
const screenDisplay = document.getElementById('screenDisplay');
const screenControls = document.getElementById('screenControls');
const disconnectBtn = document.getElementById('disconnectBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const settingsBtn = document.getElementById('settingsBtn');

// ============================================
// State Management
// ============================================
let isConnected = false;
let currentCode = null;
let socket = null;
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let role = null; // 'host' or 'viewer'
let remotePeerId = null;
let statsInterval = null;

// Remote Control State
let dataChannel = null;
let remoteControlEnabled = false;
let lastMousePosition = { x: 0, y: 0 };
let eventBatchQueue = [];
let eventBatchInterval = null;
let inputLatencyHistory = [];

// ============================================
// WebRTC Configuration (Optimized for Low Latency)
// ============================================
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
};

// Optimized constraints for low-latency, high-quality screen sharing
const screenConstraints = {
    video: {
        cursor: 'always',
        displaySurface: 'monitor',
        frameRate: { ideal: 60, max: 60 },
        width: { ideal: 1920, max: 2560 },
        height: { ideal: 1080, max: 1440 }
    },
    audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
    }
};

// Remote Control Configuration (Gaming-Optimized)
const remoteControlConfig = {
    // Send batched events every 16ms (60Hz) for gaming responsiveness
    batchInterval: 16,
    // Mouse movement throttle (send every N milliseconds)
    mouseMoveThrottle: 8, // 125Hz mouse polling
    // Maximum events per batch
    maxBatchSize: 50,
    // Enable prediction for smoother cursor movement
    enablePrediction: true
};

// ============================================
// Socket.IO Connection
// ============================================
function initializeSocket() {
    // Connect to Socket.IO server (works for both local and Vercel)
    const socketURL = window.location.origin;
    
    console.log('🔌 Connecting to Socket.IO server at:', socketURL);
    
    socket = io(socketURL, {
        path: '/socket.io',
        transports: ['polling', 'websocket'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 10,
        timeout: 20000,
        autoConnect: true,
        forceNew: false
    });

    socket.on('connect', () => {
        console.log('✅ Connected to signaling server');
        console.log('Socket ID:', socket.id);
        showStatusMessage('Connected to server', 'success');
    });

    socket.on('connect_error', (error) => {
        console.error('❌ Connection error:', error);
        showStatusMessage('Failed to connect to server. Retrying...', 'error');
    });

    socket.on('disconnect', (reason) => {
        console.log('❌ Disconnected from signaling server. Reason:', reason);
        if (isConnected) {
            showStatusMessage('Connection to server lost', 'error');
        }
    });

    socket.on('reconnect', (attemptNumber) => {
        console.log('✅ Reconnected after', attemptNumber, 'attempts');
        showStatusMessage('Reconnected to server', 'success');
    });

    socket.on('reconnect_attempt', (attemptNumber) => {
        console.log('🔄 Reconnection attempt', attemptNumber);
    });

    socket.on('reconnect_failed', () => {
        console.error('❌ Failed to reconnect to server');
        showStatusMessage('Could not reconnect to server', 'error');
    });

    socket.on('viewer-joined', async (viewerId) => {
        console.log(`👁️ Viewer joined: ${viewerId}`);
        remotePeerId = viewerId;
        showStatusMessage('Viewer connected! Creating peer connection...', 'info');
        await createOffer(viewerId);
    });

    socket.on('offer', async (data) => {
        console.log(`📨 Received offer from ${data.from}`);
        remotePeerId = data.from;
        await handleOffer(data.offer, data.from);
    });

    socket.on('answer', async (data) => {
        console.log(`📨 Received answer from ${data.from}`);
        await handleAnswer(data.answer);
    });

    socket.on('ice-candidate', async (data) => {
        console.log(`🧊 Received ICE candidate from ${data.from}`);
        await handleIceCandidate(data.candidate);
    });

    socket.on('host-disconnected', () => {
        showStatusMessage('Host disconnected', 'error');
        disconnectFromRemote();
    });

    socket.on('viewer-disconnected', () => {
        showStatusMessage('Viewer disconnected', 'info');
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        remotePeerId = null;
    });
}

// ============================================
// WebRTC Functions
// ============================================

/**
 * Create peer connection with optimized settings
 */
function createPeerConnection() {
    peerConnection = new RTCPeerConnection(rtcConfig);

    // Create data channel for remote control (viewer creates it)
    if (role === 'viewer') {
        dataChannel = peerConnection.createDataChannel('remoteControl', {
            ordered: false, // Allow out-of-order for lower latency
            maxRetransmits: 0 // Don't retransmit for real-time control
        });
        setupDataChannel(dataChannel);
        console.log('📡 Data channel created by viewer');
    }

    // Handle data channel from viewer (host receives it)
    peerConnection.ondatachannel = (event) => {
        dataChannel = event.channel;
        setupDataChannel(dataChannel);
        console.log('📡 Data channel received by host');
    };

    // Add tracks from local stream (for host)
    if (localStream && role === 'host') {
        localStream.getTracks().forEach(track => {
            const sender = peerConnection.addTrack(track, localStream);
            
            // Optimize encoding parameters for low latency
            if (track.kind === 'video') {
                const parameters = sender.getParameters();
                if (!parameters.encodings) {
                    parameters.encodings = [{}];
                }
                // Set parameters for low latency
                parameters.encodings[0].maxBitrate = 10000000; // 10 Mbps
                parameters.encodings[0].priority = 'high';
                sender.setParameters(parameters);
            }
        });
    }

    // Handle incoming tracks (for viewer)
    peerConnection.ontrack = (event) => {
        console.log('📺 Received remote track');
        if (!remoteStream) {
            remoteStream = new MediaStream();
        }
        remoteStream.addTrack(event.track);
        displayRemoteStream();
    };

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('🧊 Sending ICE candidate');
            socket.emit('ice-candidate', {
                candidate: event.candidate,
                to: remotePeerId
            });
        }
    };

    // Connection state monitoring
    peerConnection.onconnectionstatechange = () => {
        console.log(`🔌 Connection state: ${peerConnection.connectionState}`);
        
        if (peerConnection.connectionState === 'connected') {
            isConnected = true;
            updateConnectionStatus('connected', `Connected to ${currentCode}`);
            showStatusMessage('Successfully connected!', 'success');
            startStatsMonitoring();
        } else if (peerConnection.connectionState === 'disconnected' || 
                   peerConnection.connectionState === 'failed') {
            showStatusMessage('Connection lost', 'error');
            disconnectFromRemote();
        }
    };

    return peerConnection;
}

/**
 * Create and send offer to viewer
 */
async function createOffer(viewerId) {
    try {
        createPeerConnection();
        
        const offer = await peerConnection.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: false
        });

        // Modify SDP for lower latency
        offer.sdp = optimizeSDPForLatency(offer.sdp);
        
        await peerConnection.setLocalDescription(offer);
        
        socket.emit('offer', {
            offer: offer,
            to: viewerId
        });
        
        console.log('📤 Offer sent to viewer');
    } catch (error) {
        console.error('Error creating offer:', error);
        showStatusMessage('Failed to create connection', 'error');
    }
}

/**
 * Handle incoming offer and create answer
 */
async function handleOffer(offer, from) {
    try {
        createPeerConnection();
        
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        
        const answer = await peerConnection.createAnswer();
        
        // Modify SDP for lower latency
        answer.sdp = optimizeSDPForLatency(answer.sdp);
        
        await peerConnection.setLocalDescription(answer);
        
        socket.emit('answer', {
            answer: answer,
            to: from
        });
        
        console.log('📤 Answer sent to host');
    } catch (error) {
        console.error('Error handling offer:', error);
        showStatusMessage('Failed to establish connection', 'error');
    }
}

/**
 * Handle incoming answer
 */
async function handleAnswer(answer) {
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('✅ Answer received and processed');
    } catch (error) {
        console.error('Error handling answer:', error);
    }
}

/**
 * Handle incoming ICE candidate
 */
async function handleIceCandidate(candidate) {
    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        console.log('✅ ICE candidate added');
    } catch (error) {
        console.error('Error adding ICE candidate:', error);
    }
}

/**
 * Optimize SDP for low latency
 */
function optimizeSDPForLatency(sdp) {
    try {
        // Set maximum bitrate for better quality
        let modifiedSdp = sdp.replace(/a=fmtp:(\d+) /g, 'a=fmtp:$1 x-google-max-bitrate=10000;x-google-min-bitrate=2000;x-google-start-bitrate=5000;');
        
        // Enable hardware acceleration hints for H264
        modifiedSdp = modifiedSdp.replace(/a=rtpmap:(\d+) H264/g, 'a=rtpmap:$1 H264\r\na=fmtp:$1 profile-level-id=42e01f;level-asymmetry-allowed=1;packetization-mode=1');
        
        return modifiedSdp;
    } catch (error) {
        console.warn('Error optimizing SDP:', error);
        return sdp; // Return original if optimization fails
    }
}

/**
 * Display remote stream in video element
 */
function displayRemoteStream() {
    // Clear existing content
    screenDisplay.textContent = '';
    
    // Create video element
    const videoElement = document.createElement('video');
    videoElement.id = 'remoteVideo';
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.style.cssText = 'width: 100%; height: 100%; object-fit: contain; background: #000;';
    videoElement.srcObject = remoteStream;
    
    // Create stats display
    const statsDiv = document.createElement('div');
    statsDiv.id = 'streamStats';
    statsDiv.style.cssText = 'position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.7); color: #0f0; padding: 10px; border-radius: 5px; font-family: monospace; font-size: 12px;';
    
    // Create remote control toggle button (viewer only)
    if (role === 'viewer') {
        const controlToggle = document.createElement('button');
        controlToggle.id = 'remoteControlToggle';
        controlToggle.className = 'control-toggle-btn';
        controlToggle.innerHTML = '🎮 Enable Remote Control';
        controlToggle.style.cssText = 'position: absolute; top: 10px; left: 10px; background: rgba(74, 144, 226, 0.9); color: white; padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 14px; transition: all 0.3s;';
        
        controlToggle.addEventListener('click', () => {
            const newState = !remoteControlEnabled;
            toggleRemoteControl(newState);
            
            if (newState) {
                controlToggle.innerHTML = '🎮 Disable Remote Control';
                controlToggle.style.background = 'rgba(231, 76, 60, 0.9)';
            } else {
                controlToggle.innerHTML = '🎮 Enable Remote Control';
                controlToggle.style.background = 'rgba(74, 144, 226, 0.9)';
            }
        });
        
        screenDisplay.appendChild(controlToggle);
    }
    
    screenDisplay.appendChild(videoElement);
    screenDisplay.appendChild(statsDiv);
    screenControls.style.display = 'flex';
}

/**
 * Start monitoring connection statistics
 */
async function startStatsMonitoring() {
    if (statsInterval) {
        clearInterval(statsInterval);
    }
    
    statsInterval = setInterval(async () => {
        if (!peerConnection) return;
        
        try {
            const stats = await peerConnection.getStats();
            let statsText = '';
            let videoStats = null;
            
            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    videoStats = report;
                }
            });
            
            if (videoStats) {
                const bitrate = Math.round((videoStats.bytesReceived * 8) / 1000); // kbps
                const fps = videoStats.framesPerSecond || 0;
                const packetsLost = videoStats.packetsLost || 0;
                
                statsText = `
                    📊 FPS: ${fps}
                    📈 Bitrate: ${bitrate} kbps
                    📦 Packets Lost: ${packetsLost}
                `;
                
                const statsEl = document.getElementById('streamStats');
                if (statsEl) {
                    statsEl.textContent = statsText.trim();
                }
            }
        } catch (error) {
            console.error('Error getting stats:', error);
        }
    }, 1000);
}

// ============================================
// Remote Control Functions (Gaming-Optimized)
// ============================================

/**
 * Setup data channel for remote control
 */
function setupDataChannel(channel) {
    channel.onopen = () => {
        console.log('✅ Data channel opened - Remote control ready');
        if (role === 'viewer') {
            showStatusMessage('Remote control ready! Click to enable.', 'success');
        }
    };

    channel.onclose = () => {
        console.log('❌ Data channel closed');
        if (remoteControlEnabled) {
            toggleRemoteControl(false);
        }
    };

    channel.onerror = (error) => {
        console.error('Data channel error:', error);
    };

    // Handle incoming control events (host side)
    if (role === 'host') {
        channel.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                // Handle batched events
                if (data.type === 'batch' && data.events) {
                    data.events.forEach(controlEvent => {
                        handleRemoteControlEvent(controlEvent);
                    });
                } else {
                    // Handle single event
                    handleRemoteControlEvent(data);
                }
            } catch (error) {
                console.error('Error parsing control event:', error);
            }
        };
    }
}

/**
 * Handle remote control events (host side)
 */
function handleRemoteControlEvent(event) {
    // Note: Due to browser security, we cannot actually control the host's desktop
    // This is a framework for when browser APIs support it or for custom implementations
    
    // Log events for demonstration (comment out for production to reduce noise)
    // console.log('🎮 Remote control event:', event.type);
    
    // In a real implementation with proper APIs, this would control the desktop
    switch (event.type) {
        case 'mousemove':
            // Would move cursor to (event.x, event.y)
            break;
        case 'mousedown':
        case 'mouseup':
            // Would trigger mouse button (event.button)
            break;
        case 'wheel':
            // Would scroll (event.deltaX, event.deltaY)
            break;
        case 'keydown':
        case 'keyup':
            // Would trigger key (event.key, event.code)
            break;
    }
}

/**
 * Toggle remote control on/off (viewer side)
 */
function toggleRemoteControl(enabled) {
    remoteControlEnabled = enabled;
    
    const videoElement = document.getElementById('remoteVideo');
    if (!videoElement) return;
    
    if (enabled) {
        // Start capturing input events
        startEventBatching();
        attachInputEventListeners(videoElement);
        videoElement.style.cursor = 'none'; // Hide cursor for custom rendering
        showStatusMessage('🎮 Remote control enabled', 'success');
        console.log('🎮 Remote control enabled');
    } else {
        // Stop capturing input events
        stopEventBatching();
        detachInputEventListeners(videoElement);
        videoElement.style.cursor = 'default';
        showStatusMessage('Remote control disabled', 'info');
        console.log('Remote control disabled');
    }
}

/**
 * Start event batching for optimized sending
 */
function startEventBatching() {
    if (eventBatchInterval) return;
    
    eventBatchInterval = setInterval(() => {
        if (eventBatchQueue.length > 0 && dataChannel && dataChannel.readyState === 'open') {
            // Send batched events
            const batch = eventBatchQueue.splice(0, remoteControlConfig.maxBatchSize);
            dataChannel.send(JSON.stringify({
                type: 'batch',
                events: batch,
                timestamp: Date.now()
            }));
        }
    }, remoteControlConfig.batchInterval);
}

/**
 * Stop event batching
 */
function stopEventBatching() {
    if (eventBatchInterval) {
        clearInterval(eventBatchInterval);
        eventBatchInterval = null;
        eventBatchQueue = [];
    }
}

/**
 * Queue control event for batched sending
 */
function queueControlEvent(event) {
    eventBatchQueue.push({
        ...event,
        timestamp: Date.now()
    });
}

/**
 * Send immediate control event (for critical events)
 */
function sendControlEventImmediate(event) {
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({
            ...event,
            timestamp: Date.now()
        }));
    }
}

/**
 * Attach input event listeners to video element
 */
function attachInputEventListeners(element) {
    // Mouse events
    element.addEventListener('mousemove', handleMouseMove);
    element.addEventListener('mousedown', handleMouseDown);
    element.addEventListener('mouseup', handleMouseUp);
    element.addEventListener('wheel', handleMouseWheel, { passive: false });
    element.addEventListener('contextmenu', handleContextMenu);
    
    // Keyboard events (capture on document)
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    
    // Focus management
    element.tabIndex = 0;
    element.focus();
    
    console.log('✅ Input event listeners attached');
}

/**
 * Detach input event listeners
 */
function detachInputEventListeners(element) {
    element.removeEventListener('mousemove', handleMouseMove);
    element.removeEventListener('mousedown', handleMouseDown);
    element.removeEventListener('mouseup', handleMouseUp);
    element.removeEventListener('wheel', handleMouseWheel);
    element.removeEventListener('contextmenu', handleContextMenu);
    
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('keyup', handleKeyUp);
    
    console.log('❌ Input event listeners detached');
}

// Mouse event handlers
let lastMouseMoveTime = 0;

function handleMouseMove(e) {
    if (!remoteControlEnabled) return;
    
    const now = Date.now();
    if (now - lastMouseMoveTime < remoteControlConfig.mouseMoveThrottle) {
        return; // Throttle mouse movements
    }
    lastMouseMoveTime = now;
    
    const rect = e.target.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    
    queueControlEvent({
        type: 'mousemove',
        x: x,
        y: y
    });
}

function handleMouseDown(e) {
    if (!remoteControlEnabled) return;
    e.preventDefault();
    
    const rect = e.target.getBoundingClientRect();
    sendControlEventImmediate({
        type: 'mousedown',
        button: e.button,
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height
    });
}

function handleMouseUp(e) {
    if (!remoteControlEnabled) return;
    e.preventDefault();
    
    const rect = e.target.getBoundingClientRect();
    sendControlEventImmediate({
        type: 'mouseup',
        button: e.button,
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height
    });
}

function handleMouseWheel(e) {
    if (!remoteControlEnabled) return;
    e.preventDefault();
    
    queueControlEvent({
        type: 'wheel',
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode
    });
}

function handleContextMenu(e) {
    if (remoteControlEnabled) {
        e.preventDefault();
    }
}

// Keyboard event handlers
function handleKeyDown(e) {
    if (!remoteControlEnabled) return;
    
    // Don't prevent certain browser shortcuts
    if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) return;
    if (e.key === 'F11') return;
    if (e.key === 'F12') return;
    
    e.preventDefault();
    
    sendControlEventImmediate({
        type: 'keydown',
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey
    });
}

function handleKeyUp(e) {
    if (!remoteControlEnabled) return;
    e.preventDefault();
    
    sendControlEventImmediate({
        type: 'keyup',
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey
    });
}

// ============================================
// Utility Functions
// ============================================

/**
 * Validates the format of a sharing code
 * @param {string} code - The code to validate
 * @returns {boolean} True if valid, false otherwise
 */
function validateSharingCode(code) {
    const cleanCode = code.replace(/\s/g, '');
    const pattern = /^\d{3}-\d{3}-\d{3}$|^\d{9}$/;
    return pattern.test(cleanCode);
}

/**
 * Formats input as user types to match XXX-XXX-XXX pattern
 */
function formatSharingCode(value) {
    const digits = value.replace(/\D/g, '');
    
    if (digits.length <= 3) {
        return digits;
    } else if (digits.length <= 6) {
        return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    } else {
        return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 9)}`;
    }
}

/**
 * Display status message to user
 */
function showStatusMessage(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`;
    
    setTimeout(() => {
        statusMessage.style.display = 'none';
    }, 5000);
}

/**
 * Update connection status indicator
 */
function updateConnectionStatus(status, text) {
    connectionStatus.className = `connection-status ${status}`;
    statusText.textContent = text;
}

// ============================================
// Screen Sharing Functions
// ============================================

/**
 * Start screen sharing (host)
 */
async function startScreenSharing(code) {
    try {
        updateConnectionStatus('connecting', 'Starting screen capture...');
        
        // Request screen capture with optimized settings
        localStream = await navigator.mediaDevices.getDisplayMedia(screenConstraints);
        
        currentCode = code;
        role = 'host';
        
        // Clear and create elements safely
        screenDisplay.textContent = '';
        
        // Create video element
        const videoElement = document.createElement('video');
        videoElement.id = 'localVideo';
        videoElement.autoplay = true;
        videoElement.muted = true;
        videoElement.playsInline = true;
        videoElement.style.cssText = 'width: 100%; height: 100%; object-fit: contain; background: #000;';
        videoElement.srcObject = localStream;
        
        // Create status badge
        const statusBadge = document.createElement('div');
        statusBadge.style.cssText = 'position: absolute; top: 10px; left: 10px; background: rgba(80, 200, 120, 0.9); color: white; padding: 8px 15px; border-radius: 5px; font-weight: 600;';
        statusBadge.textContent = `🔴 Sharing - Code: ${code}`;
        
        screenDisplay.appendChild(videoElement);
        screenDisplay.appendChild(statusBadge);
        
        screenControls.style.display = 'flex';
        updateConnectionStatus('connected', `Sharing as ${code} - Waiting for viewer...`);
        showStatusMessage(`Your screen is being shared. Code: ${code}`, 'success');
        
        // Handle stream ending (user stops sharing)
        localStream.getVideoTracks()[0].onended = () => {
            showStatusMessage('Screen sharing stopped', 'info');
            disconnectFromRemote();
        };
        
    } catch (error) {
        console.error('Error starting screen share:', error);
        showStatusMessage('Failed to start screen sharing. Please allow screen access.', 'error');
        disconnectFromRemote();
    }
}

/**
 * Connect as viewer
 */
async function connectAsViewer(code) {
    try {
        currentCode = code;
        role = 'viewer';
        
        updateConnectionStatus('connecting', 'Connecting to host...');
        showStatusMessage('Connecting to remote screen...', 'info');
        
        socket.emit('join-room', code, (response) => {
            if (response.success) {
                console.log(`✅ Joined room ${code}, waiting for stream...`);
                remotePeerId = response.hostId;
                // Wait for host to send offer
            } else {
                showStatusMessage(response.message, 'error');
                disconnectFromRemote();
            }
        });
        
    } catch (error) {
        console.error('Error connecting:', error);
        showStatusMessage('Connection failed', 'error');
        disconnectFromRemote();
    }
}

/**
 * Disconnect from remote session and cleanup
 */
function disconnectFromRemote() {
    // Disable remote control if enabled
    if (remoteControlEnabled) {
        toggleRemoteControl(false);
    }
    
    // Stop event batching
    stopEventBatching();
    
    // Close data channel
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }
    
    // Stop stats monitoring
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
    }
    
    // Close peer connection
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    // Stop local stream
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    // Clear remote stream
    remoteStream = null;
    
    isConnected = false;
    currentCode = null;
    role = null;
    remotePeerId = null;
    
    // Update UI
    updateConnectionStatus('disconnected', 'Not Connected');
    
    // Reset screen display safely
    screenDisplay.textContent = '';
    
    const placeholderDiv = document.createElement('div');
    placeholderDiv.className = 'placeholder-content';
    
    const iconDiv = document.createElement('div');
    iconDiv.className = 'placeholder-icon';
    iconDiv.textContent = '🖥️';
    
    const heading = document.createElement('h3');
    heading.textContent = 'No Active Connection';
    
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Enter a sharing code above to connect to a remote desktop';
    
    placeholderDiv.appendChild(iconDiv);
    placeholderDiv.appendChild(heading);
    placeholderDiv.appendChild(paragraph);
    screenDisplay.appendChild(placeholderDiv);
    
    // Hide controls
    screenControls.style.display = 'none';
    
    // Clear input
    sharingCodeInput.value = '';
    
    // Reset button
    connectBtn.disabled = false;
    connectBtn.innerHTML = '<span class="btn-icon">🔗</span>Connect';
}

/**
 * Toggle fullscreen mode
 */
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        screenDisplay.requestFullscreen().catch(err => {
            showStatusMessage(`Fullscreen error: ${err.message}`, 'error');
        });
    } else {
        document.exitFullscreen();
    }
}

// ============================================
// Event Listeners
// ============================================

// Format sharing code input as user types
sharingCodeInput.addEventListener('input', (e) => {
    e.target.value = formatSharingCode(e.target.value);
});

// Allow Enter key to connect
sharingCodeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        connectBtn.click();
    }
});

// Connect button click handler
connectBtn.addEventListener('click', async () => {
    const code = sharingCodeInput.value.trim();
    
    if (!code) {
        showStatusMessage('Please enter a sharing code', 'error');
        sharingCodeInput.focus();
        return;
    }
    
    if (!validateSharingCode(code)) {
        showStatusMessage('Invalid sharing code format. Please use XXX-XXX-XXX format.', 'error');
        return;
    }
    
    if (isConnected) {
        showStatusMessage('Already connected. Disconnect first to connect to a different screen.', 'info');
        return;
    }
    
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting...';
    
    // Connect as viewer
    await connectAsViewer(code);
});

// Generate button click handler - Start screen sharing as host
generateBtn.addEventListener('click', async () => {
    if (isConnected) {
        showStatusMessage('Already sharing or connected.', 'info');
        return;
    }
    
    generateBtn.disabled = true;
    generateBtn.textContent = 'Starting...';
    
    socket.emit('generate-code', async (response) => {
        if (response.success) {
            const code = response.code;
            sharingCodeInput.value = code;
            await startScreenSharing(code);
        } else {
            showStatusMessage('Failed to generate code', 'error');
        }
        
        generateBtn.disabled = false;
        generateBtn.innerHTML = '<span class="btn-icon">🔑</span>Generate My Code';
    });
});

// Disconnect button click handler
disconnectBtn.addEventListener('click', () => {
    disconnectFromRemote();
});

// Fullscreen button click handler
fullscreenBtn.addEventListener('click', () => {
    toggleFullscreen();
});

// Settings button click handler (placeholder)
settingsBtn.addEventListener('click', () => {
    showStatusMessage('Settings panel coming soon!', 'info');
});

// ============================================
// Initialization
// ============================================
console.log('🚀 Skibidi Screen Share - Real WebRTC Implementation');
console.log('📝 Initializing...');

// Initialize Socket.IO connection
initializeSocket();

