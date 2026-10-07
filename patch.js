// SIG:Nj3+wB68VmdZORPl5pEcAp1XGs2qP7w055eURktMUlcmEpEedRNc+t9testwLeIL0Rs36xbD69r65azODoXA8Q==
(function () {
'use strict';
/* ============================================================================
   Super Zombie — "Word Cure" spelling patch
   Version 1.1.2
   Copyright (C) 2026 Gumb Dames
   SPDX-License-Identifier: AGPL-3.0-only

   A signed optional patch for Super Zombie v2.1.1. Zombies carry scrambled
   English words in floating bubbles; walk up to one to open a gentle 4-stage
   spelling minigame and cure it. No killing, no weapons, no violence — cured
   neighbors join a parade behind your van. Words below 3 stars come back
   later (spaced repetition); master every word to earn the Word Doctor
   Diploma.
   Scaffold fading: the correct spelling is shown only in stage 1 ("See &
   Hear"); stages 2-4 hide it so the player recalls rather than copies
   (v1.0.1).
   Two levels (v1.1.0): LEVEL 1 is the four-stage learning mode above.
   Finishing it (3 stars on every word) unlocks LEVEL 2: WORD MASTER, the
   final exam — zombies carry no letters (a "?" bubble) and each encounter
   jumps straight to hear-and-spell. All words at 3 stars in the exam earns
   the Word Master Diploma. Desktop parent shortcut: hold Shift on the title
   screen and the button reads "📚 Word Cure 2"; clicking starts Level 2.
   Schools (v1.1.1): Level 1 takes place in the Noam school (base level 4),
   Level 2 in the Yavne school (base level 5) — the base game's own school
   buildings. The night2 level-progression is defused in-mode (no portal,
   no win screen): the session simply rolls into a fresh day at its school.

   This program is free software: you can redistribute it and/or modify it
   under the terms of the GNU Affero General Public License as published by
   the Free Software Foundation, version 3 of the License.
   ========================================================================== */

/* ---- 0. Date gate (FIRST statement): the patch goes quiet after this ----
   Mockable for tests: the loader suite overrides Date.now. */
if (Date.now() >= Date.UTC(2026, 9, 17, 0, 0, 0)) return; // Oct 17 2026 00:00 UTC

window.WORDCURE_PATCH_VERSION = '1.1.2'; // stamp (after the gate: expired => zero trace)

var SZ = window.SZ20;
if (!SZ || !SZ.HOOKS || !SZ.kit || !SZ.spawnBird) return; // needs game v2.0.25+
var H = SZ.HOOKS, kit = SZ.kit, CFG = SZ.CFG;
var W = CFG.worldSize;
var THREE = window.THREE;

/* ==========================================================================
   1. Pure word helpers (no DOM, no game — unit-testable via WORDCURE_TEST)
   ========================================================================== */
var BUILTIN_WORDS = ['cat', 'sun', 'dog', 'fish', 'bird', 'tree', 'moon', 'star',
  'cake', 'ball', 'book', 'happy', 'water', 'green', 'house', 'apple', 'smile',
  'flower', 'friend', 'music', 'rainbow', 'school', 'doctor', 'zebra'];

/* Parse a .txt word list: one word per line, trimmed, lowercased, kept only
   when it matches /^[a-z]{2,12}$/, deduplicated, capped at 100. */
function parseWordList(text) {
  var out = [], seen = {};
  var lines = String(text).split('\n');
  for (var i = 0; i < lines.length; i++) {
    var w = lines[i].trim().toLowerCase();
    if (!/^[a-z]{2,12}$/.test(w)) continue;
    if (seen[w]) continue;
    seen[w] = true;
    out.push(w);
    if (out.length >= 100) break;
  }
  return out;
}

/* Fisher-Yates shuffle of a word's letters; nudged so the result differs
   from the word itself whenever the word has 2+ letters. */
function scrambleLetters(word) {
  var a = word.split('');
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  var s = a.join('');
  if (s === word && word.length > 1) {
    var b = s.split(''); var tt = b[0]; b[0] = b[1]; b[1] = tt; s = b.join('');
  }
  return s;
}

function shuffleInPlace(a) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* Star rules (stages 2-4 only; stage 1 cannot produce mistakes or hints):
     3 stars — zero mistakes AND zero hints used.
     2 stars — minor mistakes/hints (anything between).
     1 star  — "heavy help": 4 or more mistakes, or 3 or more hint uses. */
function awardStars(mistakes, hints) {
  if (mistakes <= 0 && hints <= 0) return 3;
  if (mistakes >= 4 || hints >= 3) return 1;
  return 2;
}

/* Gap count scales with word length: 1 gap for <=4 letters, 2 for 5-7, 3 for 8+. */
function gapsForWord(word) {
  var n = word.length;
  return n <= 4 ? 1 : (n <= 7 ? 2 : 3);
}

/* Random distinct gap indices (sorted). rnd is injectable for tests. */
function makeGapPlan(word, rnd) {
  var n = gapsForWord(word), idx = [], pool = [], i;
  for (i = 0; i < word.length; i++) pool.push(i);
  rnd = rnd || Math.random;
  for (var k = 0; k < n && pool.length; k++) {
    var p = Math.floor(rnd() * pool.length);
    idx.push(pool.splice(p, 1)[0]);
  }
  idx.sort(function (a, b) { return a - b; });
  return idx;
}

/* Spaced-repetition queue: pick the least-attempted word with <3 stars that
   no live carrier is currently holding. Returns the index, or -1 when every
   loaded word is mastered (or the list is empty). sk selects the star field:
   'stars' for Level 1, 'stars2' for the Level 2 exam. */
function pickWordIndex(words, carried, sk) {
  sk = (sk === 'stars2') ? 'stars2' : 'stars';
  var best = -1, bestAtt = Infinity, i;
  for (i = 0; i < words.length; i++) {
    if (words[i][sk] >= 3) continue;
    if (carried && carried.indexOf(words[i].w) !== -1) continue;
    if (words[i].attempts < bestAtt || (words[i].attempts === bestAtt && Math.random() < 0.5)) {
      best = i; bestAtt = words[i].attempts;
    }
  }
  if (best === -1) { // everything unmastered is on screen: allow a duplicate
    for (i = 0; i < words.length; i++) {
      if (words[i][sk] >= 3) continue;
      if (words[i].attempts < bestAtt || (words[i].attempts === bestAtt && Math.random() < 0.5)) {
        best = i; bestAtt = words[i].attempts;
      }
    }
  }
  return best;
}

/* Decoys for stage 3: n random letters not among the correct ones. */
function pickDecoys(correct, n) {
  var have = {}, i;
  for (i = 0; i < correct.length; i++) have[correct[i]] = true;
  var pool = [];
  for (i = 0; i < 26; i++) {
    var ch = String.fromCharCode(97 + i);
    if (!have[ch]) pool.push(ch);
  }
  shuffleInPlace(pool);
  return pool.slice(0, n);
}

/* Spoken letter names for stage 1 ("ay", "bee", ...). */
var LETTER_NAMES = { a: 'ay', b: 'bee', c: 'see', d: 'dee', e: 'ee', f: 'ef',
  g: 'gee', h: 'aitch', i: 'eye', j: 'jay', k: 'kay', l: 'el', m: 'em',
  n: 'en', o: 'oh', p: 'pee', q: 'cue', r: 'ar', s: 'ess', t: 'tee',
  u: 'you', v: 'vee', w: 'double-you', x: 'ex', y: 'wy', z: 'zed' };

function starStr(n) { var s = ''; for (var i = 0; i < 3; i++) s += i < n ? '★' : '☆'; return s; }

/* ==========================================================================
   2. Test namespace. Inert: pure helpers plus mode start/stop entry points
   that do not require a real file upload. Defining it has no effect on
   gameplay. Non-enumerable to stay out of the way.
   ========================================================================== */
Object.defineProperty(window, 'WORDCURE_TEST', {
  enumerable: false, configurable: true, writable: false,
  value: {
    version: '1.1.2',
    parseWordList: parseWordList,
    scrambleLetters: scrambleLetters,
    awardStars: awardStars,
    gapsForWord: gapsForWord,
    makeGapPlan: makeGapPlan,
    pickWordIndex: pickWordIndex,
    builtinWords: BUILTIN_WORDS.slice(),
    start: function (words, level) { startWordCure(words, level); },
    stop: function () { exitWordCure(); },
    state: function () {
      return {
        on: wcOn,
        level: WC ? WC.level : null,
        viewLevel: WC ? WC.viewLevel : null,
        words: WC ? WC.words.map(function (e) { return { w: e.w, stars: e.stars, stars2: e.stars2, attempts: e.attempts }; }) : null,
        sessionStars: WC ? WC.sessionStars : 0,
        best: bestSessionStars,
        curing: !!(WC && WC.curing),
        curingWord: (WC && WC.curing) ? WC.curing.word : null, // the word actually being cured (exam: never shown in UI)
        unlocked2: level2UnlockedNow()
      };
    }
  }
});

/* ==========================================================================
   3. Speech. EVERY speech call in the patch goes through speak(), which
   silently does nothing when speechSynthesis is missing or throws — the
   mode always works without audio. English voice preferred when available.
   ========================================================================== */
var enVoice = null, enVoiceTried = false;
function pickEnVoice() {
  try {
    if (!('speechSynthesis' in window)) return null;
    if (enVoiceTried) return enVoice;
    enVoiceTried = true;
    var vs = window.speechSynthesis.getVoices() || [];
    for (var i = 0; i < vs.length; i++) {
      var lg = (vs[i].lang || '').toLowerCase();
      if (lg.indexOf('en') === 0) { enVoice = vs[i]; break; }
    }
  } catch (e) { return null; }
  return enVoice;
}
function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    var ss = window.speechSynthesis;
    ss.cancel();
    var u = new SpeechSynthesisUtterance(String(text));
    var v = pickEnVoice();
    if (v) u.voice = v;
    u.lang = 'en-US';
    u.rate = 0.92; u.pitch = 1.05;
    ss.speak(u);
  } catch (e) { /* silent by design */ }
}

