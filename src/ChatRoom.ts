import {UserInfo, RegisterMessage, ChatMessage, RegisteredMessage, UserListMessage, EncryptedMessage, ErrorMessage, UserProfile, UserRole} from "./models";
import {readKey} from "openpgp";
export class ChatRoom {
    private state: DurableObjectState;
    private users: Map<WebSocket, UserInfo> = new Map();
    private sessions: Set<WebSocket> = new Set();

    constructor(state: DurableObjectState) {
        this.state = state;
    }

    
    async fetch(request: Request): Promise<Response> {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected websocket', { status: 400 });
        }

        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);

        this.handleSession(server);

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    private handleSession(webSocket: WebSocket): void {
        webSocket.accept();
        this.sessions.add(webSocket);

        webSocket.addEventListener('message', (event) => {
            try {
                const message = JSON.parse(event.data as string);
                this.handleMessage(webSocket, message);
            } catch (error) {
                this.sendError(webSocket, 'Invalid JSON format');
            }
        });

        webSocket.addEventListener('close', () => {
            this.handleDisconnect(webSocket);
        });

        webSocket.addEventListener('error', () => {
            this.handleDisconnect(webSocket);
        });
    }

    private handleMessage(webSocket: WebSocket, message: any): void {
        switch (message.type) {
            case 'register':
                this.handleRegister(webSocket, message);
                break;
            case 'getUsers':
                this.handleGetUsers(webSocket);
                break;
            case 'message':
                this.handleChatMessage(webSocket, message);
                break;
            default:
                this.sendError(webSocket, `Unknown message type: ${message.type}`);
        }
    }

    private async handleRegister(webSocket: WebSocket, message: RegisterMessage): Promise<void> {
        try {
            if (!message.publicKey || typeof message.publicKey !== 'string') {
                this.sendError(webSocket, 'Invalid public key format');
                return;
            }

            // 验证公钥格式
            if (!this.isValidPGPPublicKey(message.publicKey)) {
                this.sendError(webSocket, 'Invalid PGP public key format');
                return;
            }

            // 从公钥中提取用户信息
            const userProfile = await this.extractUserProfile(message.publicKey);
            
            const userInfo: UserInfo = {
                id: userProfile.id,
                name: userProfile.name,
                email: userProfile.email,
                publicKey: message.publicKey,
                webSocket: webSocket,
                role: UserRole.GUEST// 默认Guest
            };
            
            // 检查用户是否已存在
            const existingUser = this.findUserById(userInfo.id);
            if (existingUser && existingUser.webSocket !== webSocket) {
                // 更新现有用户的连接
                this.users.delete(existingUser.webSocket);
                existingUser.webSocket.close();
            }

            this.users.set(webSocket, userInfo);

            // 发送注册成功响应
            const response: RegisteredMessage = {
                type: 'registered',
                profile: {
                    id: userInfo.id,
                    name: userInfo.name,
                    email: userInfo.email
                }
            };
            
            webSocket.send(JSON.stringify(response));

            // 向其他用户广播用户列表更新
            this.broadcastUserList();

        } catch (error) {
            this.sendError(webSocket, 'Registration failed');
        }
    }

    private handleGetUsers(webSocket: WebSocket): void {
        const users = Array.from(this.users.values()).map(user => ({
            id: user.id,
            name: user.name,
            email: user.email,
            publicKey: user.publicKey
        }));

        const response: UserListMessage = {
            type: 'userList',
            users: users
        };

        webSocket.send(JSON.stringify(response));
    }

    private handleChatMessage(webSocket: WebSocket, message: ChatMessage): void {
        const sender = this.users.get(webSocket);
        if (!sender) {
            this.sendError(webSocket, 'User not registered');
            return;
        }

        if (!message.encryptedData || typeof message.encryptedData !== 'string') {
            this.sendError(webSocket, 'Invalid encrypted data format');
            return;
        }

        // 验证加密消息格式
        if (!this.isValidPGPMessage(message.encryptedData)) {
            this.sendError(webSocket, 'Invalid PGP message format');
            return;
        }

        // 广播加密消息给所有用户
        const broadcastMessage: EncryptedMessage = {
            type: 'encryptedMessage',
            senderId: sender.id,
            encryptedData: message.encryptedData,
            timestamp: Date.now()
        };

        this.broadcast(broadcastMessage);
    }

    private handleDisconnect(webSocket: WebSocket): void {
        this.sessions.delete(webSocket);
        this.users.delete(webSocket);
        
        // 向其他用户广播用户列表更新
        this.broadcastUserList();
    }

    private broadcast(message: any): void {
        const messageStr = JSON.stringify(message);
        for (const session of this.sessions) {
            try {
                session.send(messageStr);
            } catch (error) {
                // 连接已关闭，清理
                this.sessions.delete(session);
                this.users.delete(session);
            }
        }
    }

    private broadcastUserList(): void {
        const users = Array.from(this.users.values()).map(user => ({
            id: user.id,
            name: user.name,
            email: user.email,
            publicKey: user.publicKey
        }));

        const message: UserListMessage = {
            type: 'userList',
            users: users
        };

        this.broadcast(message);
    }

    private sendError(webSocket: WebSocket, message: string): void {
        const errorMessage: ErrorMessage = {
            type: 'error',
            message: message
        };
        
        try {
            webSocket.send(JSON.stringify(errorMessage));
        } catch (error) {
            // 连接已关闭，忽略错误
        }
    }

    private findUserById(id: string): UserInfo | undefined {
        for (const user of this.users.values()) {
            if (user.id === id) {
                return user;
            }
        }
        return undefined;
    }

    private isValidPGPPublicKey(publicKey: string): boolean {
        return publicKey.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----') &&
               publicKey.includes('-----END PGP PUBLIC KEY BLOCK-----');
    }

    private isValidPGPMessage(message: string): boolean {
        return message.includes('-----BEGIN PGP MESSAGE-----') &&
               message.includes('-----END PGP MESSAGE-----');
    }

    private async extractUserProfile(publicKeyArmored: string): Promise<UserProfile> {
        try {
            // 解析公钥
            const publicKey = await readKey({ armoredKey: publicKeyArmored });
            
            // 获取主用户ID（通常是第一个用户ID）
            const primaryUser = await publicKey.getPrimaryUser();
            const userID = primaryUser.user.userID;
            
            // 从用户ID中提取信息
            let name = '';
            let email = '';
            let id = '';
            
            if (userID) {
                // 解析用户ID字符串，格式通常是 "Name <email>"
                const userIdString = userID.userID || '';
                const match = userIdString.match(/^(.+?)\s*<([^>]+)>$/);
                
                if (match) {
                    name = match[1].trim();
                    email = match[2].trim();
                } else {
                    // 如果没有匹配到标准格式，尝试其他解析方式
                    if (userIdString.includes('@')) {
                        // 如果包含@符号，可能只是一个邮箱
                        email = userIdString.trim();
                        name = email.split('@')[0];
                    } else {
                        // 否则当作名字处理
                        name = userIdString.trim();
                    }
                }
            }
            
            // 生成唯一ID，使用公钥指纹或密钥ID
            id = publicKey.getFingerprint().toUpperCase();
            // 或者使用密钥ID：id = publicKey.getKeyID().toHex().toUpperCase();
            
            // 如果没有提取到有效信息，生成默认值
            if (!name) {
                name = `User_${Math.random().toString(36).substr(2, 8)}`;
            }
            if (!email) {
                email = `${name.toLowerCase().replace(/\s+/g, '')}@example.com`;
            }
            
            return { id, name, email };
            
        } catch (error) {
            console.error('解析公钥时出错:', error);
            
            // 如果解析失败，回退到原来的简单方法
            return this.fallbackExtractUserProfile(publicKeyArmored);
        }
    }
    
    // 备用方法，当OpenPGP解析失败时使用
    private fallbackExtractUserProfile(publicKey: string): UserProfile {
        const lines = publicKey.split('\n');
        let name = `User_${Math.random().toString(36).substr(2, 8)}`;
        let email = `${name.toLowerCase()}@example.com`;
        let id = this.generateUserIdFromKey(publicKey);
    
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
    
        return { id, name, email };
    }

    
    private generateUserIdFromKey(publicKey: string): string {
        // 简化的ID生成，基于公钥内容的哈希
        let hash = 0;
        for (let i = 0; i < publicKey.length; i++) {
            const char = publicKey.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转换为32位整数
        }
        return Math.abs(hash).toString(16).padStart(8, '0');
    }
}
