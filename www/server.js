#!/usr/bin/env node
/**
 * 交维大师 - 本地 HTTP 服务器
 * 轻量级静态文件服务，支持 fetch/JSON 动态加载
 * 预留 /api/ 路由接口（未来工单系统）
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ========== 配置 ==========
const DEFAULT_PORT = 8080;
const MAX_PORT_RETRY = 3;  // 端口被占用时，最多尝试 +1, +2, +3
const ROOT_DIR = __dirname;  // server.js 所在目录
const DATA_DIR = path.join(__dirname, '_data');
const CERTS_DIR = path.join(__dirname, 'certs');  // SSL 证书目录
const JWT_SECRET = 'delivery-ops-master-2026';  // 简易认证密钥（生产环境需更换）
const TOKEN_EXPIRY_DAYS = 7;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
};

// ========== JSON Store (内存缓存 + 原子写入) ==========
const jsonStore = {
  cache: {},
  dir: DATA_DIR,

  /** 启动时加载所有 JSON 到内存 */
  init() {
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'));
    files.forEach(f => {
      try {
        this.cache[f] = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
      } catch(e) {
        console.warn(`[Store] Failed to load ${f}:`, e.message);
        this.cache[f] = null;
      }
    });
    console.log(`[Store] Loaded ${files.length} JSON files into memory cache`);
  },

  /** 读取（走内存） */
  get(filename) {
    return this.cache[filename];
  },

  /** 写入（内存 + 异步落盘，.tmp + copyFile+unlink，兼容中文路径） */
  async set(filename, data) {
    this.cache[filename] = data;
    return new Promise((resolve, reject) => {
      const filePath = path.join(this.dir, filename);
      const tmpPath = filePath + '.tmp';
      const jsonStr = JSON.stringify(data, null, 2);
      fs.writeFile(tmpPath, jsonStr, 'utf8', (err) => {
        if (err) return reject(err);
        // Windows 中文路径 rename 可能失败，改用 copyFile + unlink
        fs.copyFile(tmpPath, filePath, (err2) => {
          if (err2) return reject(err2);
          fs.unlink(tmpPath, () => resolve()); // 清理 tmp，忽略错误
        });
      });
    });
  }
};

// ========== 工具函数 ==========

/** 解析请求 Body（JSON）*/
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 解析 URL，返回本地文件路径 */
function getFilePath(url) {
  // 去掉 query string 和 hash
  const cleanUrl = url.split('?')[0].split('#')[0];
  let filePath = path.join(ROOT_DIR, cleanUrl === '/' ? 'index.html' : cleanUrl);
  
  // 防止目录遍历攻击
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ROOT_DIR)) {
    return null;
  }
  return resolved;
}

/** 发送文件内容 */
function sendFile(res, filePath, statusCode) {
  statusCode = statusCode || 200;
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  
  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // 文件不存在 → SPA 回退到 index.html（未来用）
        if (!ext || ext === '.html') {
          const indexPath = path.join(ROOT_DIR, 'index.html');
          sendFile(res, indexPath, 200);
          return;
        }
        res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
        res.end('404 Not Found');
        return;
      }
      res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'});
      res.end('500 Internal Server Error');
      return;
    }
    
    res.writeHead(statusCode, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',  // CORS（未来跨域访问用）
    });
    res.end(content);
  });
}

/** 发送 JSON 响应 */
function sendJson(res, data, statusCode) {
  statusCode = statusCode || 200;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

/** 发送错误 JSON */
function sendError(res, message, statusCode) {
  statusCode = statusCode || 500;
  sendJson(res, { error: message }, statusCode);
}

/** 验证文件名是否合法（防止目录遍历，允许 _data 目录下所有 .json 文件）*/
function validateDataFile(filename) {
  if (!filename.endsWith('.json')) return null;
  const filePath = path.join(DATA_DIR, filename);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(DATA_DIR))) return null;
  return resolved;
}

/** 读取 JSON 数据文件（走内存缓存） */
async function readDataFile(filePath) {
  const filename = path.basename(filePath);
  const data = jsonStore.get(filename);
  if (data === undefined || data === null) {
    if (filePath.endsWith('projects.json') || filePath.endsWith('reports.json')) return {};
    return [];
  }
  return data;
}

/** 写入 JSON 数据文件（内存 + 落盘） */
async function writeDataFile(filePath, data) {
  const filename = path.basename(filePath);
  return jsonStore.set(filename, data);
}

/** 按 id 查找记录索引 */
function findIndexById(arr, id) {
  return arr.findIndex(item => item.id === id);
}

/**
 * 统一数据层 API 路由
 * 
 * GET    /api/data/:file           → 读取数据
 * POST   /api/data/:file           → 覆盖写入（全量更新）
 * PATCH  /api/data/:file           → 部分更新（按 body.id 匹配）
 * POST   /api/data/:file/add       → 追加一条记录
 * DELETE /api/data/:file/:id       → 删除一条记录（按 id 匹配）
 */
async function handleApiRoute(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const method = req.method;
  
  // 解析路径：/api/data/:file 或 /api/data/:file/:id
  const match = pathname.match(/^\/api\/data\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    sendError(res, 'Invalid API path. Use /api/data/:file', 400);
    return;
  }
  
  const filename = match[1];
  const idParam = match[2] || null;  // DELETE 时的 id 参数
  
  const filePath = validateDataFile(filename);
  if (!filePath) {
    sendError(res, `File not allowed: ${filename}`, 403);
    return;
  }
  
  try {
    // 认证检查 — 除了白名单文件，其他都需要认证
    const PUBLIC_FILES = ['manifest.json', 'brand-spec.json', 'projects.json'];
    const isPublic = PUBLIC_FILES.includes(filename);

    let authUser = null;
    if (!isPublic) {
      authUser = requireAuth(req, res);
      if (!authUser) return;
    }

    if (method === 'GET') {
      // GET /api/data/:file → 读取数据（自动按项目过滤）
      const data = await readDataFile(filePath);
      const filtered = authUser ? filterByProject(data, authUser) : data;
      sendJson(res, filtered);
      
    } else if (method === 'POST' && pathname.endsWith('/add')) {
      // POST /api/data/:file/add → 追加一条记录（需认证）
      if (!authUser) return;
      if (authUser.role !== 'admin') { sendError(res, '仅管理员可写入数据', 403); return; }

      const body = await parseBody(req);
      if (!body.id) {
        sendError(res, 'Missing required field: id', 400);
        return;
      }
      const data = await readDataFile(filePath);
      if (!Array.isArray(data)) {
        sendError(res, 'Cannot add to non-array data', 400);
        return;
      }
      // 检查 id 是否已存在
      if (findIndexById(data, body.id) !== -1) {
        sendError(res, `Record with id=${body.id} already exists`, 409);
        return;
      }
      data.push(body);
      await writeDataFile(filePath, data);
      sendJson(res, { success: true, message: 'Record added', id: body.id });
      
    } else if (method === 'POST') {
      // POST /api/data/:file → 覆盖写入（仅管理员）
      if (!authUser) return;
      if (authUser.role !== 'admin') { sendError(res, '仅管理员可写入数据', 403); return; }

      const body = await parseBody(req);
      await writeDataFile(filePath, body);
      sendJson(res, { success: true, message: 'Data overwritten' });
      
    } else if (method === 'PATCH') {
      // PATCH /api/data/:file → 部分更新（仅管理员）
      if (!authUser) return;
      if (authUser.role !== 'admin') { sendError(res, '仅管理员可修改数据', 403); return; }

      const body = await parseBody(req);
      if (!body.id) {
        sendError(res, 'Missing required field: id', 400);
        return;
      }
      const data = await readDataFile(filePath);
      if (!Array.isArray(data)) {
        sendError(res, 'Cannot update non-array data', 400);
        return;
      }
      const idx = findIndexById(data, body.id);
      if (idx === -1) {
        sendError(res, `Record with id=${body.id} not found`, 404);
        return;
      }
      // 合并更新（保留未修改的字段）
      data[idx] = { ...data[idx], ...body, updated_at: new Date().toISOString().split('T')[0] };
      await writeDataFile(filePath, data);
      sendJson(res, { success: true, message: 'Record updated', id: body.id });
      
    } else if (method === 'DELETE' && idParam) {
      // DELETE /api/data/:file/:id → 删除一条记录（仅管理员）
      if (!authUser) return;
      if (authUser.role !== 'admin') { sendError(res, '仅管理员可删除数据', 403); return; }

      const data = await readDataFile(filePath);
      if (!Array.isArray(data)) {
        sendError(res, 'Cannot delete from non-array data', 400);
        return;
      }
      const idx = findIndexById(data, idParam);
      if (idx === -1) {
        sendError(res, `Record with id=${idParam} not found`, 404);
        return;
      }
      data.splice(idx, 1);
      await writeDataFile(filePath, data);
      sendJson(res, { success: true, message: 'Record deleted', id: idParam });
      
    } else {
      sendError(res, `Method ${method} not allowed for this path`, 405);
    }
  } catch (err) {
    console.error(`[API Error] ${method} ${pathname}:`, err);
    sendError(res, err.message, 500);
  }
}

