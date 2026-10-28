(() => {
  const T = s => (s || '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  const o = { sid: info.id, type: info.type, tname: info.typename, total: info.answertotal };
  if (info.parse) o.parse = info.parse.replace(/^听力原文#:#\s*/, '').trim();
  if (info.content && info.content.length < 4000) o.content = T(info.content);
  const type = info.type;
  if ([19, 30, 31, 32].includes(type)) {
    o.qs = [...document.querySelectorAll('.question_options')].map(q => {
      const opts = {};
      q.querySelectorAll('input[type=radio]').forEach(r => { const l = q.querySelector('label[for="' + r.id + '"]'); opts[r.value] = T(l ? l.innerText : '').replace(/^[A-D]\.?\s*/, ''); });
      return { id: q.getAttribute('data-id'), opts };
    });
  } else if (type === 18) {
    o.passage = T((document.querySelector('.train_center_left') || document.querySelector('#replyQuestionDiv') || document.body).innerText).slice(0, 6000);
    o.qs = [...document.querySelectorAll('.question_list li')].map(li => {
      const opts = {};
      li.querySelectorAll('input[type=radio]').forEach(r => { const l = li.querySelector('label[for="' + r.id + '"]'); opts[r.value] = T(l ? l.innerText : '').replace(/^[A-D]\.?\s*/, ''); });
      const tt = li.querySelector('.title');
      return { id: li.getAttribute('data-id'), q: T(tt ? tt.innerText : ''), opts };
    });
  } else if (type === 4) {
    const dz = document.querySelector('#blankDropzone');
    if (dz) {
      const clone = dz.cloneNode(true);
      clone.querySelectorAll('.under_line').forEach((b, i) => { b.replaceWith(document.createTextNode(' [' + (i + 1) + '] ')); });
      o.passage = T(clone.innerText).slice(0, 6000);
    }
    const s0 = document.querySelector('.blank_select');
    o.bank = s0 ? [...s0.options].map(x => x.value).filter(Boolean) : [];
  } else {
    o.prompt = T((document.querySelector('#replyQuestionDiv') || document.body).innerText).slice(0, 3000);
    const ta = document.querySelector('#answertext') || document.querySelector('textarea');
    if (ta) o.textarea = { id: ta.id, maxlen: ta.getAttribute('maxlength') };
  }
  if (!o.passage && !o.prompt) o.body = T(document.body.innerText).slice(0, 3500);
  return JSON.stringify(o);
})()
