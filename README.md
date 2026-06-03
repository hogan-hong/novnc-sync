# NoVNC 同步器

基于Electron的NoVNC跨客户端同步控制工具，配合 [novnc-cef-client](https://github.com/hogan-hong/novnc-cef-client) 使用。

## 功能

- 自动读取配置文件中的群控客户端API地址
- 扫描所有群控客户端，获取其控制的IP列表
- 可视化选择主控IP和被控IP
- 用主控IP打开VNC视频窗口，用户的操作自动同步转发到所有被控IP
- 支持点击、拖动、滚轮、键盘等操作同步

## 工作原理

1. 同步器读取 `配置文件.json`，获取所有群控客户端的API地址
2. 逐个访问群控客户端的 `/windows` API，获取其控制的IP列表
3. 用户在控制面板中选择一个主控IP和多个被控IP
4. 点击"开始同步"后，用主控IP构建VNC视频地址，打开主控VNC窗口
5. 用户在主控VNC窗口上的所有操作（鼠标、键盘）都会被捕获
6. 操作坐标经过转换后，通过各群控客户端的API转发给被控窗口

## 配置文件

在exe同目录下创建 `配置文件.json`，格式为JSON数组：

```json
[
  { "name": "互通一区", "apiUrl": "http://192.168.1.101:38981" },
  { "name": "互通二区", "apiUrl": "http://192.168.1.102:38982" }
]
```

- `name`: 客户端名称（用于显示）
- `apiUrl`: 群控客户端的API地址（novnc-cef-client的HTTP API端口，格式为 `http://IP:3898X`）

## 依赖

- novnc-cef-client 需要升级到支持 `/windows` API的版本

## 构建

```bash
npm install
npm run build:win
```

生成的exe在 `dist/` 目录。