// ========== 认证与权限系统（Multi-Tenant RBAC）==========

// 简易认证（MVP版本，生产环境需升级）
const crypto = require('crypto');

/** SHA-256 哈希 */
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/** 验证密码
 *  客户端发送的是 SHA-256 哈希值，直接比对即可（不再二次哈希）
 */
function comparePassword(clientHashedPwd, storedHash) {
  return clientHashedPwd === storedHash;
}

/** 密码策略验证：最少8位，必须包含数字和字母 */
function validatePasswordPolicy(password) {
  if (!password || password.length < 8) return false;
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  return hasLetter && hasNumber;
}

/** 生成简单 token（base64编码用户完整信息+过期时间）*/
function generateToken(user, allowedProjects, permissions, tier, clientId, language) {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    clientId: clientId || null,
    tier: tier || null,
    language: language || 'zh',
    allowedProjects: allowedProjects || [],
    permissions: permissions || [],
    exp: Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/** 验证 token */
function verifyToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

/** 从请求头提取 token */
function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.substring(7);
}

/**
 * 按角色获取权限列表
 */
function getPermissionsForRole(role) {
  const PERMISSIONS = {
    admin: [
      'project-map:read', 'weekly-report:read', 'daily-report:read',
      'demand:create', 'demand:read', 'demand:update', 'demand:delete',
      'ticket:create', 'ticket:read', 'ticket:update', 'ticket:delete', 'ticket:comment',
      'feedback:create', 'feedback:read', 'feedback:update', 'feedback:delete',
      'kanban:create', 'kanban:read', 'kanban:update', 'kanban:delete',
      'license:create', 'license:read', 'license:update', 'license:delete',
      'material:read', 'material:create', 'material:update', 'material:delete',
      'inspection:read', 'inspection:create', 'inspection:update', 'inspection:delete',
      'admin:manage', 'user:manage', 'client:manage', 'access:manage'
    ],
    diamond: [
      'project-map:read', 'weekly-report:read', 'daily-report:read',
      'demand:create', 'demand:read',
      'ticket:create', 'ticket:read', 'ticket:comment',
      'feedback:create', 'feedback:read',
      'kanban:read',
      'material:read'
    ],
    gold: [
      'project-map:read', 'weekly-report:read', 'daily-report:read',
      'demand:create', 'demand:read',
      'ticket:create', 'ticket:read',
      'feedback:create', 'feedback:read'
    ],
    silver: [
      'project-map:read', 'weekly-report:read', 'daily-report:read',
      'demand:read',
      'feedback:create', 'feedback:read'
    ]
  };
  return PERMISSIONS[role] || [];
}

/**
 * 核心数据过滤函数 — 项目隔离
 * 支持扁平数组和嵌套结构（{ issues: [...], demands: [...] }）
 */
function filterByProject(data, user) {
  if (user.role === 'admin') return data;
  const allowed = user.allowedProjects || [];

  if (Array.isArray(data)) {
    const filtered = data.filter(item => !item.project || allowed.includes(item.project));
    // 安全审计：记录被过滤掉的项目数
    const blocked = data.length - filtered.length;
    if (blocked > 0) {
      console.warn(`[SECURITY] User ${user.username} (clientId=${user.clientId}) blocked from ${blocked} cross-project records`);
    }
    return filtered;
  }

  // 处理嵌套结构（如 { issues: [...], demands: [...] }）
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const result = { ...data };
    const ARRAY_FIELDS = ['issues', 'demands', 'tickets', 'comments', 'all_issues', 'all_demands'];
    for (const key of ARRAY_FIELDS) {
      if (Array.isArray(result[key])) {
        const before = result[key].length;
        result[key] = result[key].filter(item => !item.project || allowed.includes(item.project));
        const after = result[key].length;
        if (before - after > 0) {
          console.warn(`[SECURITY] User ${user.username} blocked from ${before - after} records in ${key}`);
        }
      }
    }
    return result;
  }

  return data;
}

/**
 * 核心权限检查函数
 */
function checkPermission(user, action, module) {
  if (user.role === 'admin') return true;
  const permKey = module + ':' + action;
  return (user.permissions || []).includes(permKey);
}

/** 认证中间件（返回 user 对象或 null，并发送 401） */
function requireAuth(req, res) {
  const token = extractToken(req);
  if (!token) {
    sendError(res, '未提供认证令牌', 401);
    return null;
  }
  const user = verifyToken(token);
  if (!user) {
    sendError(res, '认证令牌无效或已过期', 401);
    return null;
  }
  return user;
}

/** 管理员权限检查中间件 */
function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendError(res, '仅管理员可执行此操作', 403);
    return null;
  }
  return user;
}

/**
 * 认证路由处理
 * POST /api/auth/login          — 登录（SHA-256 比对）
 * POST /api/auth/register        — 注册（仅管理员）
 * GET  /api/auth/me              — 获取当前用户信息（含权限列表）
 * POST /api/auth/change-password — 修改密码
 */
