#!/usr/bin/env node
// 大肥鱼语音系统 —— 本地控制台
// 纯 Node（无第三方依赖）：状态看板 / 一键启停 / 音色克隆 / 试听发送 / 日志。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const CFG = readJson(path.join(ROOT, 'config.json'), {});
const WORKSPACE = path.resolve(ROOT, '..');
const BRIDGE = path.resolve(ROOT, CFG.bridgeRoot || '../qq-bridge-main');
const CONFIG_FILE = path.join(BRIDGE, 'config.json');
const TTS_HOME = CFG.ttsHome || 'D:/GPT-SoVITS/GPT-SoVITS-main';
const PY = CFG.python || 'D:/GPT-SoVITS/python310/tools/python.exe';
const FFMPEG = CFG.ffmpeg || 'D:/GPT-SoVITS/bin/ffmpeg.exe';
const ASR_SCRIPT = path.join(ROOT, 'asr-infer.py');
const ASR_MODEL_DIR = CFG.asrModelDir || path.join(os.homedir(), '.dsh', 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx');
const TTS_LOG = CFG.ttsLog || path.join(WORKSPACE, 'engine.err');
const TMP = path.join(ROOT, 'tmp');
const STATE = path.join(ROOT, 'state');
const PORT = Number(process.env.QVS_PORT || CFG.port || 3200);
const MAX_UPLOAD = 30 * 1024 * 1024;

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });

const TOKEN_FILE = path.join(STATE, 'sys-token');
let TOKEN = '';
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, TOKEN, 'utf8');
}

const analyses = new Map(); // id -> { wav32, wav16, text, seconds, createdAt }