/* ==========================================================================
   4. Patch stylesheet (injected once; English-only labels by construction —
   applyLang() only rewrites [data-i18n] game elements, never these).
   All tap targets >= 44px; overlays are viewport-safe down to 360px wide.
   ========================================================================== */
(function injectCss() {
  var css = [
    '.wc-overlay{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(8,18,38,.74);padding:10px;box-sizing:border-box}',
    '.wc-card{background:#fffdf4;border:4px solid #2e7d32;border-radius:18px;box-shadow:0 10px 40px rgba(0,0,0,.5);width:520px;max-width:94vw;max-height:92vh;overflow-y:auto;padding:16px 16px 20px;box-sizing:border-box;text-align:center;font-family:inherit;color:#123}',
    '.wc-head{position:relative;margin-bottom:8px}',
    '.wc-title{font-size:24px;font-weight:800;color:#1b5e20}',
    '.wc-stage{font-size:16px;color:#37474f;margin-top:2px}',
    '.wc-dots{margin-top:6px}',
    '.wc-dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:#cfd8dc;margin:0 4px}',
    '.wc-dot.done{background:#66bb6a}',
    '.wc-dot.now{background:#ffa000;box-shadow:0 0 0 3px #ffe0b2}',
    '.wc-x{position:absolute;top:0;right:0;border:2px solid #b0bec5;background:#fff;border-radius:10px;padding:6px 10px;font-size:14px;cursor:pointer;min-height:44px}',
    '.wc-body{font-size:17px}',
    '.wc-help{margin:8px 4px 12px;color:#37474f}',
    '.wc-bigword{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:10px 0 14px;min-height:64px;align-items:center}',
    '.wc-big-letter{display:inline-flex;align-items:center;justify-content:center;min-width:48px;min-height:56px;padding:4px 8px;font-size:34px;font-weight:800;border-radius:12px;background:#eceff1;color:#b0bec5;border:3px solid #cfd8dc;transition:background .2s,transform .2s}',
    '.wc-big-letter.lit{background:#fff9c4;color:#1a237e;border-color:#ffb300;transform:scale(1.08)}',
    '.wc-big-letter.static{background:#e8f5e9;color:#1b5e20;border-color:#a5d6a7}',
    '.wc-btnrow{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:12px}',
    '.wc-btn{min-height:48px;padding:10px 18px;font-size:17px;font-weight:700;border-radius:12px;border:3px solid #2e7d32;background:#fff;color:#1b5e20;cursor:pointer}',
    '.wc-btn.primary{background:#2e7d32;color:#fff}',
    '.wc-btn.hint{border-color:#ef6c00;color:#e65100}',
    '.wc-btn:active{transform:scale(.96)}',
    '.wc-tray{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin:12px 0}',
    '.wc-tile{min-width:52px;min-height:52px;padding:8px 10px;font-size:30px;font-weight:800;border-radius:12px;border:3px solid #5c6bc0;background:#e8eaf6;color:#1a237e;cursor:pointer}',
    '.wc-tile.used{opacity:.25;cursor:default}',
    '.wc-answer{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:10px 0}',
    '.wc-slot{display:inline-flex;align-items:center;justify-content:center;min-width:48px;min-height:56px;font-size:32px;font-weight:800;border-radius:12px;background:#fafafa;border:3px dashed #90a4ae;color:#78909c}',
    '.wc-slot.ok{background:#e8f5e9;border:3px solid #66bb6a;color:#1b5e20}',
    '.wc-gap{min-width:48px;min-height:56px;font-size:32px;font-weight:800;border-radius:12px;border:3px solid #ef6c00;background:#fff3e0;color:#e65100;cursor:pointer}',
    '.wc-gap.sel{box-shadow:0 0 0 4px #ffe0b2}',
    '.wc-gap.ok{background:#e8f5e9;border-color:#66bb6a;color:#1b5e20;cursor:default}',
    '.wc-kb{margin:12px 0 4px}',
    '.wc-kbrow{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-bottom:8px}',
    '.wc-key{min-width:44px;min-height:54px;padding:6px 4px;font-size:22px;font-weight:700;border-radius:10px;border:2px solid #78909c;background:#eceff1;color:#263238;cursor:pointer}',
    '.wc-msg{margin:10px 4px;font-size:16px;min-height:22px}',
    '.wc-msg.ok{color:#1b5e20;font-weight:700}',
    '.wc-msg.err{color:#c62828;font-weight:700}',
    '.wc-file{margin:8px 0;font-size:15px;max-width:100%}',
    '.wc-wb-btn{position:fixed;top:118px;right:10px;z-index:150;min-height:44px;padding:8px 12px;font-size:15px;font-weight:700;border-radius:12px;border:3px solid #1565c0;background:#e3f2fd;color:#0d47a1;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.35)}',
    '.wc-wb-panel{position:fixed;top:170px;right:10px;z-index:150;width:252px;max-width:72vw;max-height:60vh;overflow-y:auto;background:#fffdf4;border:3px solid #1565c0;border-radius:14px;padding:12px;box-sizing:border-box;box-shadow:0 6px 24px rgba(0,0,0,.4);text-align:center;color:#123}',
    '.wc-wb-title{font-size:19px;font-weight:800;color:#0d47a1}',
    '.wc-wb-sub{font-size:14px;color:#37474f;margin:4px 0}',
    '.wc-wb-list{margin:8px 0;max-height:30vh;overflow-y:auto}',
    '.wc-wb-row{display:flex;justify-content:space-between;font-size:15px;padding:3px 6px;border-bottom:1px solid #e0e0e0}',
    '.wc-wb-row.mastered{background:#e8f5e9}',
    '.wc-confetti{position:fixed;top:-24px;width:11px;height:15px;z-index:300;pointer-events:none;animation-name:wc-fall;animation-timing-function:linear;animation-fill-mode:forwards}',
    '@keyframes wc-fall{to{transform:translateY(112vh) rotate(680deg)}}',
    '@keyframes wc-wiggle{0%,100%{transform:translateX(0)}25%{transform:translateX(-7px)}50%{transform:translateX(7px)}75%{transform:translateX(-4px)}}',
    '.wc-wiggle{animation:wc-wiggle .32s ease 2}',
    '@keyframes wc-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}',
    '.wc-shake{animation:wc-shake .25s ease 2}',
    '.wc-diploma{font-size:64px;margin:6px 0}',
    '.wc-stars-big{font-size:26px;color:#f9a825;font-weight:800}'
  ].join('\n');
  var st = document.createElement('style');
  st.type = 'text/css';
  st.appendChild(document.createTextNode(css));
  document.head.appendChild(st);
})();

/* ==========================================================================
   5. Small DOM helpers
   ========================================================================== */
function el(tag, cls, html) {
  var d = document.createElement(tag || 'div');
  if (cls) d.className = cls;
  if (html !== undefined && html !== null) d.innerHTML = html;
  return d;
}
function replayAnim(node, cls) {
  if (!node) return;
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}
function wiggle(node) { replayAnim(node, 'wc-wiggle'); } // gentle: wrong tile/option
function shake(node) { replayAnim(node, 'wc-shake'); }   // gentle: wrong keystroke

/* ==========================================================================
   6. Session state
   ========================================================================== */
var wcOn = false, hooked = false, wasHe = false;
/* Level 2 (final exam) unlock: the sorted word list that earned the Level 1
   diploma this page visit. Loading the same list again keeps it unlocked;
   a new list re-locks until it is mastered. The Shift+click parent shortcut
   sets wantLevel2 and bypasses the lock (explicit adult gesture). */
var level2UnlockKey = null, wantLevel2 = false;
function levelListKey(words) { return words.slice().sort().join('|'); }
/* Schools (v1.1.1): Word Cure Level 1 plays in the Noam school, Level 2 in
   the Yavne school — the base game's own school buildings (base levels 4/5).
   Short English display names for patch UI (the mode is English-only; the
   3D building signs keep the game's own full names). */