async function handleAuthRoute(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const method = req.method;

  try {
    if (method === 'POST' && pathname === '/api/auth/login') {
      // ===== 登录 =====
      const body = await parseBody(req);
      const { username, password } = body;

      if (!username || !password) {
        sendError(res, '用户名和密码不能为空', 400);
        return;
      }

      const users = jsonStore.get('users.json') || [];
      const user = users.find(u => u.username === username && u.active !== false);

      if (!user || !comparePassword(password, user.password)) {
        sendError(res, '用户名或密码错误', 401);
        return;
      }

      // 加载用户的项目权限
      let allowedProjects = [];
      let tier = null;
      let clientId = user.clientId || null;

      if (user.role !== 'admin' && user.clientId) {
        const clients = jsonStore.get('clients.json') || [];
        const client = clients.find(c => c.id === user.clientId);
        if (client) {
          tier = client.tier;
          // 优先使用用户个人配置的 allowedProjects（支持同一客户多账号不同权限）
          if (user.allowedProjects && Array.isArray(user.allowedProjects) && user.allowedProjects.length > 0) {
            allowedProjects = user.allowedProjects;
          } else {
            // 回退：从 access.json 按 clientId 计算（向后兼容）
            const accessList = (jsonStore.get('access.json') || []).filter(
              a => a.clientId === user.clientId && a.active
            );
            allowedProjects = accessList.map(a => a.projectId);
          }
        }
      }

      // 生成权限列表
      const permissions = getPermissionsForRole(user.role);

      // 生成增强 token
      const token = generateToken(user, allowedProjects, permissions, tier, clientId, user.language);

      // 更新最后登录时间
      user.lastLogin = new Date().toISOString();
      await jsonStore.set('users.json', users);

      // 返回完整用户信息（不含密码哈希）
      sendJson(res, {
        success: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          clientId: clientId,
          tier: tier,
          language: user.language,
          email: user.email,
          needChangePwd: user.needChangePwd || false,
          allowedProjects: allowedProjects,
          permissions: permissions
        }
      });

    } else if (method === 'POST' && pathname === '/api/auth/register') {
      // ===== 注册（仅管理员可调用） =====
      const adminUser = requireAdmin(req, res);
      if (!adminUser) return;

      const body = await parseBody(req);
      const { username, password, role, displayName, clientId, email, language } = body;

      if (!username || !password) {
        sendError(res, '用户名和密码不能为空', 400);
        return;
      }

      // 密码策略验证
      if (!validatePasswordPolicy(password)) {
        sendError(res, '密码不符合策略：至少8位，必须包含数字和字母', 400);
        return;
      }

      // 验证角色
      const validRoles = ['admin', 'diamond', 'gold', 'silver'];
      if (role && !validRoles.includes(role)) {
        sendError(res, `无效的角色，可选: ${validRoles.join(', ')}`, 400);
        return;
      }

      const users = jsonStore.get('users.json') || [];

      if (users.find(u => u.username === username)) {
        sendError(res, '用户名已存在', 409);
        return;
      }

      const newUser = {
        id: users.length > 0 ? Math.max(...users.map(u => u.id)) + 1 : 1,
        username,
        password: password,  // 前端已发送 SHA-256 哈希，直接存储
        displayName: displayName || username,
        role: role || 'silver',
        clientId: clientId || null,
        language: language || 'zh',
        email: email || '',
        active: true,
        needChangePwd: true,
        lastLogin: null,
        createdAt: new Date().toISOString().split('T')[0]
      };

      users.push(newUser);
      await jsonStore.set('users.json', users);

      const { password: _, ...userInfo } = newUser;
      sendJson(res, { success: true, message: '用户创建成功', user: userInfo });

    } else if (method === 'POST' && pathname === '/api/auth/change-password') {
      // ===== 修改密码 =====
      const currentUser = requireAuth(req, res);
      if (!currentUser) return;

      const body = await parseBody(req);
      const { oldPassword, newPassword } = body;

      if (!oldPassword || !newPassword) {
        sendError(res, '旧密码和新密码不能为空', 400);
        return;
      }

      if (!validatePasswordPolicy(newPassword)) {
        sendError(res, '新密码不符合策略：至少8位，必须包含数字和字母', 400);
        return;
      }

      const users = jsonStore.get('users.json') || [];
      const user = users.find(u => u.id === currentUser.id);

      if (!user) {
        sendError(res, '用户不存在', 404);
        return;
      }

      // 旧密码比对（前端发送 SHA-256 哈希，直接比对）
      if (user.password !== oldPassword) {
        sendError(res, '旧密码错误', 401);
        return;
      }

      user.password = hashPassword(newPassword);
      user.needChangePwd = false;
      await jsonStore.set('users.json', users);

      // 重新生成 token（needChangePwd 已变）
      let allowedProjects = [];
      let tier = null;
      if (user.role !== 'admin' && user.clientId) {
        const clients = jsonStore.get('clients.json') || [];
        const client = clients.find(c => c.id === user.clientId);
        if (client) {
          tier = client.tier;
          // 优先使用用户个人配置的 allowedProjects
          if (user.allowedProjects && Array.isArray(user.allowedProjects) && user.allowedProjects.length > 0) {
            allowedProjects = user.allowedProjects;
          } else {
            const accessList = (jsonStore.get('access.json') || []).filter(
              a => a.clientId === user.clientId && a.active
            );
            allowedProjects = accessList.map(a => a.projectId);
          }
        }
      }
      const permissions = getPermissionsForRole(user.role);
      const token = generateToken(user, allowedProjects, permissions, tier, user.clientId, user.language);

      sendJson(res, {
        success: true,
        message: '密码修改成功',
        token,
        user: {
          id: user.id, username: user.username, displayName: user.displayName,
          role: user.role, clientId: user.clientId, tier, language: user.language,
          email: user.email, needChangePwd: false,
          allowedProjects, permissions
        }
      });

    } else if (method === 'GET' && pathname === '/api/auth/me') {
      // ===== 获取当前用户完整信息 =====
      const token = extractToken(req);
      if (!token) { sendError(res, '未登录', 401); return; }

      const user = verifyToken(token);
      if (!user) { sendError(res, '认证失败', 401); return; }

      sendJson(res, {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        clientId: user.clientId,
        tier: user.tier,
        language: user.language,
        allowedProjects: user.allowedProjects || [],
        permissions: user.permissions || []
      });

    } else {
      sendError(res, `不支持的认证请求: ${method} ${pathname}`, 405);
    }
  } catch (err) {
    console.error(`[Auth API Error] ${method} ${pathname}:`, err);
    sendError(res, err.message, 500);
  }
}

/**
 * 工单路由处理
 * GET    /api/issues           — 获取工单列表（支持筛选）
 * POST   /api/issues           — 创建工单
 * GET    /api/issues/:id       — 获取单个工单详情
 * PUT    /api/issues/:id       — 更新工单
 * DELETE /api/issues/:id       — 删除工单
 * POST   /api/issues/:id/comments — 添加评论
 * GET    /api/issues/:id/comments — 获取评论列表
 */
