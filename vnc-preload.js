const { contextBridge, ipcRenderer } = require('electron')

// ★ 主控VNC窗口的preload：捕获canvas上的鼠标/键盘事件，通过IPC转发
contextBridge.exposeInMainWorld('vncCapture', {
  sendEvent: (data) => ipcRenderer.send('vnc-event', data)
})

// 注入事件捕获脚本
window.addEventListener('DOMContentLoaded', () => {
  console.log('[VNC-CAPTURE] DOM loaded, waiting for noVNC canvas...')

  let captureActive = false
  let mouseDownPos = null
  let mouseDownTime = 0
  let isDragging = false
  const DRAG_THRESHOLD = 10  // 移动超过10px判定为拖动
  const DRAG_TIME_THRESHOLD = 200  // 按住超过200ms也判定为拖动

  function findCanvas () {
    // noVNC的标准结构：#screen canvas
    const screenEl = document.getElementById('screen')
    if (screenEl) {
      const canvas = screenEl.querySelector('canvas')
      if (canvas) return canvas
    }
    // 备用：查找所有canvas
    const canvases = document.querySelectorAll('canvas')
    for (const c of canvases) {
      if (c.width > 100 && c.height > 100) return c
    }
    return null
  }

  function getCanvasCoords (e) {
    const canvas = findCanvas()
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    return {
      canvasX: Math.round((e.clientX - rect.left) * scaleX),
      canvasY: Math.round((e.clientY - rect.top) * scaleY),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height
    }
  }

  function setupCapture () {
    if (captureActive) return
    const canvas = findCanvas()
    if (!canvas) {
      console.log('[VNC-CAPTURE] canvas not found yet, retrying...')
      setTimeout(setupCapture, 1000)
      return
    }
    captureActive = true
    console.log(`[VNC-CAPTURE] canvas found: ${canvas.width}x${canvas.height}, capture active`)

    // ★ 鼠标按下（不阻止传播，让noVNC也能收到事件操作主控VNC）
    canvas.addEventListener('mousedown', (e) => {
      const coords = getCanvasCoords(e)
      if (!coords) return
      mouseDownPos = { x: coords.canvasX, y: coords.canvasY }
      mouseDownTime = Date.now()
      isDragging = false

      // 先发mousedown给被控端（用于拖动开始）
      if (e.button === 0) {  // 左键
        window.vncCapture.sendEvent({
          action: 'mousedown',
          ...coords,
          button: 'left'
        })
      }
    }, true)

    // ★ 鼠标移动
    canvas.addEventListener('mousemove', (e) => {
      if (!mouseDownPos) return
      const coords = getCanvasCoords(e)
      if (!coords) return

      const dx = coords.canvasX - mouseDownPos.x
      const dy = coords.canvasY - mouseDownPos.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const elapsed = Date.now() - mouseDownTime

      // 判定为拖动
      if (dist > DRAG_THRESHOLD || elapsed > DRAG_TIME_THRESHOLD) {
        isDragging = true
      }
    }, true)

    // ★ 鼠标抬起
    canvas.addEventListener('mouseup', (e) => {
      const coords = getCanvasCoords(e)
      if (!coords) return

      if (mouseDownPos && isDragging) {
        // 拖动结束
        window.vncCapture.sendEvent({
          action: 'drag',
          fromCanvasX: mouseDownPos.x,
          fromCanvasY: mouseDownPos.y,
          toCanvasX: coords.canvasX,
          toCanvasY: coords.canvasY,
          canvasWidth: coords.canvasWidth,
          canvasHeight: coords.canvasHeight,
          duration: Date.now() - mouseDownTime,
          mode: 'ease'
        })
      } else if (mouseDownPos) {
        // 普通点击
        const clickAction = e.button === 2 ? 'rightclick' : 'click'
        window.vncCapture.sendEvent({
          action: clickAction,
          ...coords
        })
      }

      // 发mouseup给被控端
      if (e.button === 0) {
        window.vncCapture.sendEvent({
          action: 'mouseup',
          ...coords,
          button: 'left'
        })
      }

      mouseDownPos = null
      isDragging = false
    }, true)

    // ★ 右键菜单拦截
    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), true)

    // ★ 滚轮（不阻止传播，让noVNC也处理）
    canvas.addEventListener('wheel', (e) => {
      const coords = getCanvasCoords(e)
      if (!coords) return
      window.vncCapture.sendEvent({
        action: 'scroll',
        ...coords,
        deltaX: Math.round(e.deltaX / 50),
        deltaY: Math.round(e.deltaY / 50)
      })
    }, true)
  }

  // ★ 键盘事件（在document上监听）
  // 注意：不阻止事件传播，让主控VNC也能接收到键盘输入
  document.addEventListener('keydown', (e) => {
    window.vncCapture.sendEvent({
      action: 'keypress',
      keyCode: e.code,
      down: true,
      canvasWidth: 0,
      canvasHeight: 0
    })
  }, true)

  document.addEventListener('keyup', (e) => {
    window.vncCapture.sendEvent({
      action: 'keypress',
      keyCode: e.code,
      down: false,
      canvasWidth: 0,
      canvasHeight: 0
    })
  }, true)

  // 等canvas出现
  setTimeout(setupCapture, 2000)
})