function wcSchool(wcLevel) { return (wcLevel === 2) ? 'Yavne School' : 'Noam School'; }
function wcBaseLevel(wcLevel) { return (wcLevel === 2) ? 5 : 4; } // Noam=4, Yavne=5
var WC = null;              // active session (null when not playing)
var bestSessionStars = 0;   // best star total, page lifetime (like Sukkot's best-five)
var wcSavedDisplay = null;  // original display values of UI hidden in-mode

function active() { return wcOn && WC && !WC.over; }

/* ==========================================================================
   7. Title-screen entry: "📚 Word Cure" button under #btnStart, then the
   word-list loading panel (file upload or the built-in 24-word list).
   ========================================================================== */
var startBtn = document.getElementById('btnStart');
if (!startBtn) return;
var btn = document.createElement('button');
btn.className = 'btn gold';
btn.id = 'btnWordCure';
btn.textContent = '📚 Word Cure';
btn.style.marginTop = '10px';
startBtn.parentNode.insertBefore(btn, startBtn.nextSibling); // directly under Start
var origRetry = document.getElementById('btnRetry').onclick; // saved for quit-to-title restore
/* Level 2 parent shortcut (desktop only): while Shift is held, the button
   reads "📚 Word Cure 2" and clicking it starts the Level 2 exam directly
   (bypassing the mastery unlock - it is an explicit adult gesture). Gated on
   a fine pointer so touch screens never see it. The label is cosmetic; the
   click handler reads event.shiftKey, so a missed keyup can never strand the
   game in the wrong level. */
var finePointer = !!(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
var shiftHeld = false;
function paintWcBtn() {
  btn.textContent = (finePointer && shiftHeld) ? '📚 Word Cure 2' : '📚 Word Cure';
}
if (finePointer) {
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Shift' && !shiftHeld) { shiftHeld = true; paintWcBtn(); }
  });
  window.addEventListener('keyup', function (e) {
    if (e.key === 'Shift') { shiftHeld = false; paintWcBtn(); }
  });
  window.addEventListener('blur', function () { shiftHeld = false; paintWcBtn(); });
}
btn.onclick = function (e) { SZ.audioInit(); SZ.SFX.click(); openLoadPanel(!!(e && e.shiftKey)); };

var overlayEl = null, overlayCard = null, overlayHead = null, overlayBody = null;
function buildOverlay() {
  removeOverlay();
  overlayEl = el('div', 'wc-overlay');
  overlayCard = el('div', 'wc-card');
  overlayHead = el('div', 'wc-head');
  overlayBody = el('div', 'wc-body');
  overlayCard.appendChild(overlayHead);
  overlayCard.appendChild(overlayBody);
  overlayEl.appendChild(overlayCard);
  document.body.appendChild(overlayEl);
}
function removeOverlay() {
  if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
  overlayEl = overlayCard = overlayHead = overlayBody = null;
}
function showMsg(msg, ok, t) {
  msg.className = 'wc-msg ' + (ok ? 'ok' : 'err');
  msg.textContent = t;
}

function openLoadPanel(shift2) {
  wantLevel2 = !!shift2; // Shift+click on the title button: preselect the exam
  buildOverlay();
  overlayHead.appendChild(el('div', 'wc-title', '📚 Word Cure'));
  overlayBody.appendChild(el('p', 'wc-help',
    'The zombies caught <b>scrambled words</b>! Load a word list and become their <b>Word Doctor</b>.'));
  overlayBody.appendChild(el('p', 'wc-help',
    'Choose a <b>.txt</b> file — one word per line, 2–12 English letters:'));
  var file = document.createElement('input');
  file.type = 'file'; file.accept = '.txt'; file.className = 'wc-file';
  overlayBody.appendChild(file);
  var msg = el('div', 'wc-msg');
  overlayBody.appendChild(msg);
  var row = el('div', 'wc-btnrow');
  var builtin = el('button', 'wc-btn', '📖 Use the built-in list (24 words)');
  builtin.onclick = function () { SZ.SFX.click(); beginWith(parseWordList(BUILTIN_WORDS.join('\n')), msg); };
  var cancel = el('button', 'wc-btn', 'Cancel');
  cancel.onclick = function () { SZ.SFX.click(); removeOverlay(); };
  row.appendChild(builtin); row.appendChild(cancel);
  overlayBody.appendChild(row);
  file.onchange = function () {
    var f = file.files && file.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () { beginWith(parseWordList(String(rd.result)), msg); };
    rd.onerror = function () { showMsg(msg, false, 'Could not read that file — please try again.'); };
    rd.readAsText(f);
  };
}

function beginWith(words, msg) {
  if (!words.length) {
    showMsg(msg, false, 'Hmm, no valid words found. Use one word per line, 2–12 English letters (a–z).');
    return;
  }
  var n = words.length;
  showMsg(msg, true, n + ' word' + (n === 1 ? '' : 's') + ' loaded — ready, Doctor?');
  var row = overlayBody.querySelector('.wc-btnrow');
  if (!row || overlayBody.querySelector('.wc-start')) return;
  var unlocked = (levelListKey(words) === level2UnlockKey);
  var lvl = wantLevel2 ? 2 : 1;
  var start = null;
  function paintLvl() {
    b1.className = 'wc-btn' + (lvl === 1 ? ' primary' : '');
    b2.className = 'wc-btn' + (lvl === 2 ? ' primary' : '');
    if (start) start.textContent = lvl === 2 ? '🎧 Start the exam!' : '🩺 Start curing!';
  }
  var b1 = el('button', 'wc-btn' + (lvl === 1 ? ' primary' : ''), '🩺 Level 1 — Noam School');
  var b2 = el('button', 'wc-btn' + (lvl === 2 ? ' primary' : ''),
    (unlocked || wantLevel2) ? '🎧 Level 2 — Yavne School' : '🔒 Level 2 — Yavne School (finish Level 1 first)');
  b1.onclick = function () { SZ.SFX.click(); lvl = 1; paintLvl(); };
  b2.onclick = function () {
    SZ.SFX.click();
    if (unlocked || wantLevel2) { lvl = 2; paintLvl(); }
    else showMsg(msg, false, 'Cure every word with ★★★ in Level 1 to unlock the final exam!');
  };
  var pickRow = el('div', 'wc-btnrow');
  pickRow.appendChild(b1); pickRow.appendChild(b2);
  overlayBody.insertBefore(pickRow, row);
  start = el('button', 'wc-btn primary wc-start', lvl === 2 ? '🎧 Start the exam!' : '🩺 Start curing!');
  start.onclick = function () { SZ.audioInit(); SZ.SFX.click(); removeOverlay(); startWordCure(words, lvl); };
  row.appendChild(start);
}

/* ==========================================================================
   8. Mode lifecycle: start / stop / quit-to-title / retry.
   Level 1 = the four-stage learning mode; Level 2 = the final exam
   (no letters on the zombies, hear-and-spell only). Each level keeps its
   own stars per word: 'stars' for Level 1, 'stars2' for Level 2.
   ========================================================================== */
function startWordCure(words, level) {
  if (!words || !words.length) return;
  level = (level === 2) ? 2 : 1;
  removeOverlay();
  // English-only mode: spelling is English, so force the game to English.
  // (There is no language setter; the title button's own handler is the only
  // switch. Restored on exit if it was Hebrew on entry. Latched on a fresh
  // start only, so replay/retry keeps the original value.)
  if (!wcOn) {
    wasHe = (SZ.lang() !== 'en');
    if (wasHe) { var bl = document.getElementById('btnLang'); if (bl) bl.click(); }
  }
  SZ.showScreen(null);
  // v1.1.1: each Word Cure level plays in its own school — Level 1 in the
  // Noam school (base level 4), Level 2 in the Yavne school (base level 5).
  // Base banners are overridden below.
  SZ.startLevel(wcBaseLevel(level), false);
  installHooks();
  WC = {
    level: level, viewLevel: level, // viewLevel = which level's stars the Word Book shows
    words: words.map(function (w) { return { w: w, stars: 0, stars2: 0, attempts: 0 }; }),
    over: false, curing: null, sessionStars: 0, trickleT: 20
  };
  wcOn = true;
  hidePowerUi();
  buildWordBookButton();
  var p = SZ.player();
  for (var i = 0; i < 4; i++) spawnCarrierNear(p); // first patients, near the kid
  if (level === 2) {
    SZ.kit.banner('🎧 Final exam at ' + wcSchool(2) + '! Zombies show no letters — hear the word, spell it!', 4);
  } else {
    SZ.kit.banner('📚 Word Cure at ' + wcSchool(1) + '! Walk up to a zombie to cure it with words.', 4);
  }
  // the base game shows its "save the school" banner 4.8s after level start;
  // in Word Cure mode it must say this instead (fires just after, like Sukkot)
  setTimeout(function () {
    if (!active()) return;
    SZ.kit.banner(WC.level === 2
      ? '🎧 No letters to copy — listen carefully, then spell!'
      : '📚 No fighting — just spelling! Get close to a zombie.', 4);
  }, 4830);
  SZ.kit.toast('Tap the 📚 Word Book to see your words', 5);
}

/* Wrappers stay installed for the page's lifetime and delegate to the saved
   original whenever no Word Cure session is active — the normal game is then
   provably unaffected. */