async function handleIssuesRoute(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const method = req.method;

  // 所有工单操作需要认证
  const authUser = requireAuth(req, res);
  if (!authUser) return;

  // silver 角色不可见工单
  if (authUser.role === 'silver') {
    sendError(res, '您的权限无法访问工单模块', 403);
    return;
  }

  // 解析路径参数
  const issueMatch = pathname.match(/^\/api\/issues\/(\d+)(?:\/(comments))?$/);
  const isListRequest = pathname === '/api/issues' && method === 'GET';
  const isCreateRequest = pathname === '/api/issues' && method === 'POST';
  
  try {
    if (isListRequest) {
      // GET /api/issues — 获取工单列表
      const issues = await readDataFile(path.join(DATA_DIR, 'issues.json'));
      
      // 支持筛选参数
      const project = urlObj.searchParams.get('project');
      const status = urlObj.searchParams.get('status');
      const priority = urlObj.searchParams.get('priority');
      
      let filtered = issues;
      if (project) {
        filtered = filtered.filter(i => i.project === project);
      }
      if (status) {
        filtered = filtered.filter(i => i.status === status);
      }
      if (priority) {
        filtered = filtered.filter(i => i.priority === priority);
      }

      // 项目隔离过滤
      filtered = filterByProject(filtered, authUser);

      sendJson(res, filtered);
      
    } else if (isCreateRequest) {
      // POST /api/issues — 创建工单
      const body = await parseBody(req);
      const { project, title, description, priority, assigned_to } = body;
      
      if (!title || !description) {
        sendError(res, '标题和描述为必填项', 400);
        return;
      }
      
      const issues = await readDataFile(path.join(DATA_DIR, 'issues.json'));
      
      const newIssue = {
        id: issues.length > 0 ? Math.max(...issues.map(i => i.id)) + 1 : 1,
        project: project || '',
        title,
        description,
        status: '待处理',
        priority: priority || '中',
        created_by: body.created_by || null,
        assigned_to: assigned_to || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      issues.push(newIssue);
      await writeDataFile(path.join(DATA_DIR, 'issues.json'), issues);
      
      sendJson(res, {
        success: true,
        message: '工单创建成功',
        issue: newIssue
      });
      
    } else if (issueMatch && method === 'GET') {
      // GET /api/issues/:id — 获取单个工单
      const issueId = parseInt(issueMatch[1]);
      const issues = await readDataFile(path.join(DATA_DIR, 'issues.json'));
      const issue = issues.find(i => i.id === issueId);
      
      if (!issue) {
        sendError(res, `工单 ${issueId} 不存在`, 404);
        return;
      }
      
      sendJson(res, issue);
      
    } else if (issueMatch && method === 'PUT') {
      // PUT /api/issues/:id — 更新工单
      const issueId = parseInt(issueMatch[1]);
      const body = await parseBody(req);
      
      const issues = await readDataFile(path.join(DATA_DIR, 'issues.json'));
      const idx = issues.findIndex(i => i.id === issueId);
      
      if (idx === -1) {
        sendError(res, `工单 ${issueId} 不存在`, 404);
        return;
      }
      
      // 更新工单字段
      issues[idx] = {
        ...issues[idx],
        ...body,
        id: issueId,  // 防止 id 被修改
        updated_at: new Date().toISOString()
      };
      
      await writeDataFile(path.join(DATA_DIR, 'issues.json'), issues);
      
      sendJson(res, {
        success: true,
        message: '工单更新成功',
        issue: issues[idx]
      });
      
    } else if (issueMatch && method === 'DELETE') {
      // DELETE /api/issues/:id — 删除工单
      const issueId = parseInt(issueMatch[1]);
      const issues = await readDataFile(path.join(DATA_DIR, 'issues.json'));
      const idx = issues.findIndex(i => i.id === issueId);
      
      if (idx === -1) {
        sendError(res, `工单 ${issueId} 不存在`, 404);
        return;
      }
      
      issues.splice(idx, 1);
      await writeDataFile(path.join(DATA_DIR, 'issues.json'), issues);
      
      sendJson(res, {
        success: true,
        message: `工单 ${issueId} 已删除`
      });
      
    } else if (issueMatch && issueMatch[2] === 'comments' && method === 'GET') {
      // GET /api/issues/:id/comments — 获取评论列表
      const issueId = parseInt(issueMatch[1]);
      const comments = await readDataFile(path.join(DATA_DIR, 'comments.json'));
      const issueComments = comments.filter(c => c.issue_id === issueId);
      
      sendJson(res, issueComments);
      
    } else if (issueMatch && issueMatch[2] === 'comments' && method === 'POST') {
      // POST /api/issues/:id/comments — 添加评论
      const issueId = parseInt(issueMatch[1]);
      const body = await parseBody(req);
      const { content, user_id } = body;
      
      if (!content) {
        sendError(res, '评论内容不能为空', 400);
        return;
      }
      
      const comments = await readDataFile(path.join(DATA_DIR, 'comments.json'));
      
      const newComment = {
        id: comments.length > 0 ? Math.max(...comments.map(c => c.id)) + 1 : 1,
        issue_id: issueId,
        user_id: user_id || null,
        content,
        created_at: new Date().toISOString()
      };
      
      comments.push(newComment);
      await writeDataFile(path.join(DATA_DIR, 'comments.json'), comments);
      
      sendJson(res, {
        success: true,
        message: '评论添加成功',
        comment: newComment
      });
      
    } else {
      sendError(res, `不支持的工单请求: ${method} ${pathname}`, 405);
    }
  } catch (err) {
    console.error(`[Issues API Error] ${method} ${pathname}:`, err);
    sendError(res, err.message, 500);
  }
}

// ========== 日报索引自动同步 ==========
/**
 * 生成新 PMES 日报后，自动更新 reports/reports.json
 * 确保统计报告页面 (reports.html) 能立即看到新日报
 */
function syncReportsIndex(dateStr, htmlFilename, projectName) {
  const reportsJsonPath = path.join(ROOT_DIR, 'reports', 'reports.json');
  let data = { daily: [], weekly: [] };

  // 读取现有数据
  if (fs.existsSync(reportsJsonPath)) {
    try { data = JSON.parse(fs.readFileSync(reportsJsonPath, 'utf-8')); } catch(e) {}
  }

  const project = projectName || '';

  // 项目名 → 配置名映射（用于三语label）
  const PROJECT_I18N = {
    'PMES POC':    { en: 'PMES POC', pt: 'PMES POC' },
    'Para Detran': { en: 'Para Detran', pt: 'Detran do Pará' },
    'PMBV':        { en: 'PMBV', pt: 'PMBV' },
    'Para Segup':  { en: 'Para Segup', pt: 'Segup do Pará' },
    'SEAP':        { en: 'SEAP', pt: 'SEAP' },
    'SESP':        { en: 'SESP', pt: 'SESP' },
  };

  const i18n = PROJECT_I18N[project] || { en: project, pt: project };

  // 检查是否已存在同日期同项目的条目
  const existingIdx = data.daily.findIndex(r =>
    r.project === project && r.date === dateStr
  );

  // 构造新的日报条目
  const [y, m, d] = dateStr.split('-');
  const newEntry = {
    project: project,
    projectEn: i18n.en,
    projectPt: i18n.pt,
    date: dateStr,
    label: `${y}年${m}月${d}日`,
    labelEn: `${['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m)]} ${Number(d)}, ${y}`,
    labelPt: `${Number(d)} ${['','Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][Number(m)]}, ${y}`,
    file: `modules/daily-reports/${htmlFilename}`,
    isLatest: true,
  };

  if (existingIdx >= 0) {
    data.daily[existingIdx] = newEntry;
  } else {
    data.daily.push(newEntry);
  }

  // 重置所有 isLatest 标记，只标记最新一条
  data.daily.forEach(r => { r.isLatest = false; });
  if (data.daily.length > 0) {
    data.daily[data.daily.length - 1].isLatest = true;
  }

  // 确保 reports 目录存在
  const reportsDir = path.dirname(reportsJsonPath);
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  fs.writeFileSync(reportsJsonPath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`[syncReportsIndex] Updated reports.json with ${dateStr} (${htmlFilename}), total daily: ${data.daily.length}`);
}

// ========== 日报生成 API ==========
const WORKSPACE_ROOT = path.resolve(ROOT_DIR, '..');
const PYTHON_EXE = 'python';

/**
 * POST /api/generate/daily
 * Body: { date: "YYYY-MM-DD", project: "PMES POC" } (均可选)
 * 通用日报生成 — 根据 project 路由到不同脚本
 */

/**
 * Admin 管理 API — 用户/客户/权限 CRUD（仅 admin）
 *
 * GET  /api/admin/users          — 用户列表（密码隐藏）
 * POST /api/admin/users         — 创建用户
 * PUT  /api/admin/users/:id      — 编辑用户
 * DELETE /api/admin/users/:id   — 删除（软删除/禁用）
 *
 * GET  /api/admin/clients       — 客户列表
 * POST /api/admin/clients        — 创建客户
 * PUT  /api/admin/clients/:id    — 编辑客户
 * DELETE /api/admin/clients/:id  — 删除客户
 *
 * GET  /api/admin/access         — 项目授权列表
 * POST /api/admin/access         — 新增项目授权
 * PUT  /api/admin/access/:id      — 编辑授权
 * DELETE /api/admin/access/:id   — 删除授权
 */
async function handleAdminRoute(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const method = req.method;

  // 所有 admin 路由必须验证 admin 权限
  const adminUser = requireAdmin(req, res);
  if (!adminUser) return;

  try {
    // ========================
    // 用户管理
    // ========================
    if (pathname === '/api/admin/users' && method === 'GET') {
      const users = jsonStore.get('users.json') || [];
      // 返回用户列表，隐藏密码
      const safeUsers = users.map(u => {
        const { password, ...safe } = u;
        return safe;
      });
      sendJson(res, safeUsers);
      return;
    }

    if (pathname === '/api/admin/users' && method === 'POST') {
      const body = await parseBody(req);
      const { username, password, role, displayName, clientId, email, language } = body;

      if (!username || !password || !role || !displayName) {
        sendError(res, '缺少必填字段：username, password, role, displayName', 400);
        return;
      }

      // 验证密码策略
      if (!validatePasswordPolicy(password)) {
        sendError(res, '密码不符合策略：至少8位，需包含字母和数字', 400);
        return;
      }

      const users = jsonStore.get('users.json') || [];
      if (users.find(u => u.username === username)) {
        sendError(res, '用户名已存在', 409);
        return;
      }

      const validRoles = ['admin', 'diamond', 'gold', 'silver'];
      if (!validRoles.includes(role)) {
        sendError(res, '无效的角色：' + role, 400);
        return;
      }

      const newUser = {
        id: Math.max(0, ...users.map(u => u.id)) + 1,
        username,
        password, // 已是客户端 SHA-256 hash
        displayName,
        role,
        clientId: clientId || null,
        email: email || null,
        language: language || 'zh',
        active: true,
        needChangePwd: true,
        lastLogin: null,
        createdAt: new Date().toISOString().split('T')[0]
      };
      users.push(newUser);
      jsonStore.set('users.json', users);

      const { password: _, ...safe } = newUser;
      sendJson(res, safe, 201);
      return;
    }

    // PUT /api/admin/users/:id
    if (/^\/api\/admin\/users\/\d+$/.test(pathname) && method === 'PUT') {
      const userId = parseInt(pathname.split('/').pop());
      const body = await parseBody(req);
      const users = jsonStore.get('users.json') || [];
      const idx = users.findIndex(u => u.id === userId);
      if (idx === -1) { sendError(res, '用户不存在', 404); return; }

      // 不允许修改自己的角色（防止权限丢失）
      if (userId === adminUser.id && body.role && body.role !== adminUser.role) {
        sendError(res, '不能修改自己的角色', 400);
        return;
      }

      const allowed = ['displayName', 'role', 'clientId', 'email', 'language', 'active'];
      allowed.forEach(f => {
        if (body[f] !== undefined) users[idx][f] = body[f];
      });

      // 如果传了新密码（重置密码场景）
      if (body.password) {
        users[idx].password = body.password;
        users[idx].needChangePwd = true;
      }

      users[idx].updatedAt = new Date().toISOString().split('T')[0];
      jsonStore.set('users.json', users);

      const { password: _, ...safe } = users[idx];
      sendJson(res, safe);
      return;
    }

    // DELETE /api/admin/users/:id (软删除 → 禁用)
    if (/^\/api\/admin\/users\/\d+$/.test(pathname) && method === 'DELETE') {
      const userId = parseInt(pathname.split('/').pop());
      const users = jsonStore.get('users.json') || [];
      const idx = users.findIndex(u => u.id === userId);
      if (idx === -1) { sendError(res, '用户不存在', 404); return; }
      if (userId === adminUser.id) { sendError(res, '不能删除自己', 400); return; }

      users[idx].active = false;
      users[idx].updatedAt = new Date().toISOString().split('T')[0];
      jsonStore.set('users.json', users);

      const { password: _, ...safe } = users[idx];
      sendJson(res, { message: '用户已禁用', user: safe });
      return;
    }

    // ========================
    // 客户管理
    // ========================
    if (pathname === '/api/admin/clients' && method === 'GET') {
      const clients = jsonStore.get('clients.json') || [];
      sendJson(res, clients);
      return;
    }

    if (pathname === '/api/admin/clients' && method === 'POST') {
      const body = await parseBody(req);
      const { name, nameEn, namePt, shortName, tier, contactPerson, contactEmail, contactPhone, address, state } = body;

      if (!name || !shortName || !tier) {
        sendError(res, '缺少必填字段：name, shortName, tier', 400);
        return;
      }

      const clients = jsonStore.get('clients.json') || [];
      const validTiers = ['diamond', 'gold', 'silver'];
      if (!validTiers.includes(tier)) {
        sendError(res, '无效的 tier：' + tier, 400);
        return;
      }

      const newClient = {
        id: Math.max(0, ...clients.map(c => c.id)) + 1,
        name,
        nameEn: nameEn || '',
        namePt: namePt || '',
        shortName,
        contactPerson: contactPerson || '',
        contactPhone: contactPhone || '',
        contactEmail: contactEmail || '',
        address: address || '',
        state: state || '',
        tier,
        creditScore: 80,
        paymentStatus: 'good',
        contracts: [],
        notes: '',
        tags: [],
        createdAt: new Date().toISOString().split('T')[0],
        updatedAt: new Date().toISOString().split('T')[0]
      };
      clients.push(newClient);
      jsonStore.set('clients.json', clients);

      sendJson(res, newClient, 201);
      return;
    }

    // PUT /api/admin/clients/:id
    if (/^\/api\/admin\/clients\/\d+$/.test(pathname) && method === 'PUT') {
      const clientId = parseInt(pathname.split('/').pop());
      const body = await parseBody(req);
      const clients = jsonStore.get('clients.json') || [];
      const idx = clients.findIndex(c => c.id === clientId);
      if (idx === -1) { sendError(res, '客户不存在', 404); return; }

      const allowed = ['name', 'nameEn', 'namePt', 'shortName', 'tier', 'contactPerson',
        'contactEmail', 'contactPhone', 'address', 'state', 'creditScore', 'paymentStatus',
        'notes', 'tags', 'contracts'];
      allowed.forEach(f => {
        if (body[f] !== undefined) clients[idx][f] = body[f];
      });

      clients[idx].updatedAt = new Date().toISOString().split('T')[0];
      jsonStore.set('clients.json', clients);

      sendJson(res, clients[idx]);
      return;
    }

    // DELETE /api/admin/clients/:id
    if (/^\/api\/admin\/clients\/\d+$/.test(pathname) && method === 'DELETE') {
      const clientId = parseInt(pathname.split('/').pop());
      const clients = jsonStore.get('clients.json') || [];
      const idx = clients.findIndex(c => c.id === clientId);
      if (idx === -1) { sendError(res, '客户不存在', 404); return; }

      // 检查是否有关联用户
      const users = jsonStore.get('users.json') || [];
      const hasUsers = users.some(u => u.clientId === clientId && u.active);
      if (hasUsers) { sendError(res, '该客户下有关联用户，不能删除。请先禁用或转移用户。', 400); return; }

      clients.splice(idx, 1);
      jsonStore.set('clients.json', clients);

      // 同时删除关联的授权
      const access = jsonStore.get('access.json') || [];
      const filtered = access.filter(a => a.clientId !== clientId);
      jsonStore.set('access.json', filtered);

      sendJson(res, { message: '客户已删除' });
      return;
    }

    // ========================
    // 项目授权管理
    // ========================
    if (pathname === '/api/admin/access' && method === 'GET') {
      const access = jsonStore.get('access.json') || [];
      sendJson(res, access);
      return;
    }

    if (pathname === '/api/admin/access' && method === 'POST') {
      const body = await parseBody(req);
      const { clientId, projectId, projectName } = body;

      if (!clientId || !projectId || !projectName) {
        sendError(res, '缺少必填字段：clientId, projectId, projectName', 400);
        return;
      }

      // 查找客户名
      const clients = jsonStore.get('clients.json') || [];
      const client = clients.find(c => c.id === clientId);
      const clientName = client ? client.shortName : 'Unknown';

      const access = jsonStore.get('access.json') || [];
      // 检查重复
      if (access.find(a => a.clientId === clientId && a.projectId === projectId)) {
        sendError(res, '该客户已拥有此项目授权', 409);
        return;
      }

      const newAccess = {
        id: Math.max(0, ...access.map(a => a.id)) + 1,
        clientId,
        clientName,
        projectId,
        projectName,
        grantedBy: adminUser.username,
        grantedAt: new Date().toISOString().split('T')[0],
        active: true
      };
      access.push(newAccess);
      jsonStore.set('access.json', access);

      sendJson(res, newAccess, 201);
      return;
    }

    // PUT /api/admin/access/:id
    if (/^\/api\/admin\/access\/\d+$/.test(pathname) && method === 'PUT') {
      const accessId = parseInt(pathname.split('/').pop());
      const body = await parseBody(req);
      const access = jsonStore.get('access.json') || [];
      const idx = access.findIndex(a => a.id === accessId);
      if (idx === -1) { sendError(res, '授权记录不存在', 404); return; }

      if (body.active !== undefined) access[idx].active = body.active;
      if (body.projectName) access[idx].projectName = body.projectName;

      jsonStore.set('access.json', access);
      sendJson(res, access[idx]);
      return;
    }

    // DELETE /api/admin/access/:id
    if (/^\/api\/admin\/access\/\d+$/.test(pathname) && method === 'DELETE') {
      const accessId = parseInt(pathname.split('/').pop());
      const access = jsonStore.get('access.json') || [];
      const idx = access.findIndex(a => a.id === accessId);
      if (idx === -1) { sendError(res, '授权记录不存在', 404); return; }

      access.splice(idx, 1);
      jsonStore.set('access.json', access);
      sendJson(res, { message: '授权已删除' });
      return;
    }

    // ========================
    // 信用评分管理
    // ========================
    if (pathname === '/api/admin/credit-scores' && method === 'GET') {
      const creditScores = jsonStore.get('credit-scores.json') || [];
      sendJson(res, creditScores);
      return;
    }

    if (/^\/api\/admin\/credit-scores\/\d+$/.test(pathname) && method === 'GET') {
      const clientId = parseInt(pathname.split('/').pop());
      const creditScores = jsonStore.get('credit-scores.json') || [];
      const score = creditScores.find(c => c.clientId === clientId);
      if (!score) { sendError(res, '信用评分记录不存在', 404); return; }
      sendJson(res, score);
      return;
    }

    if (pathname === '/api/admin/credit-scores/deduct' && method === 'POST') {
      const body = await parseBody(req);
      const { clientId, scoreChange, reason, remark } = body;

      if (!clientId || !scoreChange || !reason) {
        sendError(res, '缺少必填字段：clientId, scoreChange, reason', 400);
        return;
      }

      if (scoreChange >= 0) {
        sendError(res, '扣分分值必须为负数', 400);
        return;
      }

      const clients = jsonStore.get('clients.json') || [];
      const client = clients.find(c => c.id === clientId);
      if (!client) { sendError(res, '客户不存在', 404); return; }

      const creditScores = jsonStore.get('credit-scores.json') || [];
      let scoreRecord = creditScores.find(c => c.clientId === clientId);

      if (!scoreRecord) {
        scoreRecord = {
          clientId,
          clientName: client.shortName,
          currentScore: 10,
          maxScore: 10,
          status: 'good',
          lastUpdated: new Date().toISOString(),
          updatedBy: adminUser.username,
          updatedReason: '初始评分'
        };
        creditScores.push(scoreRecord);
      }

      const oldScore = scoreRecord.currentScore;
      const newScore = Math.max(0, oldScore + scoreChange);

      scoreRecord.currentScore = newScore;
      scoreRecord.lastUpdated = new Date().toISOString();
      scoreRecord.updatedBy = adminUser.username;
      scoreRecord.updatedReason = reason;
      scoreRecord.status = newScore >= 8 ? 'good' : (newScore >= 5 ? 'warning' : 'danger');

      await jsonStore.set('credit-scores.json', creditScores);

      // 记录日志
      const creditLogs = jsonStore.get('credit-logs.json') || [];
      const newLog = {
        id: creditLogs.length > 0 ? Math.max(...creditLogs.map(l => l.id)) + 1 : 1,
        clientId,
        clientName: client.shortName,
        type: 'deduct',
        scoreChange,
        scoreBefore: oldScore,
        scoreAfter: newScore,
        reason,
        remark: remark || '',
        operator: adminUser.username,
        timestamp: new Date().toISOString()
      };
      creditLogs.push(newLog);
      await jsonStore.set('credit-logs.json', creditLogs);

      sendJson(res, { success: true, message: '扣分成功', score: scoreRecord, log: newLog });
      return;
    }

    if (pathname === '/api/admin/credit-scores/reset' && method === 'POST') {
      const body = await parseBody(req);
      const { clientId, targetScore, reason, remark } = body;

      if (!clientId || targetScore === undefined || !reason) {
        sendError(res, '缺少必填字段：clientId, targetScore, reason', 400);
        return;
      }

      if (targetScore < 0 || targetScore > 10) {
        sendError(res, '目标分数必须在 0-10 之间', 400);
        return;
      }

      const clients = jsonStore.get('clients.json') || [];
      const client = clients.find(c => c.id === clientId);
      if (!client) { sendError(res, '客户不存在', 404); return; }

      const creditScores = jsonStore.get('credit-scores.json') || [];
      let scoreRecord = creditScores.find(c => c.clientId === clientId);

      if (!scoreRecord) {
        scoreRecord = {
          clientId,
          clientName: client.shortName,
          currentScore: 10,
          maxScore: 10,
          status: 'good',
          lastUpdated: new Date().toISOString(),
          updatedBy: adminUser.username,
          updatedReason: '初始评分'
        };
        creditScores.push(scoreRecord);
      }

      const oldScore = scoreRecord.currentScore;
      const scoreChange = targetScore - oldScore;

      scoreRecord.currentScore = targetScore;
      scoreRecord.lastUpdated = new Date().toISOString();
      scoreRecord.updatedBy = adminUser.username;
      scoreRecord.updatedReason = reason;
      scoreRecord.status = targetScore >= 8 ? 'good' : (targetScore >= 5 ? 'warning' : 'danger');

      await jsonStore.set('credit-scores.json', creditScores);

      // 记录日志
      const creditLogs = jsonStore.get('credit-logs.json') || [];
      const newLog = {
        id: creditLogs.length > 0 ? Math.max(...creditLogs.map(l => l.id)) + 1 : 1,
        clientId,
        clientName: client.shortName,
        type: 'reset',
        scoreChange,
        scoreBefore: oldScore,
        scoreAfter: targetScore,
        reason,
        remark: remark || '',
        operator: adminUser.username,
        timestamp: new Date().toISOString()
      };
      creditLogs.push(newLog);
      await jsonStore.set('credit-logs.json', creditLogs);

      sendJson(res, { success: true, message: '分数重置成功', score: scoreRecord, log: newLog });
      return;
    }

    if (pathname === '/api/admin/credit-logs' && method === 'GET') {
      const creditLogs = jsonStore.get('credit-logs.json') || [];
      sendJson(res, creditLogs);
      return;
    }

    if (/^\/api\/admin\/credit-logs\/\d+$/.test(pathname) && method === 'GET') {
      const clientId = parseInt(pathname.split('/').pop());
      const creditLogs = jsonStore.get('credit-logs.json') || [];
      const filteredLogs = creditLogs.filter(l => l.clientId === clientId);
      sendJson(res, filteredLogs);
      return;
    }

    // 未匹配路由
    sendError(res, 'Admin API route not found: ' + method + ' ' + pathname, 404);

  } catch (err) {
    console.error('Admin API error:', err);
    sendError(res, '服务器内部错误: ' + err.message, 500);
  }
}

async function handleGenerateRoute(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  // 兼容旧路由
  const isDaily = pathname === '/api/generate/daily' || pathname === '/api/generate/pmes-daily';

  if (isDaily && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const dateArg = body.date || new Date().toISOString().split('T')[0];
      const project = body.project || 'PMES POC';

      // 验证日期格式
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
        sendError(res, '日期格式错误，请使用 YYYY-MM-DD', 400);
        return;
      }

      // 项目名 → 脚本映射
      const PROJECT_SCRIPTS = {
        'PMES POC':    { script: 'generate_pmes_daily.py', filePrefix: 'PMESPOC' },
        'Para Detran': { script: 'extract_daily_report.py', filePrefix: 'ParaDetran' },
        'PMBV':        { script: 'extract_daily_report.py', filePrefix: 'PMBV' },
        'Para Segup':  { script: 'extract_daily_report.py', filePrefix: 'Para_Segup' },
        'SEAP':        { script: 'extract_daily_report.py', filePrefix: 'SEAP' },
        'SESP':        { script: 'extract_daily_report.py', filePrefix: 'SESP' },
      };

      const projConfig = PROJECT_SCRIPTS[project];
      if (!projConfig) {
        sendError(res, `不支持的项目: ${project}，可选项目: ${Object.keys(PROJECT_SCRIPTS).join(', ')}`, 400);
        return;
      }

      const scriptPath = path.join(WORKSPACE_ROOT, 'scripts', projConfig.script);
      if (!fs.existsSync(scriptPath)) {
        sendError(res, '生成脚本不存在: ' + scriptPath, 404);
        return;
      }

      // 构建命令参数
      let cmd;
      if (projConfig.script === 'generate_pmes_daily.py') {
        cmd = `"${PYTHON_EXE}" "${scriptPath}" --date ${dateArg}`;
      } else {
        // extract_daily_report.py: 将项目名映射为 config 中的 key
        const PROJECT_KEY_MAP = {
          'Para Detran': 'Para_Detran',
          'PMBV': 'PMBV',
          'Para Segup': 'Para_Segup',
          'SEAP': 'SEAP',
          'SESP': 'SESP',
        };
        const projectKey = PROJECT_KEY_MAP[project] || project.replace(/\s/g, '_');
        cmd = `"${PYTHON_EXE}" "${scriptPath}" --project ${projectKey} --date ${dateArg}`;
      }

      console.log(`[Generate] ${project} daily report for ${dateArg} ...`);
      console.log(`[Generate] CMD: ${cmd}`);

      const result = execSync(cmd, {
        cwd: WORKSPACE_ROOT,
        encoding: 'utf-8',
        timeout: 60000,  // 60秒超时
        windowsHide: true,
      });

      console.log(`[Generate] Success:\n${result}`);

      // 扫描 daily-reports 目录确认文件存在
      const reportDir = path.join(ROOT_DIR, 'modules', 'daily-reports');
      const files = fs.readdirSync(reportDir).filter(f => f.endsWith('.html') && f !== 'view.html' && f !== 'view-grouped.html' && f !== 'editable.html').sort().reverse();

      // 自动同步更新 reports/reports.json
      try {
        // 尝试从输出中提取文件名
        const htmlMatch = result.match(/(HTML|html) saved:\s*\S*?(\w+_\d{8}\.html)/);
        const htmlFilename = htmlMatch ? htmlMatch[2] : `${projConfig.filePrefix}_${dateArg.replace(/-/g, '')}.html`;
        syncReportsIndex(dateArg, htmlFilename, project);
      } catch(e) {
        console.warn('[Generate] syncReportsIndex failed:', e.message);
      }

      sendJson(res, {
        success: true,
        message: `${project} 日报生成成功`,
        date: dateArg,
        project: project,
        htmlFile: files[0] || '',
        viewUrl: `/modules/daily-reports/${files[0] || ''}`,
        allReports: files,
      });
    } catch (err) {
      console.error(`[Generate] Error:`, err.message);
      const stderr = err.stderr || err.message;
      sendError(res, '生成失败: ' + (stderr || '').substring(0, 500), 500);
    }
  } else if (isDaily && req.method === 'GET') {
    // GET: 返回日报列表（扫描 daily-reports 目录）
    try {
      const reportDir = path.join(ROOT_DIR, 'modules', 'daily-reports');
      const files = fs.readdirSync(reportDir)
        .filter(f => f.endsWith('.html') && f !== 'view.html' && f !== 'view-grouped.html' && f !== 'editable.html')
        .sort()
        .reverse();
      sendJson(res, { files: files });
    } catch (err) {
      sendError(res, err.message, 500);
    }
  } else {
    sendError(res, '不支持的生成请求: ' + pathname, 404);
  }
}

