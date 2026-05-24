const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// In production, FRONTEND_URL is set as an environment variable on Render.
// e.g. FRONTEND_URL=https://your-rmm.netlify.app
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Configure session middleware
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'super-secret-key-12345',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: IS_PRODUCTION,       // true on Render (HTTPS), false locally
        httpOnly: true,
        sameSite: IS_PRODUCTION ? 'none' : 'lax', // 'none' required for cross-origin (Netlify→Render)
        maxAge: 1000 * 60 * 60 * 24 // 1 day
    }
});

// Middleware
app.use(express.json());
// Trust the proxy (required on Render for secure cookies to work correctly)
app.set('trust proxy', 1);

const corsOptions = {
    origin: FRONTEND_URL,
    credentials: true,
};
app.use(cors(corsOptions));
app.use(sessionMiddleware);

// Initialize Socket.IO
const io = new Server(server, {
    cors: corsOptions
});

// Share session with Socket.IO
io.engine.use(sessionMiddleware);

// Active Agents List (In-Memory)
// Key: device_id, Value: { device_id, hostname, ip_address, socket_id, last_seen }
const activeAgents = new Map();

// --- AUTHENTICATION ROUTES ---

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'admin') {
        req.session.authenticated = true;
        req.session.role = 'admin';
        return res.json({ success: true, message: 'Logged in successfully' });
    }
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Could not log out' });
        }
        res.clearCookie('connect.sid');
        return res.json({ success: true, message: 'Logged out' });
    });
});

// Middleware to protect API routes
const requireAuth = (req, res, next) => {
    if (req.session && req.session.authenticated) {
        return next();
    }
    res.status(401).json({ success: false, message: 'Unauthorized' });
};

// --- API ROUTES ---

// Get active agents list via API (Admin only)
app.get('/api/agents', requireAuth, (req, res) => {
    const agentsList = Array.from(activeAgents.values());
    res.json(agentsList);
});

// --- WEBSOCKET CONNECTION ---
// We distinguish admin vs agent by a ?type= query param on the socket URL.
// Admin browser connects with ?type=admin
// Agent .exe connects with ?type=agent
// This avoids relying on session cookies which .exe agents can't carry.

io.on('connection', (socket) => {
    const clientType = socket.handshake.query.type; // 'admin' or 'agent'
    
    if (clientType === 'admin') {
        console.log(`Admin connected: ${socket.id}`);
        // Join admins room so we can broadcast only to admins
        socket.join('admins');
        
        // Send current agent list immediately on connect
        socket.emit('admin:agents_list', Array.from(activeAgents.values()));

        socket.on('admin:get_agents', () => {
            socket.emit('admin:agents_list', Array.from(activeAgents.values()));
        });
        
        socket.on('admin:execute_command', ({ device_id, command }) => {
            const agent = activeAgents.get(device_id);
            if (agent) {
                const command_id = Math.random().toString(36).substring(7);
                console.log(`Admin executing command on ${device_id}: ${command}`);
                io.to(agent.socket_id).emit('agent:execute', { command_id, command });
            } else {
                console.warn(`Command sent to unknown device_id: ${device_id}`);
            }
        });
        
        socket.on('disconnect', () => {
            console.log(`Admin disconnected: ${socket.id}`);
        });
        
    } else if (clientType === 'agent') {
        console.log(`Agent connected: ${socket.id}`);
        let currentDeviceId = null;
        
        socket.on('agent:register', (payload) => {
            const { device_id, hostname } = payload;
            currentDeviceId = device_id;
            
            // Format IP address (convert IPv6 loopback to 'localhost')
            let ipAddress = socket.handshake.address;
            if (ipAddress === '::1' || ipAddress === '127.0.0.1' || ipAddress === '::ffff:127.0.0.1') {
                ipAddress = 'localhost';
            }
            
            activeAgents.set(device_id, {
                device_id,
                hostname,
                ip_address: ipAddress,
                socket_id: socket.id,
                last_seen: Date.now()
            });
            console.log(`Agent registered: ${hostname} (${device_id}) from ${ipAddress}`);
            
            // Broadcast updated list only to admin clients
            io.to('admins').emit('admin:agents_list', Array.from(activeAgents.values()));
        });
        
        socket.on('agent:heartbeat', () => {
            if (currentDeviceId && activeAgents.has(currentDeviceId)) {
                const agent = activeAgents.get(currentDeviceId);
                agent.last_seen = Date.now();
                activeAgents.set(currentDeviceId, agent);
            }
        });
        
        socket.on('agent:output', (payload) => {
            const { command_id, chunk } = payload;
            if (currentDeviceId) {
                io.to('admins').emit('admin:output_stream', {
                    device_id: currentDeviceId,
                    command_id,
                    chunk
                });
            }
        });
        
        socket.on('disconnect', () => {
            console.log(`Agent disconnected: ${socket.id}`);
            if (currentDeviceId) {
                activeAgents.delete(currentDeviceId);
                io.to('admins').emit('admin:agents_list', Array.from(activeAgents.values()));
            }
        });

    } else {
        // Unknown client type — disconnect immediately
        console.warn(`Unknown client type connected, disconnecting: ${socket.id}`);
        socket.disconnect(true);
    }
});

// --- HEARTBEAT MONITOR ---
// Check for dead agents every 10 seconds
setInterval(() => {
    const now = Date.now();
    let changed = false;
    
    for (const [deviceId, agent] of activeAgents.entries()) {
        // If no heartbeat for 25 seconds, remove agent
        if (now - agent.last_seen > 25000) {
            console.log(`Agent timed out: ${agent.hostname} (${deviceId})`);
            activeAgents.delete(deviceId);
            changed = true;
            
            // Optional: Disconnect the socket forcibly
            const socket = io.sockets.sockets.get(agent.socket_id);
            if (socket) {
                socket.disconnect(true);
            }
        }
    }
    
    if (changed) {
        io.emit('admin:agents_list', Array.from(activeAgents.values()));
    }
}, 10000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
});