function log(...args) {
  const line = `${new Date().toLocaleString('zh-CN', { hour12: false })} ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(STATE, 'system.log'), line + '\n', 'utf8'); } catch {}
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeout ?? 120000,
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 32 * 1024 * 1024
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, out, code: r.status ?? -1, error: r.error?.message };
}

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function portPid(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
      if (m && Number(m[2]) === port) return Number(m[3]);
    }
  } catch {}
  return null;
}

function killPort(port) {
  const pid = portPid(port);
  if (!pid) return { ok: true, already: true };
  const r = run('taskkill', ['/PID', String(pid), '/F', '/T']);
  return { ok: r.ok, pid, out: r.out };
}

function fmtTime(ts) {
  try { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); } catch { return ''; }
}

function tail(file, lines = 120) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).slice(-lines).join('\n');
  } catch { return ''; }
}

async function probe(url, timeout = 2500, init = {}) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    return { ok: true, status: res.status };
  } catch (error) {
    return { ok: false, error: error?.cause?.code || error.message };
  }
}

function bridgeConsoleToken() {
  try { return fs.readFileSync(path.join(BRIDGE, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

async function getStatus() {
  const cfg = readJson(CONFIG_FILE, {});
  const dshBase = cfg?.dsh?.baseUrl || '';
  const dsh = dshBase ? await probe(dshBase, 2000) : { ok: false };
  const bridgePid = portPid(3100);
  const ttsPid = portPid(9880);
  const slPid = portPid(3000);

  let snowluma = { ok: false };
  if (slPid) {
    try {
      const r = await fetch('http://127.0.0.1:3000/get_login_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg?.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) },
        body: '{}',
        signal: AbortSignal.timeout(2500)
      });
      const j = await r.json();
      snowluma = { ok: j?.status === 'ok', nickname: j?.data?.nickname, userId: j?.data?.user_id };
      // get_login_info 常返回登录时缓存的旧昵称；再查一次 QQ 侧资料，拿到当前昵称。
      if (snowluma.ok && j?.data?.user_id != null) {
        try {
          const r2 = await fetch('http://127.0.0.1:3000/get_stranger_info', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(cfg?.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) },
            body: JSON.stringify({ user_id: j.data.user_id, no_cache: true }),
            signal: AbortSignal.timeout(2500)
          });
          const j2 = await r2.json();
          if (j2?.data?.nickname) snowluma.nickname = j2.data.nickname;
        } catch {}
      }
    } catch (error) { snowluma = { ok: false, error: error.message }; }
  }

  let bridge = { ok: false };
  if (bridgePid) {
    try {
      const r = await fetch('http://127.0.0.1:3100/api/status', {
        headers: { 'x-console-token': bridgeConsoleToken() },
        signal: AbortSignal.timeout(2500)
      });
      const j = await r.json();
      bridge = { ok: true, mode: j.mode, dshReady: j.dshReady, snowluma: j.snowluma?.connected, owner: j.ownerQQ };
    } catch (error) { bridge = { ok: false, error: error.message }; }
  }

  let gpu = null;
  const g = run('nvidia-smi', ['--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 4000 });
  if (g.ok) {
    const [used, total, util] = String(g.out).trim().split(',').map((s) => s.trim());
    gpu = { used: Number(used), total: Number(total), util: Number(util) };
  }

  return {
    ok: true,
    time: fmtTime(Date.now()),
    dsh: { ok: dsh.ok, url: dshBase, status: dsh.status ?? null },
    snowluma: { ok: snowluma.ok, port: 3000, pid: slPid, ...snowluma },
    bridge: { ok: !!bridgePid, port: 3100, pid: bridgePid, ...bridge },
    tts: { ok: !!ttsPid, port: 9880, pid: ttsPid },
    gpu,
    botName: cfg?.botName || snowluma.nickname || '',
    owner: cfg?.ownerQQ || null,
    allowGroups: cfg?.allow?.groups ?? [],
    allowPrivate: cfg?.allow?.private ?? [],
    sys: { port: PORT, tokenSet: true, uptime: Math.round(process.uptime()) }
  };
}

async function startTts() {
  if (portPid(9880)) return { ok: true, already: true };
  const env = { ...process.env, PATH: `D:/GPT-SoVITS/bin;${process.env.PATH || ''}`, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  const child = spawn(PY, ['api_v2.py', '-a', '127.0.0.1', '-p', '9880', '-c', 'GPT_SoVITS/configs/tts_infer_gpu.yaml'], {
    cwd: TTS_HOME, env, detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (portPid(9880)) return { ok: true, started: true, seconds: i + 1 };
  }
  return { ok: false, error: '启动超时（90 秒）' };
}

function startBridge() {
  if (portPid(3100)) return { ok: true, already: true };
  const child = spawn('cmd.exe', ['/c', 'start-qq-bridge.cmd'], {
    cwd: BRIDGE, detached: true, stdio: 'ignore', windowsHide: true, env: process.env
  });
  child.unref();
  return { ok: true, started: true };
}

function analyzeSilence(wav16) {
  const r = run(FFMPEG, ['-hide_banner', '-i', wav16, '-af', 'silencedetect=noise=-32dB:d=0.25', '-f', 'null', '-'], { timeout: 60000 });
  const text = `${r.out}`;
  const events = [];
  for (const m of text.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
    events.push({ kind: m[1], at: Number(m[2]) });
  }
  const durR = run(FFMPEG, ['-hide_banner', '-i', wav16], { timeout: 20000 });
  const dm = `${durR.out}`.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const duration = dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 0;
  let start = 0;
  let end = duration;
  if (events.length) {
    if (events[0].kind === 'start' && events[0].at <= 0.5) {
      const e = events.find((x) => x.kind === 'end' && x.at > events[0].at);
      if (e) start = e.at;
    }
    const lastEnd = events[events.length - 1];
    if (lastEnd.kind === 'end' && Math.abs(lastEnd.at - duration) < 0.4) {
      const s = [...events].reverse().find((x) => x.kind === 'start' && x.at > start + 0.3);
      if (s) end = s.at;
    }
  }
  if (end - start < 1) { start = 0; end = duration; }
  return { start: Math.max(0, start - 0.1), end: Math.min(duration, end + 0.1), duration };
}

function readConstString(src, marker) {
  const idx = src.indexOf(marker);
  if (idx < 0) return '';
  const q = src.indexOf('??', idx);
  if (q < 0) return '';
  let i = q;
  while (i < src.length && src[i] !== '"' && src[i] !== "'") i++;
  if (i >= src.length) return '';
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === quote) break;
    j++;
  }
  if (j >= src.length) return '';
  try { return JSON.parse(quote === '"' ? src.slice(i, j + 1) : `"${src.slice(i + 1, j).replace(/"/g, '\\"')}"`); }
  catch { return src.slice(i + 1, j); }
}

function replaceConstString(file, marker, text) {
  let s = fs.readFileSync(file, 'utf8');
  const idx = s.indexOf(marker);
  if (idx < 0) return false;
  const q = s.indexOf('??', idx);
  if (q < 0) return false;
  let i = q;
  while (i < s.length && s[i] !== '"' && s[i] !== "'") i++;
  if (i >= s.length) return false;
  const quote = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === quote) break;
    j++;
  }
  if (j >= s.length) return false;
  s = s.slice(0, i) + JSON.stringify(String(text)) + s.slice(j + 1);
  fs.writeFileSync(file, s, 'utf8');
  return true;
}

