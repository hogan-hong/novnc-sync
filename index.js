const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')

// ========== 全局状态 ==========
let mainWindow = null
let syncConfig = []       // 同步器配置: [{ name, apiUrl }]
let clients = []          // 已发现的客户端: [{ name, apiUrl, windows: [...] }]
let masterIP = ''         // 主控IP
let slaveIPs = []         // 被控IP列表
let isSyncing = false     // 是否正在同步
let syncInterval = null   // 同步轮询定时器

// ========== 读取配置文件 ==========
function readSyncConfig () {
  const configArg = process.argv.find(a => a.startsWith('--config='))
  let configPath
  if (configArg) {
    configPath = configArg.substring(9)
    if (!path.isAbsolute(configPath)) {
      configPath = path.resolve(path.dirname(app.getPath('exe')), configPath)
    }
  } else {
    const candidates = [
      path.join(path.dirname(app.getPath('exe')), '配置文件.json'),
      path.join(process.cwd(), '配置文件.json'),
      path.join(__dirname, '配置文件.json'),
      path.join(process.resourcesPath || '', '配置文件.json')
    ].filter(Boolean)
    configPath = candidates.find(p => fs.existsSync(p)) || candidates[0]
  }
  console.log(`同步器配置文件路径: ${configPath}`)
  if (!fs.existsSync(configPath)) {
    return null
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const config = JSON.parse(raw)
    if (!Array.isArray(config)) throw new Error('配置文件必须是数组')
    return config
  } catch (e) {
    console.error('读取同步器配置失败:', e.message)
    return null
  }
}

// ========== HTTP 请求工具 ==========
function httpGet (url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error(`解析JSON失败: ${data.substring(0, 100)}`))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
  })
}

function httpPost (url, body, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const postData = JSON.stringify(body)
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout
    }
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          resolve({ ok: false })
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
    req.write(postData)
    req.end()
  })
}

// ========== 扫描所有群控客户端 ==========
async function scanClients () {
  const results = []
  for (const cfg of syncConfig) {
    try {
      const resp = await httpGet(`${cfg.apiUrl}/windows`)
      if (resp.success) {
        results.push({
          name: cfg.name,
          apiUrl: cfg.apiUrl,
          groupIndex: resp.groupIndex,
          groupName: resp.groupName,
          port: resp.port,
          windows: resp.windows
        })
      } else {
        results.push({ name: cfg.name, apiUrl: cfg.apiUrl, error: '返回失败', windows: [] })
      }
    } catch (e) {
      results.push({ name: cfg.name, apiUrl: cfg.apiUrl, error: e.message, windows: [] })
    }
  }
  clients = results
  return results
}

// ========== 同步操作：将主控窗口的命令转发到所有被控窗口 ==========
async function syncCommand (action, data) {
  if (!masterIP || slaveIPs.length === 0) return
  // 找到主控IP所在的客户端
  const masterClient = clients.find(c => c.windows && c.windows.some(w => w.controlIP === masterIP))
  if (!masterClient) return

  // 找到每个被控IP所在的客户端，发送命令
  for (const slaveIP of slaveIPs) {
    const slaveClient = clients.find(c => c.windows && c.windows.some(w => w.controlIP === slaveIP))
    if (!slaveClient) continue
    const slaveWin = slaveClient.windows.find(w => w.controlIP === slaveIP)
    if (!slaveWin || !slaveWin.alive) continue

    // 通过群控客户端API发送控制命令
    try {
      await httpPost(`${slaveClient.apiUrl}/`, {
        action: data.action,
        windowIndex: String(slaveWin.index),
        x: data.x,
        y: data.y,
        text: data.text,
        code: data.code,
        down: data.down,
        fromX: data.fromX,
        fromY: data.fromY,
        toX: data.toX,
        toY: data.toY,
        duration: data.duration,
        deltaY: data.deltaY,
        deltaX: data.deltaX
      })
    } catch (e) {
      console.error(`同步到 ${slaveIP} 失败:`, e.message)
    }
  }
}

