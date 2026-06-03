# NoVNC 同步器

跨客户端同步控制工具，配合 [novnc-cef-client](https://github.com/hogan-hong/novnc-cef-client) 使用。

当多个 NoVNC 群控客户端同时运行时，同步器可以：
- 自动发现所有群控客户端及其控制的IP
- 选择一个IP作为主控，多个IP作为被控
- 主控窗口的操作会实时同步到所有被控窗口

## 配置

在exe同目录创建 `配置文件.json`：

```json
[
  { "name": "互通一区", "apiUrl": "http://192.168.1.101:38981" },
  { "name": "互通二区", "apiUrl": "http://192.168.1.102:38982" }
]
```

- `name`：客户端名称（自定义）
- `apiUrl`：群控客户端的API地址，端口 = 38980 + 组号

## 使用

1. 先启动所有 NoVNC 群控客户端
2. 启动同步器，自动扫描发现客户端
3. 选择一个IP勾选「主控」，其他IP勾选「被控」
4. 点击「开始同步」

## 构建

```bash
npm install
npm run build
```

## 依赖

- novnc-cef-client v1.3+（需 `/windows` API端点）
