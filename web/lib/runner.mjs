// Job orchestration: plan table -> extract -> solve -> (spoil) -> fill -> submit.
import { sleep } from './cdp.mjs';
import * as site from './site.mjs';
import { solveExercise, spoil } from './solver.mjs';

const DONE_HINTS = /查看解析|%|已做/;

export class Runner {
  constructor({ page, cfg, emit }) {
    this.page = page;
    this.cfg = cfg;          // {apiKey, baseUrl, model}
    this.emit = emit;
    this.stopped = false;
    this.stats = { sets: 0, ok: 0, failed: 0, skipped: 0, weeks: [] };
  }

  log(msg, level = 'info') { this.emit({ type: 'log', level, msg }); }
  stop() { this.stopped = true; this.log('收到停止指令，跑完当前这套就收手', 'warn'); }

  async run({ weeks = [], mode = 'perfect', mistakes = 0, skipFinished = true }) {
    const total = weeks.length;
    for (let i = 0; i < weeks.length; i++) {
      if (this.stopped) break;
      const week = weeks[i];
      this.log(`—— 第 ${week + 1} 周（${i + 1}/${total}）——`, 'step');
      try {
        await this.doWeek(week, { mode, mistakes, skipFinished });
      } catch (e) {
        this.stats.failed++;
        this.log(`第 ${week + 1} 周中断：${e.message}`, 'error');
      }
    }
    this.log(`全部结束：成功 ${this.stats.ok} 套，失败 ${this.stats.failed} 套，跳过 ${this.stats.skipped} 套`, 'done');
    this.emit({ type: 'done', stats: this.stats, stopped: this.stopped });
    return this.stats;
  }

  async doWeek(week, { mode, mistakes, skipFinished }) {
    const plan = await site.gotoPlan(this.page);
    if (!plan.loggedIn) throw new Error('登录态失效了，重新扫码登录');

    const table = await site.readWeek(this.page, week);
    if (!table.rows.length) { this.log(`第 ${week + 1} 周计划表是空的（可能还没解锁）`, 'warn'); return; }
    this.emit({ type: 'week', week, rows: table.rows });

    const todo = table.rows
      .map(r => ({ ...r, ex: site.parseExerciseHref(r.href) }))
      .filter(r => r.ex && r.ex.sid);

    for (const r of todo) {
      if (this.stopped) return;
      if (skipFinished && DONE_HINTS.test(r.cells.join(' '))) {
        this.stats.skipped++;
        this.log(`跳过 ${r.cells[0] || 'sid=' + r.ex.sid}（已做过）`);
        continue;
      }
      try {
        await this.doExercise(week, r.ex.sid, { mode, mistakes });
        this.stats.ok++;
      } catch (e) {
        this.stats.failed++;
        this.log(`sid=${r.ex.sid} 失败：${e.message}`, 'error');
      }
      await sleep(1200);
    }

    const after = await site.gotoPlan(this.page).then(() => site.readWeek(this.page, week)).catch(() => null);
    if (after) this.emit({ type: 'week', week, rows: after.rows, final: true });
  }

  async doExercise(week, sid, { mode, mistakes }) {
    this.stats.sets++;
    this.emit({ type: 'exercise', week, sid, status: 'start' });

    // 1) open + prove the (sid, week) context before touching anything
    await site.gotoExercise(this.page, sid, week);
    let ctx = await site.waitContext(this.page, sid, week);
    if (!ctx.ok) {
      this.log(`sid=${sid} 周次不匹配（页面 week=${ctx.week}，要 ${week}），重新导航一次`, 'warn');
      await site.gotoExercise(this.page, sid, week);
      ctx = await site.waitContext(this.page, sid, week, 12);
      if (!ctx.ok) throw new Error(`上下文仍不匹配 (page week=${ctx.week}, want ${week})`);
    }
    this.log(`sid=${sid} 第 ${week + 1} 周 ${ctx.typename || ctx.type} 题量=${ctx.total}`, 'step');

    // 2) extract facts
    const ex = await site.extractExercise(this.page);
    this.log(`抓题完成：type=${ex.type} qs=${(ex.qs || []).length} bank=${(ex.bank || []).length} 文本=${(ex.parse || ex.passage || ex.prompt || '').length} 字`);

    // 3) solve
    let payload = await solveExercise(ex, this.cfg, { log: (m, l) => this.log(m, l) });
    if (mode === 'mistakes' && mistakes > 0) {
      payload = spoil(payload, mistakes);
      this.log(`按要求故意错 ${mistakes} 处`, 'warn');
    }
    this.emit({ type: 'answer', week, sid, payload });
    this.log(`答案：${JSON.stringify(payload).slice(0, 180)}`);

    // 4) fill + submit
    const res = await site.fillAndSubmit(this.page, payload);
    this.log(`填答 ${res.filled} 处${res.miss?.length ? '，缺失 ' + JSON.stringify(res.miss) : ''}，已提交`, 'info');

    // 5) read back
    const scoreLine = (res.after.text.match(/正确率[^0-9]{0,6}([\d.]+%)/) || [])[1] || '';
    if (scoreLine) this.log(`sid=${sid} 回读正确率 ${scoreLine}`, scoreLine.startsWith('100') ? 'ok' : 'warn');
    else this.log(`sid=${sid} 提交后页面：${res.after.url}`, 'info');
    this.emit({ type: 'exercise', week, sid, status: 'done', score: scoreLine, payload });
    return res;
  }
}