function installHooks() {
  if (hooked) return;
  hooked = true;
  H._wcUpdateZombies = H.updateZombies; H.updateZombies = wordCureUpdateZombies;
  H._wcUsePower = H.usePower;           H.usePower = wordCureUsePower;
  H._wcUseFart = H.useFart;             H.useFart = wordCureUseFart;
  H._wcGameOver = H.gameOver;           H.gameOver = wordCureGameOver;
  H._wcUpdateDayNight = H.updateDayNight; H.updateDayNight = wordCureUpdateDayNight;
  H._wcVictory = H.victory;               H.victory = wordCureVictory;
  // leaving to the menu / restarting the level drops Word Cure quietly
  document.getElementById('btnQuit').addEventListener('click', exitWordCure);
  document.getElementById('btnRestartLevel').addEventListener('click', exitWordCure);
  // capture phase: runs before the game's own keydown handler, so Escape/KeyP
  // cannot resume the soft-paused world behind the open minigame overlay
  window.addEventListener('keydown', wordCureKeyDown, true);
}

/* Stage-4 physical keyboard (+ Escape swallow while the minigame is open). */
function wordCureKeyDown(e) {
  var c = WC && WC.curing;
  if (!c) return; // inactive: the game keeps the key
  if (e.code === 'KeyP' || e.code === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (c.stage === 4 && !c.done) {
    var k = e.key;
    if (k && k.length === 1 && /[a-zA-Z]/.test(k)) {
      e.preventDefault();
      typeLetter4(k.toLowerCase());
    }
  }
}

function exitWordCure() {
  if (WC && WC.curing) closeCure();
  WC = null;
  wcOn = false;
  var zombies = SZ.zombies();
  for (var i = 0; i < zombies.length; i++) removeBubble(zombies[i]);
  removeOverlay();
  removeWordBook();
  restorePowerUi();
  var rb = document.getElementById('btnRetry');
  if (rb) rb.onclick = origRetry;
  if (wasHe) { // back to the language we found
    var bl = document.getElementById('btnLang');
    if (bl) bl.click();
    wasHe = false;
  }
  // never leave the world frozen behind us
  if (SZ.G && SZ.G.state === 'paused') SZ.G.state = 'playing';
}

function quitToTitle() {
  exitWordCure();
  SZ.showScreen('titleScreen');
  if (SZ.G) SZ.G.state = 'title';
}

/* ==========================================================================
   9. Power guards. DESIGN CHOICE (per the integration guide §g): block +
   hide. The chokepoints are H.usePower (mouse click, touch #btnPower, and
   KeyF all route through it) and H.useFart (KeyX + touch #btnFart). Blocking
   here — rather than filtering inside damageZombie, which is not hookable —
   keeps base-game powers from curing word-carrying zombies for free (a
   single tiferet blast repents EVERY zombie in the level and would bypass the
   whole spelling minigame). Hiding #powerbar and the touch buttons is
   cosmetic on top of the real guard; both are restored on exit.
   ========================================================================== */
var wcHiddenIds = ['powerbar', 'btnPower', 'btnSwitch', 'btnFart', 'fartHud', 'btnPause', 'btnLang'];
function hidePowerUi() {
  if (wcSavedDisplay) return;
  wcSavedDisplay = {};
  for (var i = 0; i < wcHiddenIds.length; i++) {
    var n = document.getElementById(wcHiddenIds[i]);
    if (n) { wcSavedDisplay[wcHiddenIds[i]] = n.style.display; n.style.display = 'none'; }
  }
}
function restorePowerUi() {
  if (!wcSavedDisplay) return;
  for (var k in wcSavedDisplay) {
    var n = document.getElementById(k);
    if (n) n.style.display = wcSavedDisplay[k];
  }
  wcSavedDisplay = null;
}

function wordCureUsePower() {
  if (active()) { SZ.kit.toast('📚 No powers in Word Cure — use words!', 2); return; }
  H._wcUsePower();
}
function wordCureUseFart() {
  if (active()) { SZ.kit.toast('📚 No powers in Word Cure — use words!', 2); return; }
  H._wcUseFart();
}

/* Game over: show this visit's stars, retry restarts Word Cure fresh. */
function wordCureGameOver() {
  if (!active()) return H._wcGameOver();
  WC.over = true;
  if (WC.curing) closeCure();
  H._wcGameOver(); // sets state/screens first, like the Sukkot template
  var retryWords = WC.words.map(function (e) { return e.w; });
  document.getElementById('overTitle').textContent = '📚 Word Cure — Game over!';
  document.getElementById('overSub').innerHTML =
    '<div style="font-size:20px;margin:6px 0">You earned <b>★' + WC.sessionStars + '</b> this visit</div>' +
    '<div style="font-size:15px;opacity:0.9">Best stars (while the game is open): <b>★' + bestSessionStars + '</b></div>';
  var rb = document.getElementById('btnRetry');
  rb.textContent = '📚 Cure again';
  var retryLevel = WC.level;
  rb.onclick = function () { SZ.SFX.click(); startWordCure(retryWords, retryLevel); };
  removeWordBook(); // rebuilt on retry
}

/* Day/night + victory guards (v1.1.1). Word Cure plays on base levels 4/5
   (Noam/Yavne schools), whose night2 endings assume the campaign:
   - level 4's night2 end calls levelComplete(): mass-repents EVERY carrier
     (wiping the session's words) and opens the next-school portal;
   - level 5's cured giant fires HOOKS.victory(): the win screen over the exam.
   In Word Cure there is no campaign and no next school: the night2
   transition is defused into a fresh day at the same school, and victory is
   swallowed (curing the giant is just another exam cure). */
function wordCureUpdateDayNight(dt) {
  var G = SZ.G;
  if (active() && G && G.phase === 'night2') {
    var len = (SZ.CFG && SZ.CFG.nightLength) || 160;
    if (G.phaseT + dt >= len) {
      G.phase = 'day1'; G.phaseT = 0; // a fresh day at the same school
      return; // skip this tick's transition (sky resumes next tick)
    }
  }
  H._wcUpdateDayNight(dt);
  if (!active()) return;
  // the level-5 giant is just another word-carrier here: no boss bar
  var bb = document.getElementById('bossbar');
  if (bb && bb.style.display !== 'none') bb.style.display = 'none';
}
function wordCureVictory() {
  if (!active()) return H._wcVictory();
  // swallow the base-game win screen while a Word Cure session is active
}

/* ==========================================================================
   10. Word-carrying zombies + floating scrambled-word bubbles.
   Each zombie gets zb.wordCure = { word, scrambled, bubble, cured, coolT }.
   The bubble is a THREE.Sprite (always faces the camera) drawn on a canvas:
   the scrambled letters as separate tiles. Sprite chosen over a DOM overlay
   so no camera projection is needed.
   ========================================================================== */
function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function makeBubbleSprite(scrambled) {
  var n = scrambled.length;
  var tile = 56, pad = 26, cw = pad * 2 + n * tile, chh = 148;
  var cv = document.createElement('canvas');
  cv.width = cw; cv.height = chh;
  var g = cv.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.96)';
  roundRectPath(g, 4, 4, cw - 8, chh - 8, 32); g.fill();
  g.lineWidth = 7; g.strokeStyle = '#1565c0'; g.stroke();
  g.fillStyle = '#1565c0';
  g.font = 'bold 30px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('📚', cw / 2, 26);
  var cols = ['#e3f2fd', '#fff3e0', '#e8f5e9', '#fce4ec'];
  for (var i = 0; i < n; i++) {
    var x = pad + i * tile;
    g.fillStyle = cols[i % cols.length];
    roundRectPath(g, x + 4, 52, tile - 8, tile - 8, 12); g.fill();
    g.lineWidth = 3; g.strokeStyle = '#5c6bc0'; g.stroke();
    g.fillStyle = '#1a237e';
    g.font = 'bold 38px Arial';
    g.fillText(scrambled[i], x + tile / 2, 52 + (tile - 8) / 2 + 2);
  }
  var tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  var baseW = 4.4;
  sp.scale.set(baseW, baseW * chh / cw, 1);
  return sp;
}

function attachBubble(zb) {
  removeBubble(zb);
  // Level 2 (final exam): the zombie carries NO letters — a "?" bubble, so
  // the player can still spot word-carriers but cannot preview the word.
  var sp = (WC && WC.level === 2) ? makeExamBubble() : makeBubbleSprite(zb.wordCure.scrambled);
  if (zb.giant) sp.scale.multiplyScalar(1.35);
  zb.wordCure.bubble = sp;
  kit.scene().add(sp);
  positionBubble(zb);
}