// ========== 主请求处理器 ==========
function requestHandler(req, res) {
  const url = req.url;
  const urlObj = new URL(url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  
  // 停止接口（未来用于远程停止服务器）
  if (pathname === '/stop') {
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify({message: 'Server stopping...'}));
    console.log('\n🛑 收到停止请求');
    try { fs.unlinkSync(path.join(ROOT_DIR, 'server.pid')); } catch(e) {}
    server.close();
    process.exit(0);
    return;
  }
  
  // 心跳探针 — 无认证，供 APP 检测服务器连通性（绕过 WebView CORS）
  if (pathname === '/ping') {
    const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': PIXEL.length,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(PIXEL);
    return;
  }

  // 认证 API 路由
  if (pathname.startsWith('/api/auth/')) {
    handleAuthRoute(req, res);
    return;
  }
  
  // 工单 API 路由
  if (pathname.startsWith('/api/issues')) {
    handleIssuesRoute(req, res);
    return;
  }

  // 合同 API 路由
  if (pathname === '/api/contracts' && req.method === 'GET') {
    const user = requireAuth(req, res);
    if (!user) return;

    try {
      const clients = jsonStore.get('clients.json') || [];
      const users = jsonStore.get('users.json') || [];
      const currentUser = users.find(u => u.id === user.id);
      const accessList = (jsonStore.get('access.json') || []).filter(
        a => a.clientId === user.clientId && a.active
      );
      const allowedProjects = accessList.map(a => a.projectId);
      const allowedContracts = (currentUser && currentUser.allowedContracts) || [];

      let result = [];

      if (user.role === 'admin') {
        // Admin: 返回所有客户的合同
        clients.forEach(client => {
          if (client.contracts && Array.isArray(client.contracts)) {
            client.contracts.forEach(contract => {
              result.push({
                clientId: client.id,
                clientName: client.shortName,
                ...contract
              });
            });
          }
        });
      } else {
        // 非 admin: 只返回自己客户的合同（按项目权限过滤）
        if (user.clientId) {
          const client = clients.find(c => c.id === user.clientId);
          if (client && client.contracts && Array.isArray(client.contracts)) {
            client.contracts.forEach(contract => {
              // 过滤：项目在 allowedProjects 中，或合同在 allowedContracts 中
              if (allowedProjects.includes(contract.projectId) || allowedContracts.includes(contract.contractNo)) {
                result.push({
                  clientId: client.id,
                  clientName: client.shortName,
                  ...contract
                });
              }
            });
          }
        }
      }

      sendJson(res, result);
    } catch (err) {
      sendError(res, '获取合同列表失败: ' + err.message, 500);
    }
    return;
  }

  // 统一数据层 API（保留原有功能）
  if (pathname.startsWith('/api/data/')) {
    handleApiRoute(req, res);
    return;
  }

  // 日报生成 API
  if (pathname.startsWith('/api/generate/')) {
    handleGenerateRoute(req, res);
    return;
  }

  // Admin 管理 API（仅 admin 角色）
  if (pathname.startsWith('/api/admin/')) {
    handleAdminRoute(req, res);
    return;
  }

  // 静态文件服务
  const filePath = getFilePath(url);
  if (!filePath) {
    res.writeHead(403, {'Content-Type': 'text/plain; charset=utf-8'});
    res.end('403 Forbidden');
    return;
  }
  
  // 如果路径是目录，尝试 index.html
  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isDirectory()) {
      const indexFile = path.join(filePath, 'index.html');
      sendFile(res, indexFile);
    } else {
      sendFile(res, filePath);
    }
  });
}

