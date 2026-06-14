#!/usr/bin/env node
/**
 * 交维大师 - 本地 HTTP 服务器
 * 轻量级静态文件服务，支持 fetch/JSON 动态加载
 * 预留 /api/ 路由接口（未来工单系统）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ========== 配置 ==========
const DEFAULT_PORT = 8080;
const MAX_PORT_RETRY = 3;  // 端口被占用时，最多尝试 +1, +2, +3
const ROOT_DIR = __dirname;  // server.js 所在目录
const JWT_SECRET = 'delivery-ops-master-2026';  // 简易认证密钥（生产环境需更换）
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

// ========== 统一数据层 API（Phase 1）==========
const DATA_DIR = path.join(__dirname, '_data');
/** 验证文件名是否合法（防止目录遍历，允许 _data 目录下所有 .json 文件）*/
function validateDataFile(filename) {
  // 只允许 .json 文件
  if (!filename.endsWith('.json')) {
    return null;
  }
  const filePath = path.join(DATA_DIR, filename);
  const resolved = path.resolve(filePath);
  // 确保文件在 DATA_DIR 内（防止目录遍历攻击）
  if (!resolved.startsWith(path.resolve(DATA_DIR))) {
    return null;
  }
  return resolved;
}

/** 读取 JSON 数据文件 */
function readDataFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          // 文件不存在，返回默认值
          if (filePath.endsWith('projects.json') || filePath.endsWith('reports.json')) {
            resolve({});
          } else {
            resolve([]);
          }
        } else {
          reject(err);
        }
      } else {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON in ' + path.basename(filePath)));
        }
      }
    });
  });
}

/** 写入 JSON 数据文件 */
function writeDataFile(filePath, data) {
  return new Promise((resolve, reject) => {
    const jsonStr = JSON.stringify(data, null, 2);
    fs.writeFile(filePath, jsonStr, 'utf8', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
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
    if (method === 'GET') {
      // GET /api/data/:file → 读取数据
      const data = await readDataFile(filePath);
      sendJson(res, data);
      
    } else if (method === 'POST' && pathname.endsWith('/add')) {
      // POST /api/data/:file/add → 追加一条记录
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
      // POST /api/data/:file → 覆盖写入（全量更新）
      const body = await parseBody(req);
      await writeDataFile(filePath, body);
      sendJson(res, { success: true, message: 'Data overwritten' });
      
    } else if (method === 'PATCH') {
      // PATCH /api/data/:file → 部分更新（按 body.id 匹配）
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
      // DELETE /api/data/:file/:id → 删除一条记录
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

// ========== 认证与工单 API（Phase 2）==========

// 简易认证（MVP版本，生产环境需升级）
const crypto = require('crypto');

/** 生成简单 token（base64编码用户ID+角色+过期时间）*/
function generateToken(user) {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000  // 7天过期
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/** 验证 token */
function verifyToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    if (payload.exp < Date.now()) {
      return null;  // token 过期
    }
    return payload;
  } catch (e) {
    return null;
  }
}

/** 简单密码哈希（MVP用，生产环境需用 bcrypt）*/
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/** 验证密码 */
function comparePassword(password, hash) {
  return hashPassword(password) === hash;
}

/** 从请求头提取 token */
function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
}

/** 认证中间件（可选，MVP简化为前端自行存储token）*/
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

/**
 * 认证路由处理
 * POST /api/auth/login  — 登录
 * POST /api/auth/register — 注册（仅管理员）
 * GET  /api/auth/me      — 获取当前用户信息
 */
async function handleAuthRoute(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const method = req.method;
  
  try {
    if (method === 'POST' && pathname === '/api/auth/login') {
      // 登录
      const body = await parseBody(req);
      const { username, password } = body;
      
      if (!username || !password) {
        sendError(res, '用户名和密码不能为空', 400);
        return;
      }
      
      const users = await readDataFile(path.join(DATA_DIR, 'users.json'));
      const user = users.find(u => u.username === username);
      
      if (!user || user.password !== password) {
        // MVP: 明文密码比对（生产环境需用 hash 比对）
        sendError(res, '用户名或密码错误', 401);
        return;
      }
      
      // 生成 token（MVP: 简单 base64，生产环境需用 JWT）
      const token = generateToken(user);
      
      // 返回用户信息（不含密码）
      const { password: _, ...userInfo } = user;
      sendJson(res, {
        success: true,
        token,
        user: userInfo
      });
      
    } else if (method === 'POST' && pathname === '/api/auth/register') {
      // 注册（MVP: 无权限控制，任何人可注册）
      const body = await parseBody(req);
      const { username, password, role, email } = body;
      
      if (!username || !password) {
        sendError(res, '用户名和密码不能为空', 400);
        return;
      }
      
      const users = await readDataFile(path.join(DATA_DIR, 'users.json'));
      
      // 检查用户名是否已存在
      if (users.find(u => u.username === username)) {
        sendError(res, '用户名已存在', 409);
        return;
      }
      
      // 创建新用户
      const newUser = {
        id: users.length > 0 ? Math.max(...users.map(u => u.id)) + 1 : 1,
        username,
        password,  // MVP: 明文存储（生产环境需哈希）
        role: role || 'user',
        email: email || '',
        created_at: new Date().toISOString().split('T')[0]
      };
      
      users.push(newUser);
      await writeDataFile(path.join(DATA_DIR, 'users.json'), users);
      
      // 返回用户信息（不含密码）
      const { password: _, ...userInfo } = newUser;
      sendJson(res, {
        success: true,
        message: '注册成功',
        user: userInfo
      });
      
    } else if (method === 'GET' && pathname === '/api/auth/me') {
      // 获取当前用户信息
      const token = extractToken(req);
      if (!token) {
        sendError(res, '未登录', 401);
        return;
      }
      
      const user = verifyToken(token);
      if (!user) {
        sendError(res, '认证失败', 401);
        return;
      }
      
      // 从数据库获取最新用户信息
      const users = await readDataFile(path.join(DATA_DIR, 'users.json'));
      const dbUser = users.find(u => u.id === user.id);
      
      if (!dbUser) {
        sendError(res, '用户不存在', 404);
        return;
      }
      
      const { password: _, ...userInfo } = dbUser;
      sendJson(res, userInfo);
      
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

  const project = projectName || 'PMES POC';

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
  
  server.listen(port, '127.0.0.1', () => {
    console.log(`✅ 交维大师服务器已启动`);
    console.log(`📁 服务目录: ${ROOT_DIR}`);
    console.log(`🌐 访问地址: http://localhost:${port}/index.html`);
    console.log(`⏹️  停止服务: Ctrl+C`);
    console.log(`📡 API 预留: http://localhost:${port}/api/ (未来工单系统)`);
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
      server.listen(port, '127.0.0.1', () => {
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
