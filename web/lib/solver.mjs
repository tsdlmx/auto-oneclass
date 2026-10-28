// Answer provider: one OpenAI-compatible chat completion per exercise.
// The repo ships no answer key, so this is the "model as solver" seam.

const LISTENING = [19, 30, 31, 32];

const SYSTEM = `你是四六级英语考试的阅卷级解题者。只输出一个 JSON 对象，不要 markdown 代码块，不要解释。
所有答案必须严格对应题目顺序与数量，字母大写。`;

function cut(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function buildMessages(ex) {
  const head = `题型：${ex.tname || ''}（info.type=${ex.type}）\n题量：${ex.total || ''}`;

  if (LISTENING.includes(ex.type) || ex.type === 18) {
    const parts = [head];
    if (ex.parse) parts.push(`听力原文/翻译：\n${cut(ex.parse, 12000)}`);
    if (ex.passage) parts.push(`文章：\n${cut(ex.passage, 12000)}`);
    const qs = (ex.qs || []).map((q, i) => {
      const opts = Object.entries(q.opts || {}).map(([k, v]) => `${k}. ${v}`).join('\n');
      return `[${i + 1}] ${q.q || '(题干见原文/选项)'}\n${opts}`;
    }).join('\n\n');
    parts.push(`题目：\n${qs}`);
    parts.push(`请按题目顺序返回 {"letters":["A","B",...]}，长度必须是 ${(ex.qs || []).length}。题干为空时依据原文与选项推断。`);
    return parts.join('\n\n');
  }

  if (ex.type === 6) {
    return `${head}\n段落匹配题：把 10 个陈述匹配到段落字母。\n\n页面全文：\n${cut(ex.prompt || ex.body || '', 14000)}\n\n请返回 {"match":["F","L",...]}，10 个字母，按陈述顺序。`;
  }

  if (ex.type === 4) {
    const bank = (ex.bank || []).join(', ');
    return `${head}\n选词填空：把词库中的词填入 10 个空。词库（15 选 10）：${bank}\n\n带空文章：\n${cut(ex.passage || ex.body || '', 12000)}\n\n请返回 {"blanks":["word1",...]}，10 个词，按空号顺序，必须来自词库（可用原形/变形后的形式）。`;
  }

  // 15 作文 / 16 翻译
  const isEssay = ex.type === 15;
  return `${head}\n${isEssay ? '作文任务。要求 120-180 词，结构完整、用词地道、无语法错误。' : '汉译英任务。句子必须完整覆盖原文信息，语法正确。'}\n\n题目与要求：\n${cut(ex.prompt || ex.body || '', 8000)}\n\n请返回 {"text":"最终英文答案"}（纯文本，不要分行标记）。`;
}

export function extractJson(text) {
  const s = String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('模型没有返回 JSON：' + s.slice(0, 200));
  return JSON.parse(s.slice(a, b + 1));
}

export async function solveExercise(ex, cfg, { log = () => {} } = {}) {
  if (!cfg.apiKey) throw new Error('没有配置模型 API key（在设置里填，或放 llm-key.txt）');
  const base = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const body = {
    model: cfg.model || 'deepseek-chat',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildMessages(ex) },
    ],
    temperature: 0,
    max_tokens: 2600,
    response_format: { type: 'json_object' },
  };

  const call = async (b) => {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(cfg.timeoutMs || 120000),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`模型接口 ${r.status}: ${txt.slice(0, 300)}`);
    return JSON.parse(txt);
  };

  let resp;
  try { resp = await call(body); }
  catch (e) {
    if (/400|response_format/i.test(e.message)) {
      delete body.response_format;
      resp = await call(body);
    } else throw e;
  }

  const content = resp.choices?.[0]?.message?.content ?? '';
  const j = extractJson(content);
  return normalize(ex, j, log);
}

export function normalize(ex, j, log = () => {}) {
  if (j.letters) {
    const n = (ex.qs || []).length;
    let letters = j.letters.map(x => String(x).trim().toUpperCase()).filter(x => /^[A-H]$/.test(x));
    if (n && letters.length !== n) {
      log(`警告：模型给了 ${letters.length} 个答案，题目有 ${n} 道，已按顺序截断/补齐`, 'warn');
      if (letters.length < n) letters = [...letters, ...Array(n - letters.length).fill('A')];
      else letters = letters.slice(0, n);
    }
    return { letters };
  }
  if (j.match) {
    let m = j.match.map(x => String(x).trim().toUpperCase()).filter(x => /^[A-Z]$/.test(x));
    if (m.length !== 10) log(`警告：匹配答案 ${m.length} 个（应为 10）`, 'warn');
    return { match: m };
  }
  if (j.blanks) {
    const b = j.blanks.map(x => String(x).trim().toLowerCase().replace(/^["']|["']$/g, ''));
    if (b.length !== 10) log(`警告：选词答案 ${b.length} 个（应为 10）`, 'warn');
    return { blanks: b };
  }
  if (typeof j.text === 'string') return { text: j.text.trim() };
  throw new Error('模型返回里没有可用的答案字段：' + JSON.stringify(j).slice(0, 200));
}

/** Deliberately spoils up to `count` answers (objective items only). */
export function spoil(payload, count, seed = Math.random()) {
  const out = JSON.parse(JSON.stringify(payload));
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pickWrong = cur => {
    const all = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const cand = all.filter(x => x !== cur);
    return cand[Math.floor(rnd() * cand.length)];
  };
  if (out.letters) {
    const n = Math.min(count, out.letters.length);
    const idx = [...out.letters.keys()];
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    idx.slice(0, n).forEach(i => { out.letters[i] = pickWrong(out.letters[i]); });
  } else if (out.match) {
    const n = Math.min(count, out.match.length);
    for (let i = 0; i < n; i++) out.match[i] = pickWrong(out.match[i]);
  } else if (out.blanks) {
    const n = Math.min(count, out.blanks.length);
    for (let i = 0; i < n; i++) out.blanks[i] = (out.blanks[i] || 'the') + 'x';
  } else if (out.text) {
    // 作文/翻译没法“错一个选项”，用截断表达“故意写差”
    out.text = out.text.split(/\s+/).slice(0, Math.max(20, Math.floor(count * 10))).join(' ');
  }
  return out;
}