// ========== 启动服务器 ==========
function startServer(port) {
  const server = http.createServer(requestHandler);
  
  server.listen(port, '0.0.0.0', () => {
    console.log(`✅ 交维大师服务器已启动`);
    console.log(`📁 服务目录: ${ROOT_DIR}`);
    console.log(`🌐 访问地址: http://localhost:${port}/index.html`);
    console.log(`⏹️  停止服务: Ctrl+C`);
    console.log(`──────────────────────────────────────────`);
  });
  
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ 端口 ${port} 已被占用`);
      process.exit(1);
    } else {
      console.error(`❌ 服务器错误:`, err);
      process.exit(1);
    }
  });
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 服务器已停止');
    server.close();
    process.exit(0);
  });
  
  return server;
}

// ========== 端口检测（自动切换）==========
function findAvailablePort(defaultPort, maxRetry) {
  return new Promise((resolve, reject) => {
    let port = defaultPort;
    let tries = 0;
    
    function tryPort() {
      const server = http.createServer();
      server.listen(port, '0.0.0.0', () => {
        server.close();
        resolve(port);
      });
      
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && tries < maxRetry) {
          tries++;
          port++;
          tryPort();
        } else {
          reject(new Error(`无法找到可用端口（尝试 ${defaultPort}-${port}）`));
        }
      });
    }
    
    tryPort();
  });
}

// ========== 主程序 ==========
(async function main() {
  try {
    // 初始化 JSON 内存缓存
    jsonStore.init();

    const port = await findAvailablePort(DEFAULT_PORT, MAX_PORT_RETRY);
    if (port !== DEFAULT_PORT) {
      console.log(`⚠️  默认端口 ${DEFAULT_PORT} 被占用，自动切换到 ${port}`);
    }
    startServer(port);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
})();

// 未捕获异常处理（防止进程静默退出）
process.on('uncaughtException', (err) => {
  console.error('❌ 未捕获异常:', err);
  try { fs.unlinkSync(path.join(ROOT_DIR, 'server.pid')); } catch(e) {}
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ 未处理的 Promise 拒绝:', err);
});
