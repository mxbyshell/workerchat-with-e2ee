const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 内存中的房间存储（生产环境建议使用 Redis）
const rooms = new Map();

// MIME 类型映射
const mimeTypes = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
};

// 生成64字符的随机房间ID
function generateRoomId() {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let i = 0; i < 64; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);

	// 处理 CORS 预检请求
	if (req.method === 'OPTIONS') {
		res.writeHead(200, {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		});
		res.end();
		return;
	}

	// 创建房间 API
	if (url.pathname === '/api/room' && req.method === 'POST') {
		const roomId = generateRoomId();
		res.writeHead(200, {
			'Content-Type': 'text/plain',
			'Access-Control-Allow-Origin': '*',
		});
		res.end(roomId);
		return;
	}

	// 静态文件服务
	let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
	filePath = path.join(__dirname, 'public', filePath);

	const ext = path.extname(filePath).toLowerCase();
	const contentType = mimeTypes[ext] || 'application/octet-stream';

	fs.readFile(filePath, (err, content) => {
		if (err) {
			if (err.code === 'ENOENT') {
				// 文件不存在，返回 index.html（支持前端路由）
				fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, content) => {
					if (err) {
						res.writeHead(404);
						res.end('Not Found');
					} else {
						res.writeHead(200, { 'Content-Type': 'text/html' });
						res.end(content);
					}
				});
			} else {
				res.writeHead(500);
				res.end('Server Error');
			}
		} else {
			res.writeHead(200, {
				'Content-Type': contentType,
				'Access-Control-Allow-Origin': '*',
			});
			res.end(content);
		}
	});
});

// 创建 WebSocket 服务器 - 不限制路径，通过代码处理路由
const wss = new WebSocket.Server({
	server,
	// 不设置 path，让所有 WebSocket 连接都进入这里
	verifyClient: (info, cb) => {
		// 允许所有连接，在 connection 事件中处理路由
		cb(true);
	},
});

// 房间管理类
class ChatRoom {
	constructor(roomId) {
		this.roomId = roomId;
		this.users = new Map(); // WebSocket -> UserInfo
		this.sessions = new Set();
	}

	handleSession(ws) {
		this.sessions.add(ws);

		ws.on('message', (data) => {
			try {
				const message = JSON.parse(data.toString());
				this.handleMessage(ws, message);
			} catch (error) {
				console.error('Message parse error:', error);
				this.sendError(ws, 'Invalid JSON format');
			}
		});

		ws.on('close', (code, reason) => {
			console.log(`WebSocket closed: ${code} ${reason}`);
			this.handleDisconnect(ws);
		});

		ws.on('error', (error) => {
			console.error('WebSocket error:', error);
			this.handleDisconnect(ws);
		});
	}

	handleMessage(ws, message) {
		switch (message.type) {
			case 'register':
				this.handleRegister(ws, message);
				break;
			case 'getUsers':
				this.handleGetUsers(ws);
				break;
			case 'message':
				this.handleChatMessage(ws, message);
				break;
			default:
				this.sendError(ws, `Unknown message type: ${message.type}`);
		}
	}

	handleRegister(ws, message) {
		try {
			if (!message.publicKey || typeof message.publicKey !== 'string') {
				this.sendError(ws, 'Invalid public key format');
				return;
			}

			// 验证公钥格式
			if (!this.isValidPGPPublicKey(message.publicKey)) {
				this.sendError(ws, 'Invalid PGP public key format');
				return;
			}

			// 从公钥中提取用户信息（简化版）
			const userProfile = this.extractUserProfile(message.publicKey);

			const userInfo = {
				id: userProfile.id,
				name: userProfile.name,
				email: userProfile.email,
				publicKey: message.publicKey,
				ws: ws,
				role: 'guest',
			};

			// 检查用户是否已存在
			const existingUser = this.findUserById(userInfo.id);
			if (existingUser && existingUser.ws !== ws) {
				// 更新现有用户的连接
				this.users.delete(existingUser.ws);
				try {
					existingUser.ws.close();
				} catch (e) {}
			}

			this.users.set(ws, userInfo);

			// 发送注册成功响应
			const response = {
				type: 'registered',
				profile: {
					id: userInfo.id,
					name: userInfo.name,
					email: userInfo.email,
				},
			};

			ws.send(JSON.stringify(response));

			// 向其他用户广播用户列表更新
			this.broadcastUserList();
		} catch (error) {
			console.error('Registration error:', error);
			this.sendError(ws, 'Registration failed');
		}
	}

	handleGetUsers(ws) {
		const users = Array.from(this.users.values()).map((user) => ({
			id: user.id,
			name: user.name,
			email: user.email,
			publicKey: user.publicKey,
		}));

		const response = {
			type: 'userList',
			users: users,
		};

		ws.send(JSON.stringify(response));
	}

