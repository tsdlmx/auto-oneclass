// Dev helper: dump what the site actually looks like for one exercise.
//   node web/dev/inspect.mjs <sid> <week>
import fs from 'node:fs';
import { Page } from '../lib/cdp.mjs';
import * as site from '../lib/site.mjs';

const [sid, week] = process.argv.slice(2);
if (!sid) { console.error('usage: node web/dev/inspect.mjs <sid> <week>'); process.exit(2); }

const page = await Page.attach(9333, { match: 'oneclass' });
await site.gotoExercise(page, sid, week ?? 0);
const ctx = await site.waitContext(page, sid, week ?? 0).catch(e => ({ err: e.message }));
console.log('ctx:', JSON.stringify(ctx));

const keys = await page.ev(`(typeof info==='undefined') ? '[]' : JSON.stringify(Object.keys(info).reduce((a,k)=>{a[k]=String(info[k]).slice(0,120);return a;},{}))`);
console.log('info keys:', keys);

const ex = await site.extractExercise(page).catch(e => ({ err: e.message }));
console.log('extract:', JSON.stringify(ex).slice(0, 1200));

const dom = await page.ev(`JSON.stringify({
  url: location.href,
  hasAnswerText: !!document.querySelector('#answertext'),
  blankSelects: document.querySelectorAll('.blank_select').length,
  questionOptions: document.querySelectorAll('.question_options').length,
  questionListLi: document.querySelectorAll('.question_list li').length,
  questionLetters: document.querySelectorAll('.question_letter').length,
  radios: document.querySelectorAll('input[type=radio]').length,
})`);
console.log('dom:', dom);

fs.writeFileSync(`x-${sid}.json`, JSON.stringify(ex, null, 2), 'utf8');
console.log(`wrote x-${sid}.json`);
page.close();
