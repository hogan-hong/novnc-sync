const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')

// ========== 坐标常量（与novnc-cef-client一致）==========
const CLIENT_WIDTH = 856
const CLIENT_HEIGHT = 480
const PHONE_WIDTH = 1334
const PHONE_HEIGHT = 750

// ========== 全局状态 ==========
let controlWindow = null    // 控制面板窗口
let masterVNCWindow = null  // 主控VNC窗口
let syncActive = false      // 同步是否激活
let masterIP = ''           // 主控IP
let controlledIPs = []      // 被控IP列表
let clientWindows = {}      // IP → { clientUrl, windowIndex, title } 映射

// ========== 读取配置文件 ==========
function readConfig () {
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
      path.join(__dirname, '配置文件.json')
    ]
    configPath = candidates.find(p => fs.existsSync(p)) || candidates[0]
  }
  console.log(`使用配置文件: ${configPath}`)
  if (!fs.existsSync(configPath)) {
    return { error: `配置文件不存在: ${configPath}`, clients: [] }
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const clients = JSON.parse(raw)
    if (!Array.isArray(clients)) return { error: '配置文件格式错误：需要JSON数组', clients: [] }
    return { clients }
  } catch (e) {
    return { error: `读取配置文件失败: ${e.message}`, clients: [] }
  }
}

// ========== HTTP请求工具 ==========
function httpGet (url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error(`JSON解析失败: ${e.message}`)) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
  })
}

function httpPost (url, body, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const postData = JSON.stringify(body)
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout
    }
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { resolve({ success: false }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
    req.write(postData)
    req.end()
  })
}

// ========== 扫描所有群控客户端 ==========
async function scanClients (clients) {
  const results = []
  for (const client of clients) {
    try {
      const data = await httpGet(`${client.apiUrl}/windows`)
      if (data.success) {
        results.push({
          name: client.name,
          apiUrl: client.apiUrl,
          groupIndex: data.groupIndex,
          groupName: data.groupName,
          windowCount: data.windowCount,
          windows: data.windows
        })
      } else {
        results.push({ name: client.name, apiUrl: client.apiUrl, error: 'API返回失败', windows: [] })
      }
    } catch (e) {
      results.push({ name: client.name, apiUrl: client.apiUrl, error: e.message, windows: [] })
    }
  }
  return results
}

// ========== 构建IP→客户端映射 ==========
function buildIPMapping (scanResults) {
  const mapping = {}
  for (const client of scanResults) {
    if (client.error || !client.windows) continue
    for (let i = 0; i < client.windows.length; i++) {
      const win = client.windows[i]
      if (win.controlIP) {
        mapping[win.controlIP] = {
          clientUrl: client.apiUrl,
          windowIndex: i + 1,  // 1-based，与novnc-cef-client API一致
          title: win.title,
          alive: win.alive
        }
      }
    }
  }
  return mapping
}

// ========== 转发事件到被控客户端 ==========
async function forwardEvent (action, eventData) {
  const promises = controlledIPs.map(async (ip) => {
    const mapping = clientWindows[ip]
    if (!mapping) return
    const payload = {
      windowIndex: mapping.windowIndex,
      action,
      ...eventData
    }
    try {
      await httpPost(`${mapping.clientUrl}/`, payload)
    } catch (e) {
      console.error(`[SYNC] 转发到 ${ip} 失败: ${e.message}`)
    }
  })
  await Promise.allSettled(promises)
}