// ========== 创建主窗口 ==========
function createMainWindow () {
  const workArea = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    x: Math.floor((workArea.width - 900) / 2),
    y: Math.floor((workArea.height - 700) / 2),
    title: 'NoVNC 同步器',
    backgroundColor: '#101820',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })
  mainWindow.setMenu(null)
  mainWindow.loadFile('sync.html')

  mainWindow.on('closed', () => {
    mainWindow = null
    if (syncInterval) { clearInterval(syncInterval); syncInterval = null }
  })
}

// ========== IPC 通信 ==========
ipcMain.handle('scan-clients', async () => {
  return await scanClients()
})

ipcMain.handle('set-master', async (event, ip) => {
  masterIP = ip
  if (slaveIPs.includes(ip)) {
    slaveIPs = slaveIPs.filter(i => i !== ip)
  }
  return { masterIP, slaveIPs }
})

ipcMain.handle('toggle-slave', async (event, ip) => {
  if (ip === masterIP) return { masterIP, slaveIPs }
  if (slaveIPs.includes(ip)) {
    slaveIPs = slaveIPs.filter(i => i !== ip)
  } else {
    slaveIPs.push(ip)
  }
  return { masterIP, slaveIPs }
})

ipcMain.handle('set-slaves', async (event, ips) => {
  slaveIPs = ips.filter(ip => ip !== masterIP)
  return { masterIP, slaveIPs }
})

ipcMain.handle('start-sync', async (event, masterClientUrl, masterWinIndex) => {
  if (isSyncing) return { success: false, error: '已在同步中' }
  isSyncing = true
  // 同步逻辑：轮询主控窗口的操作，转发到被控窗口
  // 由于novnc-cef-client本身已有主控同步功能（controlMode + masterWindowIndex），
  // 同步器需要做的是：跨客户端同步
  // 思路：让主控IP所在的客户端启用controlMode，主控窗口设为master
  // 然后同步器监听主控窗口的操作，转发到其他客户端的被控窗口

  // 简化方案：直接让主控客户端的控制模式开启，设置master窗口
  // 被控窗口通过同步器转发命令
  return { success: true }
})

ipcMain.handle('stop-sync', async () => {
  isSyncing = false
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null }
  return { success: true }
})

ipcMain.handle('send-command', async (event, data) => {
  await syncCommand(data.action, data)
  return { success: true }
})

ipcMain.handle('refresh-window', async (event, clientUrl, windowIndex) => {
  try {
    const resp = await httpPost(`${clientUrl}/refresh`, { windowIndex })
    return resp
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('get-config', async () => {
  return { config: syncConfig, masterIP, slaveIPs, isSyncing }
})

// ========== 启动 ==========
app.whenReady().then(() => {
  const config = readSyncConfig()
  if (!config) {
    const errWin = new BrowserWindow({
      width: 600, height: 300, alwaysOnTop: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    })
    errWin.setMenu(null)
    errWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<html><head><meta charset="utf-8"><style>' +
      'body{font-family:"Microsoft YaHei",Arial,sans-serif;margin:0;padding:24px;background:#101820;color:#f4f7fb}' +
      'h1{font-size:20px;color:#ffcc66}p{line-height:1.8}' +
      '</style></head><body>' +
      '<h1>配置文件不存在</h1>' +
      '<p>请在exe同目录下创建 <b>配置文件.json</b></p>' +
      '<p>格式示例:</p>' +
      '<pre style="background:#172331;padding:12px;border-radius:6px">' +
      '[\n  { "name": "互通一区", "apiUrl": "http://192.168.1.101:38981" },\n  { "name": "互通二区", "apiUrl": "http://192.168.1.102:38982" }\n]' +
      '</pre></body></html>'
    ))
    return
  }
  syncConfig = config
  createMainWindow()
  app.on('activate', () => { if (!mainWindow) createMainWindow() })
})

app.on('window-all-closed', () => { app.quit() })
