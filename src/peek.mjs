// peek.mjs <sid> — pretty-print a dumped x-<sid>.json
import fs from 'node:fs';
const sid = process.argv[2];
const p = JSON.parse(fs.readFileSync(`x-${sid}.json`, 'utf8').replace(/^\uFEFF/, ''));
console.log('TYPE', p.type, p.tname, 'total', p.total);
if (p.parse) console.log('TRANSCRIPT / TRANSLATION:\n' + String(p.parse).slice(0, 3000));
if (p.passage) console.log('PASSAGE:\n' + String(p.passage).slice(0, 4000));
if (p.bank && p.bank.length) console.log('BANK:', p.bank.join(' | '));
if (p.prompt) console.log('PROMPT:\n' + String(p.prompt).slice(0, 2000));
(p.qs || []).forEach((q, i) => {
  console.log(`\nQ${i + 1}. ${q.q || ''}`);
  for (const [k, v] of Object.entries(q.opts || {})) console.log(`  ${k}) ${v}`);
});