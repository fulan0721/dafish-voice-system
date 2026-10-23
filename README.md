# 大肥鱼语音系统 · Dafish Voice System

给 [qq-bridge](https://github.com/Derpyu520/qq-bridge) + [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 做的本地网页控制台：看状态、一键启停、上传音频克隆音色、合成并直接发 QQ 语音条。

> 定位：**qq-bridge 的语音扩展 + 管理面板**，不是另一个 QQ 机器人框架。机器人本体、会话、白名单仍由 qq-bridge / DSH 管。

![status](https://img.shields.io/badge/platform-Windows-0078d4) ![node](https://img.shields.io/badge/node-%3E%3D22-339933) ![license](https://img.shields.io/badge/license-MIT-green)

## 功能

- **状态看板**：DSH / SnowLuma / qq-bridge / GPT-SoVITS / GPU 实时状态
- **服务控制**：一键启动/停止 GPT-SoVITS 与 qq-bridge
- **音色克隆**：上传 mp3/wav → 自动检测人声区间（最长 9.5 秒）→ 本地 SenseVoice 识别文字（支持中/日/英/粤/韩）→ 试听 → 应用为机器人音色
- **试听发送**：输入一句话，调用 GPT-SoVITS 合成，再走 qq-bridge 的白名单发送链条发成 QQ 语音条
- **日志**：桥接 / 语音引擎 / 系统日志
- **注入式集成**：一条命令把 `qq_say_voice` 工具补进已有的 qq-bridge，不改上游仓库结构

## 架构

```
QQ ←→ SnowLuma（OneBot v11）
          ↕
      qq-bridge ── MCP ── DSH（DeepSeek Harness）
          │                  │
          │                  └── qq-chat / qq-chat-v2 preset
          │
          └── mcp__snowluma__qq_say_voice
                    │
                    ├── GPT-SoVITS api_v2（127.0.0.1:9880）
                    └── scripts/send-voice.mjs → SnowLuma → QQ 语音条

本控制台（127.0.0.1:3200）只做三件事：
  看状态 / 启停服务 / 管理音色
```

## 前置条件

| 组件 | 要求 |
|---|---|
| 系统 | Windows（服务启停、`taskkill`、`netstat` 都是 Windows 实现） |
| Node.js | ≥ 22 |
| qq-bridge | 能正常连 SnowLuma + DSH；已配置 `config.json` |
| SnowLuma | 自己安装/登录（本程序只探测，不启动） |
| GPT-SoVITS | 已部署 `api_v2.py`，模型能在 `127.0.0.1:9880` 跑起来 |
| ffmpeg | 用于截取/转码，默认 `D:\GPT-SoVITS\bin\ffmpeg.exe` |
| SenseVoice（可选） | DSH 自带的 `~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx`；没有则只能手动填参考文字 |

## 快速开始

### 1. 准备 qq-bridge 并注入语音工具

```bat
git clone https://github.com/Derpyu520/qq-bridge.git
cd qq-bridge
npm install
copy config.example.json config.json
```

把本仓库放在 qq-bridge 的**同级目录**（或稍后用 `config.json` 的 `bridgeRoot` 指过去），然后：

```bat
node integration/patch-bridge.mjs --bridge "C:\path\to\qq-bridge"
```

脚本会在 `src/mcp-snowluma-safe.js` 里注入 `qq_say_voice`（挂在 `mcp__snowluma__` 命名空间，QQ preset 原有白名单直接放行），原文件自动备份。

### 2. 配置本控制台

```bat
copy config.example.json config.json
```

编辑 `config.json`：

| 字段 | 说明 |
|---|---|
| `port` | 控制台端口，默认 `3200` |
| `bridgeRoot` | qq-bridge 目录（相对本仓库或绝对路径） |
| `ttsHome` | GPT-SoVITS 代码目录（含 `api_v2.py`、`GPT_SoVITS/`） |
| `python` | 跑 GPT-SoVITS 的 Python |
| `ffmpeg` | ffmpeg.exe 路径 |
| `asrModelDir` | SenseVoice ONNX 目录，留空用 DSH 默认路径 |
| `ttsLog` | 语音引擎日志路径，留空用 `../engine.err` |

### 3. 启动

```bat
node server.mjs
```

或双击 `启动语音系统.cmd`。启动日志会打印带令牌的地址：

```
http://127.0.0.1:3200/?token=xxxxxxxx
```

令牌也保存在 `state/sys-token`。

### 4. 放一个参考音色

把 3~10 秒、干净、单人的 `reference.wav` 放到 `<qq-bridge>/ref/reference.wav`，
或直接在控制台「音色克隆」里上传音频，自动截取 + 识别 + 应用。

### 5. 在 QQ 里用

对机器人说：

> 用语音说：今天也要开心

## 配置示例

```json
{
  "port": 3200,
  "bridgeRoot": "../qq-bridge-main",
  "ttsHome": "D:/GPT-SoVITS/GPT-SoVITS-main",
  "python": "D:/GPT-SoVITS/python310/tools/python.exe",
  "ffmpeg": "D:/GPT-SoVITS/bin/ffmpeg.exe",
  "asrModelDir": "",
  "ttsLog": ""
}
```

## HTTP API

所有接口需要 `x-sys-token` 头或 `?token=`；只监听 `127.0.0.1`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 聚合状态 |
| POST | `/api/service` | `{name:"tts"\|"bridge", action:"start"\|"stop"}` |
| POST | `/api/voice/analyze` | `{name, data(base64)}` → 截取 + 识别 |
| POST | `/api/voice/apply` | `{id, text}` → 写参考音频 + 更新 `REF_TEXT` + 重置 MCP |
| POST | `/api/voice/test` | `{text, target}` → 合成并发送语音条 |
| GET | `/api/logs?name=bridge\|tts\|system&lines=160` | 日志尾巴 |

## 安全与隐私

- 控制台只监听回环地址，所有 API 需要令牌。
- `config.json`、`state/`、`tmp/`、`ref/`、`audio/` 都在 `.gitignore` 里；**不要提交你的令牌、聊天记录、个人音色**。
- 发送仍受 qq-bridge 的 `allow.groups` / `allow.private` 白名单与限流约束。
- 本程序**不安装、不启动 SnowLuma**：其 EULA 只允许使用者自己安装/启动/扫码。

## 已知限制

- 仅支持 Windows：启停服务依赖 `netstat` / `taskkill` / 隐藏窗口启动。
- 零样本克隆只能“接近”原声，不可能 100% 一样；参考音频越干净、文字越准，效果越好。要更像需要更多录音做微调。
- 参考音频固定一个：`<qq-bridge>/ref/reference.wav`。
- GPT-SoVITS 首次合成需要预热（GPU 约 7 秒），之后每句约 2~4 秒（RTX 5060 实测）。
- 合成若报 NLTK 资源缺失，把 `cmudict` / `averaged_perceptron_tagger_eng` / `punkt` / `punkt_tab` 放到 `%APPDATA%\nltk_data`。

## 与上游的关系

- [qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）：QQ ↔ DSH 桥接，本项目的宿主。
- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（MIT）：语音合成引擎，需自行部署。
- [SnowLuma](https://github.com/SnowLuma/SnowLuma)：QQ 网关，需自行安装与登录。
- 本项目与腾讯 / QQ / SnowLuma 无隶属关系。

## License

MIT，见 [LICENSE](./LICENSE)。
