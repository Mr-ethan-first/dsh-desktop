'use strict';
/**
 * Electron preload：仅暴露必要的原生能力到渲染进程。
 * 保持最小权限原则，不暴露 fs / shell / nodeIntegration。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * 把 API Key 交给主进程，供 /zhipu 代理注入。
   * 这样代理模式下无需手动放置 .env，Key 也不会随前端请求暴露在浏览器网络面板。
   */
  setApiKey: (key) => ipcRenderer.invoke('set-api-key', key),
  /** 主进程是否已持有运行时 Key（返回 'set' 或未设置返回空串）。 */
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  /**
   * 渲染进程写日志：经 IPC 交给主进程追加到 userData/logs/agent-<date>.log。
   * 入参为单行 JSON 字符串（LogEntry 序列化），便于事后排查而无需复现。
   */
  appendLog: (line) => ipcRenderer.invoke('append-log', line),
  /** 设置/取消开机自启动（写入系统登录项）。 */
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  /** 查询当前开机自启动是否生效。 */
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),

  // ========== 插件市场 API ==========
  /** 列出已发现插件（仓库内 extensions 下的 craft / modlens / node-flow / market 等）。 */
  pluginList: () => ipcRenderer.invoke('plugin:list'),
  /** 启用/禁用指定插件（持久化到 userData/plugin-state.json）。 */
  pluginSetEnabled: (name, value) => ipcRenderer.invoke('plugin:set-enabled', name, value),
  /** 激活指定插件，复用 dsh-app-boot 的 boot() 真正挂载 Cordis bundle；返回激活记录。 */
  pluginActivate: (name) => ipcRenderer.invoke('plugin:activate', name),
  /** 读取官方 dsh-market 离线策展注册表目录（社区插件展示）。 */
  pluginCatalog: () => ipcRenderer.invoke('plugin:catalog'),
  /** 用系统浏览器打开外部链接（社区市场「查看 / 安装」）。 */
  pluginOpenExternal: (url) => ipcRenderer.invoke('plugin:open-external', url),
  /** 打开插件工作台窗口（内嵌官方 DSH web 前端，社区插件在此真正挂载运行）。 */
  openWorkbench: () => ipcRenderer.invoke('workbench:open'),
  /** 查询插件工作台就绪状态（web 前端是否已构建、静态服务端口）。 */
  getWorkbenchStatus: () => ipcRenderer.invoke('workbench:status'),
  /** 扫描本地 vendored 插件目录（packages/extensions），返回插件清单（选项一：自己接管扫描）。 */
  workbenchScanExtensions: () => ipcRenderer.invoke('workbench:scan-extensions'),
  /** 打开目录选择对话框（Electron 原生），返回用户选择的目录路径或 undefined。 */
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  /**
   * 打开 Windows 11/10 原生文件夹选择器（WinRT FolderPicker，PowerShell 承载），
   * 呈现与系统文件资源管理器同源的新版界面。非 Windows 或失败会自动回退到 Electron 对话框。
   * 返回用户选择的目录绝对路径或 undefined。
   */
  selectDirectoryWin: () => ipcRenderer.invoke('select-directory-win'),
  /**
   * 读取指定目录下的文件树（递归）。
   * @param {string} dirPath
   * @returns {Promise<Array<{id:string,name:string,type:'file'|'dir',path:string,content?:string,children?:any[]}>>}
   */
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  /**
   * 工作目录文件操作（写/读/删/列）。主进程内做路径穿越校验，操作仅限 workDir 内。
   * @param {'write'|'read'|'delete'|'list'} kind
   */
  fsOp: (kind, workDir, relPath, content) => ipcRenderer.invoke('fs-op', kind, workDir, relPath, content),
  /**
   * 注册系统电源事件回调（休眠/恢复）。返回取消监听函数。
   * @param {(type: 'suspend'|'resume') => void} callback
   * @returns {() => void} unsubscribe
   */
  onPowerEvent: (callback) => {
    const suspendHandler = () => callback('suspend');
    const resumeHandler = () => callback('resume');
    ipcRenderer.on('power-suspend', suspendHandler);
    ipcRenderer.on('power-resume', resumeHandler);
    return () => {
      ipcRenderer.removeListener('power-suspend', suspendHandler);
      ipcRenderer.removeListener('power-resume', resumeHandler);
    };
  },

  // ========== Harness API ==========
  /** 创建新的 harness 会话 */
  createHarnessSession: (opts) => ipcRenderer.invoke('harness:session-create', opts),
  /** 列出所有 harness 会话 */
  listHarnessSessions: () => ipcRenderer.invoke('harness:session-list'),
  /** 获取会话详情 */
  getHarnessSession: (sessionId) => ipcRenderer.invoke('harness:session-get', sessionId),
  /** 发送消息到会话 */
  sendHarnessMessage: (sessionId, content) => ipcRenderer.invoke('harness:session-send', sessionId, content),
  /** 取消会话的当前任务 */
  cancelHarnessSession: (sessionId) => ipcRenderer.invoke('harness:session-cancel', sessionId),
  /** 重命名 harness 会话（更新 server 侧 session.header.title）。 */
  renameHarnessSession: (sessionId, title) => ipcRenderer.invoke('harness:session-rename', sessionId, title),
  /** 删除 harness 会话（注销 agent，下次启动后该 ID 不再可见）。 */
  deleteHarnessSession: (sessionId) => ipcRenderer.invoke('harness:session-delete', sessionId),
  /** 用系统资源管理器（Windows 资源管理器/macOS Finder）打开目录或文件。 */
  openFolder: (dirPath) => ipcRenderer.invoke('harness:open-folder', dirPath),
  /**
   * 设置 harness 工作区（工作目录 + 权限等级），运行时生效。
   * @param {{workDir?: string, permission?: 'read'|'write'|'execute'}} ws
   * @returns {Promise<{ok: boolean, workspace: {workDir: string, permission: string}}>}
   */
  setHarnessWorkspace: (ws) => ipcRenderer.invoke('harness:set-workspace', ws),
  /** 读取当前 harness 工作区（工作目录 + 权限等级）。 */
  getHarnessWorkspace: () => ipcRenderer.invoke('harness:get-workspace'),
  /** 读取工作空间历史目录（来自 SQLite <userData>/workspaces.db）。 */
  getWorkspaceHistory: () => ipcRenderer.invoke('harness:workspace-history-get'),
  /** 新增/提升到顶部一个工作目录，返回最新历史列表。 */
  addWorkspaceHistory: (dir) => ipcRenderer.invoke('harness:workspace-history-add', dir),
  /** 删除一个工作目录，返回最新历史列表。 */
  removeWorkspaceHistory: (dir) => ipcRenderer.invoke('harness:workspace-history-remove', dir),
  /**
   * 监听 harness 会话事件。返回取消监听函数。
   * @param {(payload: any) => void} callback
   * @returns {() => void} unsubscribe
   */
  onHarnessEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('harness:session-event', handler);
    return () => {
      ipcRenderer.removeListener('harness:session-event', handler);
    };
  },

  /**
   * 监听 Cordis 插件（DSH 社区插件）经 ctx.toast 发出的通知，推到渲染进程的 ToastCenter。
   * 返回取消监听函数。
   * @param {(payload:{kind?:string,message:string,detail?:string}) => void} callback
   * @returns {() => void} unsubscribe
   */
  onToast: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('harness:toast', handler);
    return () => {
      ipcRenderer.removeListener('harness:toast', handler);
    };
  },

  // ========== MCP API ==========
  /** 列出 MCP 服务器 */
  mcpListServers: () => ipcRenderer.invoke('harness:mcp-list-servers'),
  /** 添加 MCP 服务器 */
  mcpAddServer: (config) => ipcRenderer.invoke('harness:mcp-add-server', config),
  /** 移除 MCP 服务器 */
  mcpRemoveServer: (id) => ipcRenderer.invoke('harness:mcp-remove-server', id),
  /** 更新 MCP 服务器 */
  mcpUpdateServer: (id, updates) => ipcRenderer.invoke('harness:mcp-update-server', id, updates),
  /** 刷新所有 MCP 工具 */
  mcpRefreshTools: () => ipcRenderer.invoke('harness:mcp-refresh-tools'),
  /** 列出所有 MCP 工具 */
  mcpListTools: () => ipcRenderer.invoke('harness:mcp-list-tools'),
  /** 测试 MCP 连接 */
  mcpTestConnection: (serverId) => ipcRenderer.invoke('harness:mcp-test-connection', serverId),
  /** 获取 MCP 连接状态 */
  mcpGetStatus: (serverId) => ipcRenderer.invoke('harness:mcp-get-status', serverId),
  /**
   * 监听 MCP 事件。返回取消监听函数。
   * @param {(payload: any) => void} callback
   * @returns {() => void} unsubscribe
   */
  onMcpEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('harness:mcp-event', handler);
    return () => {
      ipcRenderer.removeListener('harness:mcp-event', handler);
    };
  },

  // ========== Skill API ==========
  /** 列出所有技能 */
  skillList: () => ipcRenderer.invoke('harness:skill-list'),
  /** 获取指定技能 */
  skillGet: (id) => ipcRenderer.invoke('harness:skill-get', id),
  /** 添加技能 */
  skillAdd: (skill) => ipcRenderer.invoke('harness:skill-add', skill),
  /** 移除技能 */
  skillRemove: (id) => ipcRenderer.invoke('harness:skill-remove', id),
  /** 更新技能 */
  skillUpdate: (id, updates) => ipcRenderer.invoke('harness:skill-update', id, updates),
  /** 启用技能 */
  skillEnable: (id) => ipcRenderer.invoke('harness:skill-enable', id),
  /** 禁用技能 */
  skillDisable: (id) => ipcRenderer.invoke('harness:skill-disable', id),
  /** 切换技能启用状态 */
  skillToggle: (id) => ipcRenderer.invoke('harness:skill-toggle', id),
  /** 获取技能提示 */
  skillGetPrompt: () => ipcRenderer.invoke('harness:skill-get-prompt'),
  /** 获取技能统计 */
  skillGetStats: () => ipcRenderer.invoke('harness:skill-get-stats'),
  /** 按分类列出技能 */
  skillListByCategory: () => ipcRenderer.invoke('harness:skill-list-by-category'),
  /**
   * 监听 Skill 事件。返回取消监听函数。
   * @param {(payload: any) => void} callback
   * @returns {() => void} unsubscribe
   */
  onSkillEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('harness:skill-event', handler);
    return () => {
      ipcRenderer.removeListener('harness:skill-event', handler);
    };
  },
});