/* Level 2 exam bubble: one "?" tile — a carrier marker with zero letters. */
function makeExamBubble() {
  var tile = 72, pad = 34, cw = pad * 2 + tile, chh = 148;
  var cv = document.createElement('canvas');
  cv.width = cw; cv.height = chh;
  var g = cv.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.96)';
  roundRectPath(g, 4, 4, cw - 8, chh - 8, 32); g.fill();
  g.lineWidth = 7; g.strokeStyle = '#7b1fa2'; g.stroke();
  g.fillStyle = '#7b1fa2';
  g.font = 'bold 30px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('🎧', cw / 2, 26);
  g.fillStyle = '#ede7f6';
  roundRectPath(g, pad + 4, 52, tile - 8, tile - 8, 12); g.fill();
  g.lineWidth = 3; g.strokeStyle = '#7b1fa2'; g.stroke();
  g.fillStyle = '#4a148c';
  g.font = 'bold 44px Arial';
  g.fillText('?', cw / 2, 52 + (tile - 8) / 2 + 2);
  var tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  var baseW = 3.2;
  sp.scale.set(baseW, baseW * chh / cw, 1);
  return sp;
}
function positionBubble(zb) {
  var sp = zb.wordCure && zb.wordCure.bubble;
  if (!sp) return;
  var s = zb.rig.s;
  sp.position.set(zb.pos.x, zb.pos.y + (zb.giant ? 5.8 : 3.4) * s, zb.pos.z);
}
function removeBubble(zb) {
  var wc = zb.wordCure;
  if (wc && wc.bubble) {
    kit.scene().remove(wc.bubble);
    if (wc.bubble.material.map) wc.bubble.material.map.dispose();
    wc.bubble.material.dispose();
    wc.bubble = null;
  }
}

function carriedWords() {
  var out = [], zs = SZ.zombies();
  for (var i = 0; i < zs.length; i++) {
    var z = zs[i];
    if (!z.gone && !z.repented && z.wordCure && z.wordCure.word) out.push(z.wordCure.word);
  }
  return out;
}

function assignWordTo(zb) {
  if (!WC) return false;
  var idx = pickWordIndex(WC.words, carriedWords(), WC.level === 2 ? 'stars2' : 'stars');
  if (idx < 0) return false;
  var e = WC.words[idx];
  e.attempts++;
  zb.wordCure = { word: e.w, scrambled: scrambleLetters(e.w), bubble: null, cured: false, coolT: 0,
    exam: (WC.level === 2) }; // exam carriers show the "?" bubble, no letters
  attachBubble(zb);
  return true;
}

function spawnCarrierNear(player) {
  if (!player || !active()) return;
  for (var k = 0; k < 10; k++) {
    var a = Math.random() * Math.PI * 2, r = 9 + Math.random() * 7;
    var x = kit.clamp(player.pos.x + Math.cos(a) * r, 4, W - 4);
    var z = kit.clamp(player.pos.z + Math.sin(a) * r, 4, W - 4);
    if (kit.isBlocked(x, z, 1)) continue;
    assignWordTo(SZ.spawnZombie(x, z, false));
    return;
  }
}

/* ==========================================================================
   11. The per-frame zombie update for Word Cure mode.
   - Word carriers are DOCILE: they shamble toward the kid because they want
     to be cured, and never attack (kid-friendly mode; also keeps the
     minigame readable). The base "sit and learn" rabbi behavior is
     intentionally not applied — same rationale as the Sukkot patch.
   - Proximity (on foot or in the van) opens the cure minigame and
     soft-pauses the world.
   - Cured neighbors parade behind the van (manual steering each frame).
   ========================================================================== */
function wordCureUpdateZombies(dt) {
  if (!active()) return H._wcUpdateZombies(dt);
  var zombies = SZ.zombies(), player = SZ.player();
  if (!player) return;
  var van = SZ.van();
  // daytime trickle: the base spawner only works at night, so keep a few
  // carriers around while the sun is up
  WC.trickleT -= dt;
  if (WC.trickleT <= 0) {
    WC.trickleT = 18;
    var carriers = 0, ci;
    for (ci = 0; ci < zombies.length; ci++) {
      var c0 = zombies[ci];
      if (!c0.gone && !c0.repented && c0.wordCure && c0.wordCure.word) carriers++;
    }
    if (carriers < 3 && !WC.curing) spawnCarrierNear(player);
  }
  var fIdx = 0;
  for (var i = 0; i < zombies.length; i++) {
    var zb = zombies[i];
    if (zb.gone) { removeBubble(zb); continue; }
    if (!zb.wordCure) {
      if (!zb.repented && !assignWordTo(zb))
        zb.wordCure = { word: null, cured: false, bubble: null, coolT: 0 };
      else if (zb.repented)
        zb.wordCure = { word: null, cured: false, bubble: null, coolT: 0 };
    }
    var s = zb.rig.s;
    if (zb.repented) {
      if (zb.wordCure.cured) paradeStep(zb, fIdx++, van, player, dt);
      else davenCopy(zb, dt); // defensive: repented by some path we did not cure
      continue;
    }
    var wc = zb.wordCure;
    if (wc.coolT > 0) wc.coolT -= dt;
    var dancing = SZ.vanMusicDancing(zb); // the van's song still delights them
    var gx = dancing ? van.pos.x : player.pos.x;
    var gz = dancing ? van.pos.z : player.pos.z;
    var dx = gx - zb.pos.x, dz = gz - zb.pos.z;
    var gd = Math.hypot(dx, dz);
    if (gd > 2.6 && gd > 0.01) {
      var want = Math.atan2(dx, dz);
      zb.yaw += kit.angDiff(want, zb.yaw) * Math.min(1, dt * 6);
      var sp = zb.speed * 0.5; // gentle pace: they come to be cured, not to chase
      zb.pos.x += Math.sin(zb.yaw) * sp * dt;
      zb.pos.z += Math.cos(zb.yaw) * sp * dt;
    }
    zb.pos.x = kit.clamp(zb.pos.x, 2, W - 2); zb.pos.z = kit.clamp(zb.pos.z, 2, W - 2);
    zb.pos.y = kit.groundHeight(zb.pos.x, zb.pos.z);
    for (var j = 0; j < zombies.length; j++) { // separation
      if (j === i) continue;
      var o = zombies[j]; if (o.gone) continue;
      var ox = zb.pos.x - o.pos.x, oz = zb.pos.z - o.pos.z;
      var od = Math.hypot(ox, oz);
      if (od > 0.01 && od < 1.1) { zb.pos.x += (ox / od) * dt * 2; zb.pos.z += (oz / od) * dt * 2; }
    }
    zb.walkT += dt * 7; // walk animation
    var sw = Math.sin(zb.walkT) * 0.5;
    zb.rig.legL.rotation.x = sw; zb.rig.legR.rotation.x = -sw;
    zb.rig.armL.rotation.x = kit.lerp(zb.rig.armL.rotation.x, -1.2 + sw * 0.3, dt * 8);
    zb.rig.armR.rotation.x = kit.lerp(zb.rig.armR.rotation.x, -1.2 - sw * 0.3, dt * 8);
    zb.rig.group.position.copy(zb.pos);
    zb.rig.group.rotation.y = zb.yaw;
    zb.rig.group.position.y = zb.pos.y + Math.abs(Math.sin(zb.walkT)) * 0.08 * s;
    if (zb.flashT > 0) zb.flashT -= dt;
    if (wc.bubble) positionBubble(zb);
    // proximity (on foot or in the van) opens the cure minigame
    if (!WC.curing && wc.word && wc.coolT <= 0) {
      var pd = kit.dist2D(zb.pos.x, zb.pos.z, player.pos.x, player.pos.z);
      if (pd < (SZ.inVan() ? 7 : 5.5)) openCure(zb);
    }
  }
}

/* The parade: cured neighbors follow the van (or the kid on foot) in a tidy
   formation. Manual steering each frame — not vanMusicDancing — so the
   formation holds whether or not the van's song is playing. */
function paradeStep(zb, idx, van, player, dt) {
  var s = zb.rig.s;
  var lx = player.pos.x, lz = player.pos.z, lyaw = player.yaw;
  if (van) { lx = van.pos.x; lz = van.pos.z; lyaw = van.yaw; }
  var back = 3.5 + idx * 2.0;
  var side = (idx % 2 === 0 ? 1 : -1) * (1.1 + Math.floor(idx / 2) * 0.5);
  var fx = Math.sin(lyaw), fz = Math.cos(lyaw);
  var tx = lx - fx * back + fz * side;
  var tz = lz - fz * back - fx * side;
  var dx = tx - zb.pos.x, dz = tz - zb.pos.z;
  var d = Math.hypot(dx, dz);
  if (d > 1.4) {
    var want = Math.atan2(dx, dz);
    zb.yaw += kit.angDiff(want, zb.yaw) * Math.min(1, dt * 6);
    var sp = Math.min(zb.speed * 1.1, d * 2);
    zb.pos.x += Math.sin(zb.yaw) * sp * dt;
    zb.pos.z += Math.cos(zb.yaw) * sp * dt;
    zb.walkT += dt * 8;
    var sw = Math.sin(zb.walkT) * 0.45;
    zb.rig.legL.rotation.x = sw; zb.rig.legR.rotation.x = -sw;
    zb.rig.armL.rotation.x = -0.6 + sw * 0.3; zb.rig.armR.rotation.x = -0.6 - sw * 0.3; // happy march
  } else {
    zb.davenT += dt * 3; // arrived: gentle happy bounce in formation
    zb.rig.armL.rotation.x = -0.6; zb.rig.armR.rotation.x = -0.6;
    zb.rig.group.position.set(zb.pos.x, zb.pos.y + Math.abs(Math.sin(zb.davenT)) * 0.12 * s, zb.pos.z);
    zb.rig.group.rotation.y = zb.yaw;
    return;
  }
  zb.pos.x = kit.clamp(zb.pos.x, 2, W - 2); zb.pos.z = kit.clamp(zb.pos.z, 2, W - 2);
  zb.pos.y = kit.groundHeight(zb.pos.x, zb.pos.z);
  zb.rig.group.position.copy(zb.pos);
  zb.rig.group.rotation.y = zb.yaw;
  zb.rig.group.position.y = zb.pos.y + Math.abs(Math.sin(zb.walkT)) * 0.08 * s;
}

