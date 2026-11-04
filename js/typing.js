// Typing test engine and word display (monkeytype-style: words flow in lines,
// caret moves letter by letter, wrong words can be corrected with backspace).

import { generateWords } from './words.js';

export class TypingTest {
  /**
   * els: { box, words, caret, input, status }
   * hooks: { onExpect(char|null), onFinish(result), onStart(), onKeystroke(info) }
   */
  constructor(els, hooks) {
    this.els = els;
    this.hooks = hooks;
    this.config = { mode: 'time', time: 30, words: 25, lang: 'de', punctuation: false, numbers: false, code: false };
    this.timer = null;
    this.#bindInput();
    window.addEventListener('resize', () => this.#placeCaret());
  }

  configure(cfg) {
    Object.assign(this.config, cfg);
    this.restart();
  }

  restart() {
    clearInterval(this.timer);
    this.timer = null;
    const c = this.config;
    const count = c.mode === 'words' ? c.words : 60;
    this.words = generateWords({ lang: c.lang, count, punctuation: c.punctuation && !c.code, numbers: c.numbers && !c.code, mode: c.code ? 'code' : 'words' });
    this.typed = [''];
    this.cur = 0;
    this.started = 0;
    this.finished = false;
    this.keystrokes = [];
    this.samples = [];
    this.errorsByChar = new Map();
    this.hitsByChar = new Map();
    this.scrollLine = 0;
    this.#renderAll();
    this.#updateStatus();
    this.#emitExpect();
    this.focus();
  }

  focus() {
    this.els.input.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ input

  #bindInput() {
    const input = this.els.input;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); this.restart(); return; }
      if (this.finished) return;
      if (e.isComposing || e.key === 'Process') return;
      if (e.key === 'Backspace') {
        e.preventDefault();
        this.#backspace(e.altKey || e.ctrlKey || e.metaKey);
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        this.#space();
        return;
      }
      if (e.key === 'Enter') e.preventDefault();
    });
    input.addEventListener('input', (e) => {
      if (e.isComposing) return;
      const text = input.value;
      input.value = '';
      for (const ch of text) if (ch !== ' ' && ch !== '\n') this.#char(ch);
    });
    input.addEventListener('compositionend', (e) => {
      input.value = '';
      for (const ch of e.data || '') if (ch !== ' ') this.#char(ch);
    });
    this.els.box.addEventListener('mousedown', (e) => { e.preventDefault(); this.focus(); });
    input.addEventListener('focus', () => this.els.box.classList.remove('blurred'));
    input.addEventListener('blur', () => this.els.box.classList.add('blurred'));
  }

  #start() {
    this.started = performance.now();
    this.lastSampleAt = this.started;
    this.sampleKeys = 0;
    this.sampleErrors = 0;
    this.timer = setInterval(() => this.#tick(), 100);
    this.hooks.onStart?.();
  }

  #tick() {
    const now = performance.now();
    if (now - this.lastSampleAt >= 1000) {
      const elapsed = (now - this.started) / 1000;
      this.samples.push({
        t: Math.round(elapsed), wpm: this.#wpm(elapsed), raw: (this.sampleKeys / 5) * 60, errors: this.sampleErrors,
      });
      this.lastSampleAt += 1000;
      this.sampleKeys = 0;
      this.sampleErrors = 0;
    }
    if (this.config.mode === 'time' && now - this.started >= this.config.time * 1000) this.#finish();
    this.#updateStatus();
  }

  #record(correct, expected) {
    this.keystrokes.push({ t: performance.now(), correct });
    this.sampleKeys++;
    if (!correct) this.sampleErrors++;
    if (expected !== undefined) {
      this.hitsByChar.set(expected, (this.hitsByChar.get(expected) || 0) + 1);
      if (!correct) this.errorsByChar.set(expected, (this.errorsByChar.get(expected) || 0) + 1);
    }
    this.hooks.onKeystroke?.({ correct, expected });
  }

  #char(ch) {
    if (this.finished) return;
    if (!this.started) this.#start();
    const word = this.words[this.cur];
    const typed = this.typed[this.cur];
    if (typed.length >= word.length + 10) return; // cap extra letters
    const expected = word[typed.length];
    this.#record(ch === expected, expected);
    this.typed[this.cur] = typed + ch;
    this.#renderWord(this.cur);
    // last word typed correctly in words mode -> done without trailing space
    if (this.config.mode === 'words' && this.cur === this.words.length - 1 && this.typed[this.cur] === word) {
      this.#finish();
      return;
    }
    this.#emitExpect();
  }

  #space() {
    if (!this.started || this.finished) return;
    const typed = this.typed[this.cur];
    if (!typed) return;
    const word = this.words[this.cur];
    this.#record(typed === word, ' ');
    this.els.words.children[this.cur]?.classList.toggle('error', typed !== word);
    if (this.cur === this.words.length - 1) { this.#finish(); return; }
    this.cur++;
    this.typed[this.cur] = '';
    if (this.config.mode === 'time' && this.words.length - this.cur < 30) this.#appendWords(40);
    this.#renderWord(this.cur);
    this.#emitExpect();
  }

  #backspace(wholeWord) {
    if (this.finished) return;
    let typed = this.typed[this.cur];
    if (!typed) {
      if (this.cur === 0) return;
      const prev = this.cur - 1;
      if (this.typed[prev] === this.words[prev]) return; // correct words are locked
      this.typed[this.cur] = '';
      this.#renderWord(this.cur);
      this.cur = prev;
      this.els.words.children[prev].classList.remove('error');
      typed = this.typed[prev];
      if (!wholeWord) {
        this.#renderWord(prev);
        this.#emitExpect();
        return;
      }
    }
    this.typed[this.cur] = wholeWord ? '' : typed.slice(0, -1);
    this.#renderWord(this.cur);
    this.#emitExpect();
  }

  #appendWords(n) {
    const c = this.config;
    const more = generateWords({ lang: c.lang, count: n, punctuation: c.punctuation && !c.code, numbers: c.numbers && !c.code, mode: c.code ? 'code' : 'words' });
    for (const w of more) {
      this.words.push(w);
      this.els.words.appendChild(this.#wordNode(w, ''));
    }
  }

  #emitExpect() {
    const word = this.words[this.cur];
    const typed = this.typed[this.cur] || '';
    let ch = null;
    if (typed.length < word.length) ch = word[typed.length];
    else if (this.cur < this.words.length - 1) ch = ' ';
    // with a typo in the word, the next useful key is backspace
    const wrong = !word.startsWith(typed);
    this.hooks.onExpect?.(wrong ? '\b' : ch);
  }

  // ------------------------------------------------------------------ stats

  #correctChars(includeCurrent) {
    let n = 0;
    const last = includeCurrent ? this.cur : this.cur - 1;
    for (let i = 0; i <= last; i++) {
      const w = this.words[i], t = this.typed[i] || '';
      if (t === w) n += w.length + (i < this.cur ? 1 : 0);
    }
    return n;
  }

  #wpm(elapsedSec) {
    if (elapsedSec <= 0) return 0;
    return (this.#correctChars(false) / 5) * (60 / elapsedSec);
  }

  #finish() {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.timer);
    const now = performance.now();
    const elapsed = this.config.mode === 'time' ? Math.min(this.config.time, (now - this.started) / 1000) : (now - this.started) / 1000;
    let correct = 0, incorrect = 0, extra = 0, missed = 0;
    for (let i = 0; i <= this.cur; i++) {
      const w = this.words[i], t = this.typed[i] || '';
      for (let j = 0; j < Math.max(w.length, t.length); j++) {
        if (j >= t.length) { if (i < this.cur) missed++; }
        else if (j >= w.length) extra++;
        else if (t[j] === w[j]) correct++;
        else incorrect++;
      }
    }
    const typedAll = this.keystrokes.length;
    const correctKeys = this.keystrokes.filter((k) => k.correct).length;
    const minutes = elapsed / 60;
    const wpm = (this.#correctChars(true) / 5) / minutes;
    const raw = (typedAll / 5) / minutes;
    const raws = this.samples.map((s) => s.raw);
    const mean = raws.reduce((a, b) => a + b, 0) / (raws.length || 1);
    const sd = Math.sqrt(raws.reduce((a, b) => a + (b - mean) ** 2, 0) / (raws.length || 1));
    const consistency = mean ? Math.max(0, 100 - (sd / mean) * 100) : 0;
    if (now - this.lastSampleAt > 250) {
      this.samples.push({ t: Math.round(elapsed * 10) / 10, wpm: this.#wpm(elapsed), raw: (this.sampleKeys / ((now - this.lastSampleAt) / 1000) / 5) * 60, errors: this.sampleErrors });
    }
    this.#updateStatus();
    this.hooks.onExpect?.(null);
    this.hooks.onFinish?.({
      wpm: isFinite(wpm) ? wpm : 0, raw: isFinite(raw) ? raw : 0,
      acc: typedAll ? (correctKeys / typedAll) * 100 : 0, consistency,
      chars: { correct, incorrect, extra, missed }, time: elapsed, samples: this.samples,
      errorsByChar: this.errorsByChar, hitsByChar: this.hitsByChar, config: { ...this.config },
    });
  }

  #updateStatus() {
    const c = this.config;
    let text;
    if (c.mode === 'time') {
      const left = this.started ? Math.max(0, c.time - (performance.now() - this.started) / 1000) : c.time;
      text = String(Math.ceil(left));
    } else {
      text = `${Math.min(this.cur, this.words.length)}/${this.words.length}`;
    }
    const live = this.started && !this.finished ? Math.round(this.#wpm((performance.now() - this.started) / 1000)) : '';
    this.els.status.innerHTML = `<span class="count">${text}</span>${live !== '' ? `<span class="live">${live} wpm</span>` : ''}`;
    this.els.status.classList.toggle('running', !!this.started && !this.finished);
  }

  // ------------------------------------------------------------------ rendering

  #wordNode(word, typed) {
    const div = document.createElement('div');
    div.className = 'word';
    this.#fillWord(div, word, typed);
    return div;
  }

  #fillWord(div, word, typed) {
    let html = '';
    for (let i = 0; i < Math.max(word.length, typed.length); i++) {
      if (i >= word.length) html += `<span class="l extra">${esc(typed[i])}</span>`;
      else if (i >= typed.length) html += `<span class="l">${esc(word[i])}</span>`;
      else html += `<span class="l ${typed[i] === word[i] ? 'ok' : 'bad'}">${esc(word[i])}</span>`;
    }
    div.innerHTML = html;
  }

  #renderAll() {
    const box = this.els.words;
    box.innerHTML = '';
    box.style.transform = '';
    this.words.forEach((w, i) => box.appendChild(this.#wordNode(w, this.typed[i] || '')));
    this.#placeCaret();
  }

  #renderWord(i) {
    const div = this.els.words.children[i];
    if (div) {
      this.#fillWord(div, this.words[i], this.typed[i] || '');
      div.classList.toggle('active', i === this.cur);
    }
    for (const d of this.els.words.querySelectorAll('.word.active')) if (d !== this.els.words.children[this.cur]) d.classList.remove('active');
    this.els.words.children[this.cur]?.classList.add('active');
    this.#placeCaret();
  }

  #placeCaret() {
    const wordEl = this.els.words.children[this.cur];
    if (!wordEl) return;
    const typed = this.typed[this.cur] || '';
    const letters = wordEl.children;
    let left, top, h;
    if (typed.length < letters.length) {
      const l = letters[typed.length];
      left = l.offsetLeft; top = l.offsetTop; h = l.offsetHeight;
    } else {
      const l = letters[letters.length - 1];
      left = l.offsetLeft + l.offsetWidth; top = l.offsetTop; h = l.offsetHeight;
    }
    // letters' offsetParent is .words (position: relative), so offsets are already line positions
    const lineH = wordEl.offsetHeight + parseFloat(getComputedStyle(wordEl).marginBottom || 0);
    const line = Math.round(top / lineH);
    this.scrollLine = Math.max(0, line - 1); // keep the active line as the 2nd visible line
    this.els.words.style.transform = `translateY(${-this.scrollLine * lineH}px)`;
    const caret = this.els.caret;
    caret.style.height = h + 'px';
    caret.style.transform = `translate(${left}px, ${top - this.scrollLine * lineH}px)`;
    caret.classList.toggle('typing', !!this.started);
  }
}

function esc(ch) {
  return ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch === '"' ? '&quot;' : ch;
}
