// ── 动态语音：文字 → GPT-SoVITS → QQ 语音条 ──────────────────────────────────
// 挂在本 server 的 snowluma 命名空间下（mcp__snowluma__qq_say_voice），
// 这样 QQ preset 的既有白名单（mcp__snowluma__）就能直接放行，无需额外授权。
const TTS_URL = process.env.GPT_SOVITS_URL ?? 'http://127.0.0.1:9880';
const TTS_REF_AUDIO = process.env.GPT_SOVITS_REF ?? path.join(ROOT, 'ref', 'reference.wav');
const TTS_REF_TEXT = process.env.GPT_SOVITS_REF_TEXT
  ?? "你好，我是大肥鱼。";
const TTS_REF_LANG = process.env.GPT_SOVITS_REF_LANG ?? "zh";
const TTS_MAX_CHARS = 80;

server.tool(
  'qq_say_voice',
  '用本地 GPT-SoVITS 把一句短文本合成成语音，并以 QQ 语音条发到指定群/私聊。只适合短句（≤80 字）。发送仍受桥接白名单与限流约束；target 省略时发往第一个白名单群，没有群则发给 ownerQQ。',
  {
    text: z.string().describe('要说的内容，短句，不超过 80 字'),
    target: z.string().optional().describe('目标，格式 group:群号 或 private:QQ号；省略则用白名单第一个群 / ownerQQ'),
  },
  async ({ text, target }) => {
    const say = String(text ?? '').trim();
    if (!say) return { content: [{ type: 'text', text: 'text 为空' }], isError: true };
    if (say.length > TTS_MAX_CHARS) {
      return { content: [{ type: 'text', text: `太长（${say.length} 字），上限 ${TTS_MAX_CHARS}` }], isError: true };
    }
    const c = getConfig();
    let dest = String(target ?? '').trim();
    if (!dest) {
      const firstGroup = (c.allow?.groups ?? [])[0];
      if (firstGroup) dest = `group:${firstGroup}`;
      else if (c.ownerQQ) dest = `private:${c.ownerQQ}`;
      else return { content: [{ type: 'text', text: '没有指定 target，且白名单为空' }], isError: true };
    }
    if (!fs.existsSync(TTS_REF_AUDIO)) {
      return { content: [{ type: 'text', text: `参考音频缺失：${TTS_REF_AUDIO}` }], isError: true };
    }
    let audio;
    try {
      const res = await fetch(`${TTS_URL}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: say,
          text_lang: 'zh',
          ref_audio_path: TTS_REF_AUDIO,
          prompt_text: TTS_REF_TEXT,
          prompt_lang: TTS_REF_LANG,
          media_type: 'wav',
          streaming_mode: false,
          text_split_method: 'cut5'
        }),
        signal: AbortSignal.timeout(120_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      audio = Buffer.from(await res.arrayBuffer());
      if (audio.length < 1000) throw new Error(`返回数据过小（${audio.length} 字节）`);
    } catch (error) {
      return {
        content: [{ type: 'text', text: `GPT-SoVITS 合成失败：${error?.message ?? error}（服务是否已启动？端口 9880）` }],
        isError: true
      };
    }
    const genDir = path.join(ROOT, 'audio', 'generated');
    fs.mkdirSync(genDir, { recursive: true });
    const name = `${createHash('sha1').update(say).digest('hex').slice(0, 12)}.wav`;
    fs.writeFileSync(path.join(genDir, name), audio);
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'send-voice.mjs'), 'send', `generated/${name}`, dest], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    if (run.status !== 0) {
      return { content: [{ type: 'text', text: `发送失败（exit ${run.status}）：\n${out.slice(-600)}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `已发送语音到 ${dest}：${say}\n${out.split(/\r?\n/).filter((l) => l.includes('✅') || l.includes('messageId')).join('\n')}` }] };
  }
);
