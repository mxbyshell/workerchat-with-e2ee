// 权限
export enum Permission {
    VIEW_MESSAGES = 'view_messages',
    SEND_MESSAGES = 'send_messages', 
    BAN_USERS = 'ban_users',
    GENERATE_INVITE_LINKS = 'generate_invite_links',
    MANAGE_PERMISSIONS = 'manage_permissions'
}
// 用户组
export enum UserRole {
    GUEST = 'guest',
    USER = 'user', 
    ADMIN = 'admin'
}

// 权限组配置
export interface RoleConfig {
    name: string;
    permissions: Permission[];
    description: string;
}

// IP(含v6/v4支持)
export interface IP {
    v6?: string;
    v4: string;
}

// 邀请链接
export interface InviteLink {
    id: string;
    role: UserRole;
    createdBy: string;
    createdAt: number;
    expiresAt?: number;
    usageCount: number;
    maxUsage?: number;
}

// 用户信息
export interface UserInfo {
    id: string;
    name: string;
    email: string;
    publicKey: string;
    webSocket: WebSocket;
    role: UserRole;  // 新增角色字段
    ipAddress?: IP;  // 新增IP字段用于封禁
}

// 封禁记录
export interface BanRecord {
    type: 'ip' | 'keyFingerprint';
    // 禁止简写！！！
    value: IP|string;
}

// 用户信息
export interface UserProfile {
    id: string; // 即keyid(long)
    name: string;
    email: string;
}

export interface RegisterMessage {
    type: 'register';
    publicKey: string;
}

export interface RegisteredMessage {
    type: 'registered';
    profile: UserProfile;
}

export interface UserListMessage {
    type: 'userList';
    users: Array<{
        id: string;
        name: string;
        email: string;
        publicKey: string;
    }>;
}

export interface ChatMessage {
    type: 'message';
    encryptedData: string;
}

// 加密信息
export interface EncryptedMessage {
    type: 'encryptedMessage';
    senderId: string;
    encryptedData: string;
    timestamp: number;
}

export interface ErrorMessage {
    type: 'error';
    message: string;
}