function killMcp() {
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*mcp-snowluma-safe.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
  const r = run('powershell', ['-NoProfile', '-Command', cmd], { timeout: 15000 });
  return { ok: r.ok, out: r.out };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } catch { res.writeHead(500); res.end('UI missing'); }
    return;
  }

  if (!pathname.startsWith('/api/')) { res.writeHead(404); res.end('not found'); return; }

  const supplied = String(url.searchParams.get('token') || req.headers['x-sys-token'] || '');
  if (supplied !== TOKEN) { json(res, 401, { ok: false, error: 'unauthorized' }); return; }

  try {
    if (req.method === 'GET' && pathname === '/api/status') {
      return json(res, 200, await getStatus());
    }

    if (req.method === 'POST' && pathname === '/api/service') {
      const body = await readBody(req);
      const name = String(body.name || '');
      const action = String(body.action || '');
      let result;
      if (name === 'tts' && action === 'start') result = await startTts();
      else if (name === 'tts' && action === 'stop') result = killPort(9880);
      else if (name === 'bridge' && action === 'start') result = startBridge();
      else if (name === 'bridge' && action === 'stop') result = killPort(3100);
      else return json(res, 400, { ok: false, error: '未知服务或动作' });
      log(`service ${name} ${action}:`, JSON.stringify(result));
      return json(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/logs') {
      const name = String(url.searchParams.get('name') || 'bridge');
      const lines = Math.min(500, Number(url.searchParams.get('lines') || 120));
      const files = {
        bridge: path.join(BRIDGE, 'state', 'bridge.log'),
        tts: TTS_LOG,
        system: path.join(STATE, 'system.log')
      };
      const file = files[name] || files.bridge;
      return json(res, 200, { ok: true, file, text: tail(file, lines) });
    }

    if (req.method === 'POST' && pathname === '/api/voice/analyze') {
      const body = await readBody(req);
      const data = String(body.data || '');
      const name = String(body.name || 'audio');
      const lang = String(body.lang || 'auto').trim() || 'auto';
      if (!data) return json(res, 400, { ok: false, error: '缺少音频数据' });
      const buf = Buffer.from(data, 'base64');
      if (buf.length < 1000) return json(res, 400, { ok: false, error: '音频为空或过小' });
      const id = crypto.randomBytes(8).toString('hex');
      const ext = (path.extname(name) || '.wav').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.wav';
      const upload = path.join(TMP, `${id}${ext}`);
      fs.writeFileSync(upload, buf);
      const wav16 = path.join(TMP, `${id}-16k.wav`);
      const conv = run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', upload, '-ar', '16000', '-ac', '1', wav16], { timeout: 60000 });
      if (!conv.ok) return json(res, 400, { ok: false, error: `音频转码失败：${conv.error || `exit ${conv.code}`} ${String(conv.out).slice(0, 300)}` });
      const { start, end, duration } = analyzeSilence(wav16);
      const seconds = Math.min(9.5, Math.max(1, end - start));
      const wav32 = path.join(TMP, `${id}-32k.wav`);
      const trim = run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(seconds), '-i', wav16, '-ar', '32000', '-ac', '1', wav32], { timeout: 60000 });
      if (!trim.ok) return json(res, 400, { ok: false, error: `截取失败：${trim.out.slice(0, 300)}` });
      const wav16Trim = path.join(TMP, `${id}-16k-trim.wav`);
      run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(seconds), '-i', wav16, '-ar', '16000', '-ac', '1', wav16Trim], { timeout: 60000 });
      const asr = run(PY, [ASR_SCRIPT, wav16Trim], { timeout: 180000, env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ASR_LANG: lang } });
      const text = asr.ok ? String(asr.out).trim().split(/\r?\n/).pop() || '' : '';
      analyses.set(id, { wav32, text, seconds, lang, createdAt: Date.now() });
      log(`analyze ${id}: ${seconds.toFixed(2)}s text=${text.slice(0, 40)}`);
      return json(res, 200, {
        ok: true, id, text, lang, start: Number(start.toFixed(2)), end: Number(end.toFixed(2)),
        sourceDuration: Number(duration.toFixed(2)), seconds: Number(seconds.toFixed(2)),
        audio: fs.readFileSync(wav32).toString('base64')
      });
    }

    if (req.method === 'POST' && pathname === '/api/voice/apply') {
      const body = await readBody(req);
      const id = String(body.id || '');
      const text = String(body.text || '').trim();
      const lang = String(body.lang || '').trim();
      const item = analyses.get(id);
      if (!item) return json(res, 400, { ok: false, error: '分析结果已过期，请重新上传' });
      if (!text) return json(res, 400, { ok: false, error: '参考文字不能为空' });
      if (!fs.existsSync(path.join(BRIDGE, 'ref'))) fs.mkdirSync(path.join(BRIDGE, 'ref'), { recursive: true });
      const backup = path.join(BRIDGE, 'ref', `reference-backup-${Date.now()}.wav`);
      const target = path.join(BRIDGE, 'ref', 'reference.wav');
      if (fs.existsSync(target)) fs.copyFileSync(target, backup);
      fs.copyFileSync(item.wav32, target);
      const a = replaceConstString(path.join(BRIDGE, 'src', 'mcp-snowluma-safe.js'), 'TTS_REF_TEXT', text);
      const b = replaceConstString(path.join(BRIDGE, 'src', 'mcp-voice-tts.js'), 'REF_TEXT', text);
      const l = lang ? replaceConstString(path.join(BRIDGE, 'src', 'mcp-snowluma-safe.js'), 'TTS_REF_LANG', lang) : true;
      const kill = killMcp();
      log(`apply ${id}: ref updated, lang=${lang || '(keep)'}, text=${text.slice(0, 40)}, mcp reset=${kill.ok}`);
      return json(res, 200, { ok: true, backup, refText: a && b, refLang: l, mcp: kill.ok });
    }

    if (req.method === 'POST' && pathname === '/api/voice/test') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      const target = String(body.target || '').trim();
      if (!text) return json(res, 400, { ok: false, error: '测试文本不能为空' });
      const cfg = readJson(CONFIG_FILE, {});
      let dest = target;
      if (!dest) {
        const g = (cfg.allow?.groups ?? [])[0];
        dest = g ? `group:${g}` : (cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '');
      }
      if (!dest) return json(res, 400, { ok: false, error: '没有可用发送目标' });
      const ref = path.join(BRIDGE, 'ref', 'reference.wav');
      if (!fs.existsSync(ref)) return json(res, 400, { ok: false, error: '参考音频不存在' });
      const markerFile = path.join(BRIDGE, 'src', 'mcp-snowluma-safe.js');
      const src = fs.readFileSync(markerFile, 'utf8');
      const promptText = readConstString(src, 'TTS_REF_TEXT');
      const refLang = readConstString(src, 'TTS_REF_LANG') || 'zh';
      const t0 = Date.now();
      let audio;
      try {
        const r = await fetch('http://127.0.0.1:9880/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, text_lang: 'zh', ref_audio_path: ref, prompt_text: promptText, prompt_lang: refLang, media_type: 'wav', streaming_mode: false, text_split_method: 'cut5' }),
          signal: AbortSignal.timeout(180000)
        });
        if (!r.ok) return json(res, 400, { ok: false, error: `TTS ${r.status}: ${(await r.text()).slice(0, 300)}` });
        audio = Buffer.from(await r.arrayBuffer());
      } catch (error) {
        return json(res, 400, { ok: false, error: `TTS 合成失败：${error.message}` });
      }
      const genDir = path.join(BRIDGE, 'audio', 'generated');
      fs.mkdirSync(genDir, { recursive: true });
      const name = `sys-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 10)}.wav`;
      fs.writeFileSync(path.join(genDir, name), audio);
      const send = run(process.execPath, [path.join(BRIDGE, 'scripts', 'send-voice.mjs'), 'send', `generated/${name}`, dest], { cwd: BRIDGE, timeout: 90000 });
      const out = `${send.out}`;
      const mid = out.match(/messageId=(-?\d+)/)?.[1] ?? null;
      log(`test voice -> ${dest}: ${mid ?? 'no id'}`);
      return json(res, 200, { ok: send.ok, target: dest, messageId: mid, ms: Date.now() - t0, out: out.slice(-800) });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    log('ERROR', error?.stack || error?.message || error);
    return json(res, 500, { ok: false, error: error?.message ?? String(error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`大肥鱼语音系统已启动：http://127.0.0.1:${PORT}/?token=${TOKEN}`);
  log(`令牌文件：${TOKEN_FILE}`);
});