/* Base-game davening (Amidah bow), copied for repented zombies we did not cure. */
function davenCopy(zb, dt) {
  zb.davenT += dt * 2.2;
  var bow = Math.max(0, Math.sin(zb.davenT));
  zb.rig.bodyG.rotation.x = bow * 0.55;
  zb.rig.group.position.copy(zb.pos);
  zb.rig.armL.rotation.x = 0.15; zb.rig.armR.rotation.x = 0.15;
}

/* ==========================================================================
   12. The cure minigame: 4 gentle stages, no timers, no punishment.
   Opening soft-pauses the world: frame() renders every frame but only calls
   step() while G.state === 'playing' (v20/game.js), so zombies freeze behind
   the modal while the DOM minigame stays fully interactive.
   ========================================================================== */
function setStageHead(word, stage, title) {
  overlayHead.innerHTML = '';
  /* Level 2 (final exam): a single hear-and-spell stage - the word never
     appears, there are no stage dots, just the exam framing. */
  if (WC && WC.level === 2) {
    overlayHead.appendChild(el('div', 'wc-title', '🎧 Final exam'));
    overlayHead.appendChild(el('div', 'wc-stage', 'Hear the word… then spell it!'));
    var xe = el('button', 'wc-x', '✕ Leave');
    xe.onclick = function () { SZ.SFX.click(); leaveCure(); };
    overlayHead.appendChild(xe);
    return;
  }
  var dots = '';
  for (var i = 1; i <= 4; i++)
    dots += '<span class="wc-dot' + (i < stage ? ' done' : (i === stage ? ' now' : '')) + '"></span>';
  /* Scaffold fading (v1.0.1): the correct spelling is shown ONLY in stage 1
     ("See & Hear", the teaching stage). In stages 2-4 the header stays
     neutral so the player must RECALL the spelling instead of copying it.
     A stuck player can still use the "Hear the word" button, replay the
     cure, or press the Hint button (each hint counts against the stars). */
  var headHtml = (stage === 1)
    ? '📚 Cure: <b>' + word + '</b>'
    : '📚 Cure the word!';
  overlayHead.appendChild(el('div', 'wc-title', headHtml));
  overlayHead.appendChild(el('div', 'wc-stage', 'Stage ' + stage + ' of 4: ' + title));
  overlayHead.appendChild(el('div', 'wc-dots', dots));
  var x = el('button', 'wc-x', '✕ Leave');
  x.onclick = function () { SZ.SFX.click(); leaveCure(); };
  overlayHead.appendChild(x);
}

function openCure(zb) {
  if (!active() || WC.curing || !zb.wordCure || !zb.wordCure.word || zb.repented || zb.gone) return;
  // pointer lock would hide the cursor over the modal on desktop — release it
  if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (e) {} }
  WC.curing = {
    zb: zb, word: zb.wordCure.word, scrambled: zb.wordCure.scrambled,
    stage: (WC.level === 2 ? 4 : 1), mistakes: 0, hints: 0, timers: [], done: false,
    idx4: 0, slots4: null
  };
  if (zb.wordCure.bubble) zb.wordCure.bubble.visible = false;
  if (SZ.G) SZ.G.state = 'paused'; // soft-pause (see note above)
  SZ.showScreen(null);             // keeps the HUD visible while paused
  buildOverlay();
  // Level 2 (final exam): skip straight to the hear-and-spell stage.
  if (WC.level === 2) renderStage4(); else renderStage1();
  SZ.SFX.click();
}

function closeCure() {
  var c = WC && WC.curing;
  if (c) {
    for (var i = 0; i < c.timers.length; i++) clearTimeout(c.timers[i]);
    c.timers.length = 0;
    if (c.zb && c.zb.wordCure && c.zb.wordCure.bubble) c.zb.wordCure.bubble.visible = true;
  }
  if (WC) WC.curing = null;
  removeOverlay();
  if (active() && SZ.G && SZ.G.state === 'paused') SZ.G.state = 'playing';
}

/* Leaving without finishing: the zombie keeps its word (it can be cured
   later), gets a gentle push away plus a cooldown so the minigame does not
   instantly reopen. */
function leaveCure() {
  var c = WC && WC.curing;
  if (c && c.zb && !c.zb.gone) {
    var p = SZ.player();
    if (p) {
      var dx = c.zb.pos.x - p.pos.x, dz = c.zb.pos.z - p.pos.z;
      var dd = Math.hypot(dx, dz) || 1;
      c.zb.pos.x = kit.clamp(c.zb.pos.x + dx / dd * 6, 2, W - 2);
      c.zb.pos.z = kit.clamp(c.zb.pos.z + dz / dd * 6, 2, W - 2);
    }
    if (c.zb.wordCure) c.zb.wordCure.coolT = 4;
  }
  SZ.kit.toast('No rush — the word will wait for you. 📚', 3);
  closeCure();
}

/* ---- Stage 1: See & Hear. The word spelled correctly; letters light up one
   by one while each letter NAME is spoken, then the whole word. Tapping
   "Listen" first keeps speechSynthesis inside a user gesture (autoplay
   policy). No mistakes or hints are possible here. ---- */
function renderStage1() {
  var c = WC.curing; if (!c || !overlayBody) return;
  setStageHead(c.word, 1, 'See & Hear');
  overlayBody.innerHTML = '';
  overlayBody.appendChild(el('p', 'wc-help', 'Watch and listen, Doctor. Tap <b>🔊 Listen</b> to hear the word.'));
  var row = el('div', 'wc-bigword');
  var spans = [];
  for (var i = 0; i < c.word.length; i++) {
    var s = el('span', 'wc-big-letter', c.word[i]);
    row.appendChild(s); spans.push(s);
  }
  overlayBody.appendChild(row);
  var btnRow = el('div', 'wc-btnrow');
  var listen = el('button', 'wc-btn primary', '🔊 Listen');
  var again = el('button', 'wc-btn', '🔊 Hear it again');
  var next = el('button', 'wc-btn primary', 'Next →');
  again.style.display = 'none'; next.style.display = 'none';
  btnRow.appendChild(listen); btnRow.appendChild(again); btnRow.appendChild(next);
  overlayBody.appendChild(btnRow);
  function live() { return WC && WC.curing === c && c.stage === 1 && !c.done; }
  function play() {
    if (!live()) return;
    listen.style.display = 'none'; again.style.display = 'none'; next.style.display = 'none';
    for (var k = 0; k < spans.length; k++) spans[k].classList.remove('lit');
    var i = 0;
    (function stepFn() {
      if (!live()) return;
      if (i < spans.length) {
        spans[i].classList.add('lit');
        speak(LETTER_NAMES[c.word[i]]);
        i++;
        c.timers.push(setTimeout(stepFn, 520));
      } else {
        c.timers.push(setTimeout(function () {
          if (!live()) return;
          speak(c.word);
          again.style.display = ''; next.style.display = '';
        }, 650));
      }
    })();
  }
  listen.onclick = function () { SZ.audioInit(); SZ.SFX.click(); play(); };
  again.onclick = function () { SZ.SFX.click(); play(); };
  next.onclick = function () { SZ.SFX.click(); c.stage = 2; renderStage2(); };
}

/* ---- Stage 2: Unscramble. Big tappable tiles; wrong tiles wiggle gently,
   never punished. ---- */