	handleChatMessage(ws, message) {
		const sender = this.users.get(ws);
		if (!sender) {
			this.sendError(ws, 'User not registered');
			return;
		}

		if (!message.encryptedData || typeof message.encryptedData !== 'string') {
			this.sendError(ws, 'Invalid encrypted data format');
			return;
		}

		// 验证加密消息格式
		if (!this.isValidPGPMessage(message.encryptedData)) {
			this.sendError(ws, 'Invalid PGP message format');
			return;
		}

		// 广播加密消息给所有用户
		const broadcastMessage = {
			type: 'encryptedMessage',
			senderId: sender.id,
			encryptedData: message.encryptedData,
			timestamp: Date.now(),
		};

		this.broadcast(broadcastMessage);
	}

	handleDisconnect(ws) {
		this.sessions.delete(ws);
		this.users.delete(ws);

		// 向其他用户广播用户列表更新
		this.broadcastUserList();
	}

	broadcast(message) {
		const messageStr = JSON.stringify(message);
		for (const session of this.sessions) {
			try {
				if (session.readyState === WebSocket.OPEN) {
					session.send(messageStr);
				}
			} catch (error) {
				// 连接已关闭，清理
				this.sessions.delete(session);
				this.users.delete(session);
			}
		}
	}

	broadcastUserList() {
		const users = Array.from(this.users.values()).map((user) => ({
			id: user.id,
			name: user.name,
			email: user.email,
			publicKey: user.publicKey,
		}));

		const message = {
			type: 'userList',
			users: users,
		};

		this.broadcast(message);
	}

	sendError(ws, message) {
		const errorMessage = {
			type: 'error',
			message: message,
		};

		try {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify(errorMessage));
			}
		} catch (error) {
			// 连接已关闭，忽略错误
		}
	}

	findUserById(id) {
		for (const user of this.users.values()) {
			if (user.id === id) {
				return user;
			}
		}
		return undefined;
	}

	isValidPGPPublicKey(publicKey) {
		return publicKey.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----') && publicKey.includes('-----END PGP PUBLIC KEY BLOCK-----');
	}

	isValidPGPMessage(message) {
		return message.includes('-----BEGIN PGP MESSAGE-----') && message.includes('-----END PGP MESSAGE-----');
	}

	extractUserProfile(publicKey) {
		try {
			// 尝试从公钥中提取用户信息
			const lines = publicKey.split('\n');
			let name = `User_${Math.random().toString(36).substr(2, 8)}`;
			let email = `${name.toLowerCase()}@example.com`;

			// 尝试从公钥注释中提取用户信息
			for (const line of lines) {
				if (line.includes('Comment:') || line.includes('Name:')) {
					const match = line.match(/([\w\s]+)\s*<([^>]+)>/);
					if (match) {
						name = match[1].trim();
						email = match[2].trim();
					}
				}
			}

			// 生成唯一ID
			const id = crypto.createHash('md5').update(publicKey).digest('hex').toUpperCase().substring(0, 16);

			return { id, name, email };
		} catch (error) {
			console.error('Error extracting user profile:', error);
			return {
				id: crypto.createHash('md5').update(publicKey).digest('hex').toUpperCase().substring(0, 16),
				name: `User_${Math.random().toString(36).substr(2, 8)}`,
				email: `user@example.com`,
			};
		}
	}
}

// 处理 WebSocket 连接 - 修复路径匹配
wss.on('connection', (ws, req) => {
	console.log('New WebSocket connection attempt');
	console.log('Request URL:', req.url);

	// 从 URL 中提取房间ID
	// 支持多种路径格式：
	// /api/room/ROOM_ID/websocket
	// /websocket?roomId=ROOM_ID
	let roomId = null;

	// 尝试匹配标准路径
	const pathMatch = req.url.match(/^\/api\/room\/([a-zA-Z0-9]{64})\/websocket/);
	if (pathMatch) {
		roomId = pathMatch[1];
		console.log('Found room ID from path:', roomId);
	} else {
		// 尝试从查询参数获取
		try {
			const url = new URL(req.url, `http://${req.headers.host}`);
			roomId = url.searchParams.get('roomId');
			if (roomId) {
				console.log('Found room ID from query:', roomId);
			}
		} catch (e) {
			console.error('Error parsing URL:', e);
		}
	}

	if (!roomId || roomId.length !== 64) {
		console.error('Invalid or missing room ID. URL:', req.url);
		ws.send(JSON.stringify({ type: 'error', message: 'Invalid room ID' }));
		ws.close(1000, 'Invalid room ID');
		return;
	}

	// 获取或创建房间
	if (!rooms.has(roomId)) {
		console.log('Creating new room:', roomId);
		rooms.set(roomId, new ChatRoom(roomId));
	}

	const room = rooms.get(roomId);
	room.handleSession(ws);

	console.log(`Client connected to room: ${roomId}`);
});

// 定期清理空房间
setInterval(() => {
	for (const [roomId, room] of rooms.entries()) {
		if (room.sessions.size === 0) {
			rooms.delete(roomId);
			console.log(`Cleaned up empty room: ${roomId}`);
		}
	}
}, 60000); // 每分钟清理一次

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
	console.log(`Server is running on port ${PORT}`);
	console.log(`WebSocket server is ready`);
	console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
