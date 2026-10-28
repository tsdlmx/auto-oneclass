// Everything that talks to the real student site through the attached page.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './cdp.mjs';

export const BASE = 'https://stu.oneclass.cn';
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EXTRACT_SRC = path.join(ROOT, 'src', 'extract.js');

export function parseExerciseHref(href) {
  // "/plan/exercise?id=684&week=0" (progress.mjs already trims the prefix sometimes)
  const m = /[?&]?id=(\d+)/.exec(href || '') || /^(\d+)/.exec(href || '');
  if (!m) return null;
  const wm = /[?&]week=(-?\d+)/.exec(href || '');
  return { sid: Number(m[1]), week: wm ? Number(wm[1]) : null };
}

export async function isLoggedIn(page) {
  const url = await page.ev('location.href');
  return !String(url).includes('/login');
}

/** Open /plan/index; returns {url, loggedIn}. */
export async function gotoPlan(page) {
  await page.nav(BASE + '/plan/index');
  const url = await page.ev('location.href');
  return { url, loggedIn: !String(url).includes('/login') };
}

/** Scrape the plan table of one week (0-based index). */
export async function readWeek(page, week) {
  const expr = `(async () => {
    changeWeek(${Number(week)});
    await new Promise(r => setTimeout(r, 1700));
    const rows = [...document.querySelectorAll('tr')].map(tr => {
      const tds = [...tr.querySelectorAll('td')].map(td => td.innerText.trim().replace(/\\s+/g, ' '));
      if (tds.length < 2) return null;
      const a = tr.querySelector('a[href*="exercise?id="]');
      return { href: a ? a.getAttribute('href') : null, cells: tds };
    }).filter(Boolean);
    return JSON.stringify({ n: rows.length, rows, title: document.title });
  })()`;
  return JSON.parse(await page.ev(expr));
}

/** All 12 weeks, one CDP round-trip per week. */
export async function readAllWeeks(page, weeks = 12, onWeek = () => {}) {
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const t = await readWeek(page, w);
    const rows = t.rows.map(r => {
      const ex = parseExerciseHref(r.href);
      return { sid: ex?.sid ?? null, href: r.href, cells: r.cells };
    });
    out.push({ week: w, rows });
    onWeek(w, rows);
  }
  return out;
}

export async function gotoExercise(page, sid, week) {
  await page.nav(`${BASE}/plan/exercise?id=${sid}&week=${week}`);
}

/** Wait until window.info matches (sid, week); returns the info triple. */
export async function waitContext(page, sid, week, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const raw = await page.ev(
      `(typeof info!=='undefined' && info) ? JSON.stringify({id:info.id,week:info.week,type:info.type,typename:info.typename,total:info.answertotal}) : ''`,
    );
    if (raw) {
      const j = JSON.parse(raw);
      if (String(j.id) === String(sid)) {
        return { ...j, ok: Number(j.week) === Number(week) };
      }
    }
    await sleep(500);
  }
  throw new Error('页面上下文没等到 info（可能没登录或题目已下线）');
}

/** Run the repo's extract.js in the page and return the parsed facts. */
export async function extractExercise(page) {
  const src = fs.readFileSync(EXTRACT_SRC, 'utf8');
  const raw = await page.ev(src);
  return JSON.parse(raw);
}

/** Fill and submit. payload: {letters|match|blanks|text}. */
export async function fillAndSubmit(page, payload) {
  const fill = `(() => {
    const P = ${JSON.stringify(payload)}; let n = 0; const miss = [];
    const LISTENING = [19, 30, 31, 32];
    if (P.letters) {
      const qo = [...document.querySelectorAll('.question_options')];
      if (qo.length && LISTENING.includes(info.type)) {
        qo.forEach((q, i) => {
          const r = q.querySelector('input[type=radio][value="' + P.letters[i] + '"]');
          if (r) { r.click(); n++; } else miss.push(i + ':' + P.letters[i]);
        });
      } else {
        [...document.querySelectorAll('.question_list li')].forEach((li, i) => {
          const r = li.querySelector('input[type=radio][value="' + P.letters[i] + '"]');
          if (r) { r.click(); n++; } else miss.push(i + ':' + P.letters[i]);
        });
      }
    }
    if (P.match) {
      [...document.querySelectorAll('ul.question_list li')].forEach((li, i) => {
        const slot = li.querySelector('.question_letter');
        if (!slot) return;
        slot.innerText = P.match[i];
        li.setAttribute('data-answer', P.match[i]);
        try { $(li).data('answer', P.match[i]); } catch (e) {}
        n++;
      });
    }
    if (P.blanks) [...document.querySelectorAll('.blank_select')].forEach((s, i) => {
      if (P.blanks[i] != null) { s.value = P.blanks[i]; s.dispatchEvent(new Event('change', { bubbles: true })); n++; }
    });
    if (P.text != null) {
      const ta = document.querySelector('#answertext') || document.querySelector('textarea');
      if (ta) { ta.value = P.text; ta.dispatchEvent(new Event('input', { bubbles: true })); n++; }
    }
    return JSON.stringify({ filled: n, miss });
  })()`;
  const filled = JSON.parse(await page.ev(fill));
  await page.ev(`(() => { try { BC.confirm = (m, cb) => cb(); } catch(e){}; submit(); return 1; })()`);
  await sleep(5000);
  const after = JSON.parse(await page.ev(`JSON.stringify({url: location.href, text: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 600)})`));
  return { ...filled, after };
}