function renderStage2() {
  var c = WC.curing; if (!c || !overlayBody) return;
  setStageHead(c.word, 2, 'Unscramble');
  overlayBody.innerHTML = '';
  overlayBody.appendChild(el('p', 'wc-help', 'Tap the tiles in the right order to spell the word.'));
  var ans = el('div', 'wc-answer');
  var slots = [];
  for (var i = 0; i < c.word.length; i++) { var sl = el('span', 'wc-slot', '·'); ans.appendChild(sl); slots.push(sl); }
  overlayBody.appendChild(ans);
  var tray = el('div', 'wc-tray');
  var tiles = [];
  var scr = c.scrambled || scrambleLetters(c.word);
  for (var t = 0; t < scr.length; t++) {
    (function (ch) {
      var b = el('button', 'wc-tile', ch);
      b.onclick = function () { tapTile(b, ch); };
      tray.appendChild(b); tiles.push(b);
    })(scr[t]);
  }
  overlayBody.appendChild(tray);
  var placed = 0;
  function live() { return WC && WC.curing === c && c.stage === 2 && !c.done; }
  function tapTile(b, ch) {
    if (!live() || b.disabled) return;
    if (ch === c.word[placed]) {
      b.disabled = true; b.classList.add('used');
      slots[placed].textContent = ch; slots[placed].classList.add('ok');
      placed++; SZ.SFX.click();
      if (placed === c.word.length) {
        c.timers.push(setTimeout(function () {
          if (!live()) return;
          c.stage = 3; renderStage3();
        }, 650));
      }
    } else { wiggle(b); c.mistakes++; }
  }
  var btnRow = el('div', 'wc-btnrow');
  var hear = el('button', 'wc-btn', '🔊 Hear the word');
  hear.onclick = function () { SZ.SFX.click(); speak(c.word); };
  var hint = el('button', 'wc-btn hint', '💡 Hint');
  hint.onclick = function () {
    if (!live() || placed >= c.word.length) return;
    SZ.SFX.click(); c.hints++;
    var need = c.word[placed];
    for (var k = 0; k < tiles.length; k++) {
      if (!tiles[k].disabled && tiles[k].textContent === need) { tapTile(tiles[k], need); break; }
    }
  };
  btnRow.appendChild(hear); btnRow.appendChild(hint);
  overlayBody.appendChild(btnRow);
}

/* ---- Stage 3: Fill the Gaps. 1-3 missing letters by word length; option
   buttons hold the correct letters plus decoys. ---- */
function renderStage3() {
  var c = WC.curing; if (!c || !overlayBody) return;
  setStageHead(c.word, 3, 'Fill the Gaps');
  overlayBody.innerHTML = '';
  overlayBody.appendChild(el('p', 'wc-help', 'Some letters are missing. Tap a gap, then tap the right letter.'));
  var gaps = makeGapPlan(c.word);
  var filled = {};
  var selected = gaps[0];
  var row = el('div', 'wc-bigword');
  var gapBtns = {};
  for (var i = 0; i < c.word.length; i++) {
    (function (idx) {
      if (gaps.indexOf(idx) === -1) {
        row.appendChild(el('span', 'wc-big-letter static', c.word[idx]));
      } else {
        var g = el('button', 'wc-gap', '_');
        g.onclick = function () { if (!g.disabled) { selected = idx; refreshSel(); SZ.SFX.click(); } };
        row.appendChild(g); gapBtns[idx] = g;
      }
    })(i);
  }
  function refreshSel() {
    for (var k in gapBtns) gapBtns[k].classList.toggle('sel', Number(k) === selected);
  }
  refreshSel();
  overlayBody.appendChild(row);
  var tray = el('div', 'wc-tray');
  var correct = gaps.map(function (gp) { return c.word[gp]; });
  var opts = shuffleInPlace(correct.concat(pickDecoys(correct, 4)));
  var optBtns = [];
  for (var o = 0; o < opts.length; o++) {
    (function (ch) {
      var b = el('button', 'wc-tile', ch);
      b.onclick = function () { tapOpt(b, ch); };
      tray.appendChild(b); optBtns.push(b);
    })(opts[o]);
  }
  overlayBody.appendChild(tray);
  function live() { return WC && WC.curing === c && c.stage === 3 && !c.done; }
  function tapOpt(b, ch) {
    if (!live() || b.disabled || selected === null || selected === undefined) return;
    if (ch === c.word[selected]) {
      b.disabled = true; b.classList.add('used');
      filled[selected] = ch;
      var gb = gapBtns[selected];
      gb.textContent = ch; gb.classList.add('ok'); gb.disabled = true;
      SZ.SFX.click();
      var rest = gaps.filter(function (gp) { return !(gp in filled); });
      if (rest.length === 0) {
        c.timers.push(setTimeout(function () {
          if (!live()) return;
          c.stage = 4; renderStage4();
        }, 650));
      } else { selected = rest[0]; refreshSel(); }
    } else { wiggle(b); wiggle(gapBtns[selected]); c.mistakes++; }
  }
  var btnRow = el('div', 'wc-btnrow');
  var hear = el('button', 'wc-btn', '🔊 Hear the word');
  hear.onclick = function () { SZ.SFX.click(); speak(c.word); };
  var hint = el('button', 'wc-btn hint', '💡 Hint');
  hint.onclick = function () {
    if (!live()) return;
    var rest = gaps.filter(function (gp) { return !(gp in filled); });
    if (!rest.length) return;
    SZ.SFX.click(); c.hints++;
    var gp = rest[0], need = c.word[gp];
    for (var k = 0; k < optBtns.length; k++) {
      if (!optBtns[k].disabled && optBtns[k].textContent === need) {
        selected = gp; refreshSel(); tapOpt(optBtns[k], need); break;
      }
    }
  };
  btnRow.appendChild(hear); btnRow.appendChild(hint);
  overlayBody.appendChild(btnRow);
}

/* ---- Stage 4: Spell It Yourself. The word is SPOKEN aloud; the player
   spells from memory via the on-screen QWERTY keyboard (touch) and/or the
   physical keyboard (keydown). Correct letters lock in green; wrong
   keystrokes shake gently and do not advance. ---- */
function renderStage4() {
  var c = WC.curing; if (!c || !overlayBody) return;
  setStageHead(c.word, 4, 'Spell It Yourself');
  overlayBody.innerHTML = '';
  // Level 2 entry comes from walking up (no tap gesture), so the browser may
  // block the automatic speech - the help text points at the Hear button.
  overlayBody.appendChild(el('p', 'wc-help', (WC.level === 2)
    ? 'Tap 🔊 Hear the word, then spell it from memory!'
    : 'Listen… now spell the word from memory!'));
  var ans = el('div', 'wc-answer');
  var slots = [];
  for (var i = 0; i < c.word.length; i++) { var sl = el('span', 'wc-slot', '·'); ans.appendChild(sl); slots.push(sl); }
  overlayBody.appendChild(ans);
  c.slots4 = slots; c.idx4 = 0;
  var kb = el('div', 'wc-kb');
  var rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  for (var r = 0; r < rows.length; r++) {
    var rr = el('div', 'wc-kbrow');
    for (var k = 0; k < rows[r].length; k++) {
      (function (ch) {
        var b = el('button', 'wc-key', ch);
        b.onclick = function () { typeLetter4(ch); };
        rr.appendChild(b);
      })(rows[r][k]);
    }
    kb.appendChild(rr);
  }
  overlayBody.appendChild(kb);
  var btnRow = el('div', 'wc-btnrow');
  var hear = el('button', 'wc-btn', '🔊 Hear the word');
  hear.onclick = function () { SZ.SFX.click(); speak(c.word); };
  var hint = el('button', 'wc-btn hint', '💡 Hint');
  hint.onclick = function () { giveHint4(); };
  btnRow.appendChild(hear); btnRow.appendChild(hint);
  overlayBody.appendChild(btnRow);
  speak(c.word); // spoken aloud at stage entry (entry came from a tap)
}

function typeLetter4(ch) {
  var c = WC && WC.curing;
  if (!c || c.stage !== 4 || c.done || c.idx4 >= c.word.length) return;
  if (ch === c.word[c.idx4]) {
    var sl = c.slots4[c.idx4];
    sl.textContent = ch; sl.classList.add('ok');
    c.idx4++; SZ.SFX.click();
    if (c.idx4 === c.word.length) {
      c.timers.push(setTimeout(function () { completeCure(); }, 700));
    }
  } else {
    shake(c.slots4[c.idx4]);
    c.mistakes++;
  }
}

function giveHint4() {
  var c = WC && WC.curing;
  if (!c || c.stage !== 4 || c.done || c.idx4 >= c.word.length) return;
  SZ.SFX.click(); c.hints++;
  typeLetter4(c.word[c.idx4]); // fills the correct next letter, counted as a hint
}

/* ---- All four stages complete: the happy cure ---- */
function completeCure() {
  var c = WC && WC.curing;
  if (!c || c.done) return;
  c.done = true;
  var stars = awardStars(c.mistakes, c.hints); // 3 = flawless, 2 = minor help, 1 = heavy help
  var sk = (WC.level === 2) ? 'stars2' : 'stars'; // each level keeps its own stars
  var e = null, i;
  for (i = 0; i < WC.words.length; i++) if (WC.words[i].w === c.word) { e = WC.words[i]; break; }
  if (e && stars > e[sk]) e[sk] = stars;
  WC.sessionStars += stars;
  if (WC.sessionStars > bestSessionStars) bestSessionStars = WC.sessionStars;
  var zb = c.zb;
  removeBubble(zb);
  if (zb.wordCure) zb.wordCure.cured = true;
  SZ.repentZombie(zb, true); // the happy repent transformation (celebration = true)
  kit.spawnBurst(zb.pos.x, zb.pos.y + 2, zb.pos.z, 0x9dff57, 26, 3.2, 0.35, 1.3, 3.5);
  confetti();
  closeCure();
  SZ.kit.banner('🎉 ' + c.word + ' cured! ' + starStr(stars), 3);
  updateWbBtn();
  if (wbPanel) refreshWordBook();
  // spaced repetition: words below 3 stars stay in the queue (pickWordIndex
  // skips 3-star words), so they reappear on later zombies automatically
  var done = true;
  for (i = 0; i < WC.words.length; i++) if (WC.words[i][sk] < 3) { done = false; break; }
  if (done) {
    // Level 1 done -> unlock the final exam for this word list, forever
    // (this page visit); Level 2 done -> the Word Master Diploma.
    if (WC.level === 1) {
      level2UnlockKey = levelListKey(WC.words.map(function (x) { return x.w; }));
      setTimeout(function () { if (active()) showDiploma(); }, 1700);
    } else {
      setTimeout(function () { if (active()) showMasterDiploma(); }, 1700);
    }
  } else if (stars < 3) {
    SZ.kit.toast('⭐ ' + starStr(stars) + ' — "' + c.word + '" will visit again for practice!', 4);
  } else {
    SZ.kit.toast('⭐⭐⭐ Mastered!', 3);
  }
}