// ========== 创建主控VNC窗口 ==========
function createMasterVNCWindow (ip) {
  if (masterVNCWindow && !masterVNCWindow.isDestroyed()) {
    masterVNCWindow.destroy()
  }
  const vncUrl = `http://${ip}:5801/vnc_video.html?autoconnect=true&host=${ip}&port=5901&encrypt=0`

  masterVNCWindow = new BrowserWindow({
    width: 1334,
    height: 750,
    title: `主控 - ${ip}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'vnc-preload.js')
    }
  })
  masterVNCWindow.setMenu(null)
  masterVNCWindow.loadURL(vncUrl)

  masterVNCWindow.on('closed', () => {
    masterVNCWindow = null
    if (syncActive) {
      syncActive = false
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send('sync-stopped')
      }
    }
  })

  // 主控窗口获取焦点时通知控制面板
  masterVNCWindow.on('focus', () => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('master-focused')
    }
  })
}

// ========== 坐标转换：主控VNC窗口的canvas坐标 → API坐标(856x480) ==========
// 主控VNC窗口显示的是手机画面(1334x750)，canvas坐标就是手机坐标
// API坐标是856x480，所以: apiX = canvasX * 856/1334, apiY = canvasY * 480/750
function canvasToAPI (canvasX, canvasY, canvasWidth, canvasHeight) {
  // canvasWidth/canvasHeight 是VNC canvas的实际像素分辨率（=手机分辨率）
  const apiX = Math.round(canvasX * CLIENT_WIDTH / canvasWidth)
  const apiY = Math.round(canvasY * CLIENT_HEIGHT / canvasHeight)
  return { x: apiX, y: apiY }
}

// ========== 创建控制面板窗口 ==========
function createControlWindow () {
  const workArea = screen.getPrimaryDisplay().workAreaSize
  controlWindow = new BrowserWindow({
    width: 520,
    height: Math.min(720, workArea.height - 40),
    title: 'NoVNC 同步器',
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })
  controlWindow.setMenu(null)
  controlWindow.loadFile('sync.html')

  controlWindow.on('closed', () => {
    controlWindow = null
    if (masterVNCWindow && !masterVNCWindow.isDestroyed()) {
      masterVNCWindow.destroy()
    }
    syncActive = false
    app.quit()
  })
}

// ========== IPC处理 ==========
// 扫描客户端
ipcMain.handle('scan-clients', async () => {
  const config = readConfig()
  if (config.error) return { error: config.error }
  const results = await scanClients(config.clients)
  clientWindows = buildIPMapping(results)
  return results
})

// 开始同步
ipcMain.handle('start-sync', async (event, data) => {
  masterIP = data.masterIP
  controlledIPs = data.controlledIPs || []

  // 验证主控IP在映射中
  if (!clientWindows[masterIP]) {
    return { error: `主控IP ${masterIP} 不在任何群控客户端中` }
  }

  // 创建主控VNC窗口
  createMasterVNCWindow(masterIP)
  syncActive = true
  console.log(`[SYNC] 开始同步: 主控=${masterIP}, 被控=${controlledIPs.join(',')}`)
  return { success: true }
})

// 停止同步
ipcMain.handle('stop-sync', async () => {
  syncActive = false
  if (masterVNCWindow && !masterVNCWindow.isDestroyed()) {
    masterVNCWindow.destroy()
    masterVNCWindow = null
  }
  console.log('[SYNC] 同步已停止')
  return { success: true }
})

// ★ 主控VNC窗口的事件转发（由vnc-preload.js通过IPC发送）
ipcMain.on('vnc-event', async (event, data) => {
  if (!syncActive) return
  const { action, canvasX, canvasY, canvasWidth, canvasHeight, button, deltaX, deltaY, keyCode, down } = data

  if (action === 'click' || action === 'rightclick') {
    const api = canvasToAPI(canvasX, canvasY, canvasWidth, canvasHeight)
    const clickAction = action === 'rightclick' ? 'rightclick' : 'click'
    await forwardEvent(clickAction, { x: api.x, y: api.y })
  } else if (action === 'mousedown' || action === 'mouseup' || action === 'mousemove') {
    const api = canvasToAPI(canvasX, canvasY, canvasWidth, canvasHeight)
    await forwardEvent(action, { x: api.x, y: api.y, button })
  } else if (action === 'scroll') {
    const api = canvasToAPI(canvasX, canvasY, canvasWidth, canvasHeight)
    await forwardEvent('scroll', { x: api.x, y: api.y, deltaX: deltaX || 0, deltaY: deltaY || 0 })
  } else if (action === 'keypress') {
    await forwardEvent('keypress', { code: keyCode, down })
  } else if (action === 'drag') {
    // 拖动需要起点终点
    const from = canvasToAPI(data.fromCanvasX, data.fromCanvasY, canvasWidth, canvasHeight)
    const to = canvasToAPI(data.toCanvasX, data.toCanvasY, canvasWidth, canvasHeight)
    await forwardEvent('drag', {
      fromX: from.x, fromY: from.y,
      toX: to.x, toY: to.y,
      duration: data.duration || 300,
      mode: data.mode || 'ease'
    })
  }
})

// 重新读取配置
ipcMain.handle('reload-config', async () => {
  return readConfig()
})

// ========== 启动 ==========
app.whenReady().then(() => {
  createControlWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createControlWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