function confetti() {
  var colors = ['#f44336', '#ffeb3b', '#4caf50', '#2196f3', '#ff9800', '#e91e63', '#9c27b0'];
  for (var i = 0; i < 70; i++) {
    var d = document.createElement('div');
    d.className = 'wc-confetti';
    d.style.left = (Math.random() * 100) + 'vw';
    d.style.background = colors[i % colors.length];
    d.style.animationDuration = (1.6 + Math.random() * 1.6) + 's';
    d.style.animationDelay = (Math.random() * 0.5) + 's';
    if (Math.random() < 0.5) d.style.borderRadius = '50%';
    document.body.appendChild(d);
    (function (dd) {
      setTimeout(function () { if (dd.parentNode) dd.parentNode.removeChild(dd); }, 3800);
    })(d);
  }
}

/* ==========================================================================
   13. The Word Book: a DOM panel listing every loaded word with its stars,
   the mastered count, and the best star total of this page visit.
   ========================================================================== */
var wbBtn = null, wbPanel = null;
function buildWordBookButton() {
  removeWordBook();
  wbBtn = el('button', 'wc-wb-btn', '📚 Word Book');
  wbBtn.onclick = function () { SZ.SFX.click(); toggleWordBook(); };
  document.body.appendChild(wbBtn);
  updateWbBtn();
}
function updateWbBtn() {
  if (!wbBtn || !WC) return;
  var sk = bookSk(), m = 0, i;
  for (i = 0; i < WC.words.length; i++) if (WC.words[i][sk] >= 3) m++;
  wbBtn.textContent = '📚 Word Book' + (WC.viewLevel === 2 ? ' 🎧' : '') +
    ' ' + m + '/' + WC.words.length + ' ★' + WC.sessionStars;
}
/* The book can show either level's stars; the Level 2 tab appears once the
   exam is unlocked for the current list (or when already viewing it). */
function bookSk() { return (WC && WC.viewLevel === 2) ? 'stars2' : 'stars'; }
function level2UnlockedNow() {
  if (!WC || !level2UnlockKey) return false;
  return levelListKey(WC.words.map(function (x) { return x.w; })) === level2UnlockKey;
}
function toggleWordBook() {
  if (wbPanel) { hideWordBook(); return; }
  wbPanel = el('div', 'wc-wb-panel');
  refreshWordBook();
  document.body.appendChild(wbPanel);
}
function refreshWordBook() {
  if (!wbPanel || !WC) return;
  wbPanel.innerHTML = '';
  var sk = bookSk(), m = 0, i;
  for (i = 0; i < WC.words.length; i++) if (WC.words[i][sk] >= 3) m++;
  wbPanel.appendChild(el('div', 'wc-wb-title', '📚 Word Book — ' + wcSchool(WC.viewLevel)));
  if (level2UnlockedNow() || WC.viewLevel === 2) {
    (function () {
      var tgl = el('div', 'wc-btnrow'), v = WC.viewLevel;
      var l1 = el('button', 'wc-btn' + (v !== 2 ? ' primary' : ''), '🩺 Level 1');
      var l2 = el('button', 'wc-btn' + (v === 2 ? ' primary' : ''), '🎧 Level 2');
      l1.onclick = function () { SZ.SFX.click(); WC.viewLevel = 1; refreshWordBook(); updateWbBtn(); };
      l2.onclick = function () { SZ.SFX.click(); WC.viewLevel = 2; refreshWordBook(); updateWbBtn(); };
      tgl.appendChild(l1); tgl.appendChild(l2);
      wbPanel.appendChild(tgl);
    })();
  }
  wbPanel.appendChild(el('div', 'wc-wb-sub', 'Mastered: <b>' + m + ' / ' + WC.words.length + '</b>'));
  wbPanel.appendChild(el('div', 'wc-wb-sub', 'Best stars this visit: <b>★' + bestSessionStars + '</b>'));
  var list = el('div', 'wc-wb-list');
  for (i = 0; i < WC.words.length; i++) {
    var e = WC.words[i];
    list.appendChild(el('div', 'wc-wb-row' + (e[sk] >= 3 ? ' mastered' : ''),
      '<span>' + e.w + '</span><span>' + starStr(e[sk]) + '</span>'));
  }
  wbPanel.appendChild(list);
  var qb = el('button', 'wc-btn', '🏠 Quit to title');
  qb.onclick = function () { SZ.SFX.click(); quitToTitle(); };
  wbPanel.appendChild(qb);
}
function hideWordBook() {
  if (wbPanel && wbPanel.parentNode) wbPanel.parentNode.removeChild(wbPanel);
  wbPanel = null;
}
function removeWordBook() {
  hideWordBook();
  if (wbBtn && wbBtn.parentNode) wbBtn.parentNode.removeChild(wbBtn);
  wbBtn = null;
}

/* ==========================================================================
   14. The Word Doctor Diploma: every loaded word at 3 stars.
   ========================================================================== */
function showDiploma() {
  if (!active()) return;
  if (SZ.G) SZ.G.state = 'paused';
  SZ.showScreen(null);
  buildOverlay();
  overlayHead.appendChild(el('div', 'wc-title', '🎓 Word Doctor Diploma'));
  overlayBody.appendChild(el('div', 'wc-diploma', '🎓'));
  overlayBody.appendChild(el('p', 'wc-help',
    'Amazing, Doctor! You cured all <b>' + WC.words.length + '</b> words with 3 stars each. <b>Noam School</b> is healthy!'));
  overlayBody.appendChild(el('p', 'wc-stars-big', '★★★ × ' + WC.words.length));
  confetti(); confetti();
  try { if (SZ.SFX.hashemLovesMe) SZ.SFX.hashemLovesMe(); } catch (e) {}
  var row = el('div', 'wc-btnrow');
  var again = el('button', 'wc-btn primary', '🔁 Play again');
  again.onclick = function () {
    SZ.SFX.click();
    startWordCure(WC.words.map(function (e) { return e.w; }), 1);
  };
  // Level 1 is mastered -> the final exam is unlocked: offer it right here.
  var lvl2 = el('button', 'wc-btn primary', '🎧 Level 2: Word Master');
  lvl2.onclick = function () {
    SZ.SFX.click();
    startWordCure(WC.words.map(function (e) { return e.w; }), 2);
  };
  var home = el('button', 'wc-btn', '🏠 Title');
  home.onclick = function () { SZ.SFX.click(); quitToTitle(); };
  row.appendChild(again); row.appendChild(lvl2); row.appendChild(home);
  overlayBody.appendChild(row);
  speak('Congratulations, Word Doctor!');
}

/* Level 2 complete: every word spelled from hearing alone, 3 stars each. */
function showMasterDiploma() {
  if (!active()) return;
  if (SZ.G) SZ.G.state = 'paused';
  SZ.showScreen(null);
  buildOverlay();
  overlayHead.appendChild(el('div', 'wc-title', '🏆 Word Master Diploma'));
  overlayBody.appendChild(el('div', 'wc-diploma', '🏆'));
  overlayBody.appendChild(el('p', 'wc-help',
    'Incredible! At <b>Yavne School</b> you spelled all <b>' + WC.words.length + '</b> words <b>from hearing alone</b> — no letters, no copying, 3 stars each. You are a true <b>Word Master</b>!'));
  overlayBody.appendChild(el('p', 'wc-stars-big', '★★★ × ' + WC.words.length));
  confetti(); confetti(); confetti();
  try { if (SZ.SFX.hashemLovesMe) SZ.SFX.hashemLovesMe(); } catch (e) {}
  var row = el('div', 'wc-btnrow');
  var again = el('button', 'wc-btn primary', '🔁 Exam again');
  again.onclick = function () {
    SZ.SFX.click();
    startWordCure(WC.words.map(function (e) { return e.w; }), 2);
  };
  var learn = el('button', 'wc-btn', '🩺 Level 1');
  learn.onclick = function () {
    SZ.SFX.click();
    startWordCure(WC.words.map(function (e) { return e.w; }), 1);
  };
  var home = el('button', 'wc-btn', '🏠 Title');
  home.onclick = function () { SZ.SFX.click(); quitToTitle(); };
  row.appendChild(again); row.appendChild(learn); row.appendChild(home);
  overlayBody.appendChild(row);
  speak('Congratulations, Word Master!');
}

})();
