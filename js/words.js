// Word sources for the typing test.

const DE = `der die und in den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an werden aus er hat
dass sie nach wird bei einer um am sind noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch
man sein wurde sei hier immer jetzt kann gibt schon wenn ich wir ihr ihm uns euch was wer wo warum heute morgen gestern
zeit jahr tag woche monat leben welt haus stadt land straße arbeit schule kind mann frau mensch leute freund familie
geld wasser essen buch bild frage antwort teil ende anfang weg recht hand kopf auge herz wort sprache name nummer
gut neu groß klein alt lang kurz hoch tief schnell langsam leicht schwer früh spät viel wenig ganz gleich anders
eigen richtig falsch schön wichtig möglich klar sicher einfach letzte erste zweite dritte nächste deutsch
machen sagen gehen kommen sehen geben stehen finden bleiben liegen heißen denken nehmen tun dürfen halten nennen
zeigen führen sprechen bringen leben fahren meinen fragen kennen gelten stellen spielen arbeiten brauchen folgen
lernen bestehen verstehen setzen bekommen beginnen erzählen versuchen schreiben laufen erklären entsprechen sitzen
ziehen scheinen fallen gehören entstehen erhalten treffen suchen legen vorstellen handeln erreichen tragen schaffen
lesen verlieren darstellen erkennen entwickeln reden aussehen erscheinen bilden anfangen erwarten wohnen betreffen
warten vergehen helfen gewinnen schließen fühlen bieten interessieren erinnern ergeben anbieten studieren verbinden
ansehen fehlen bedeuten vergleichen tastatur taste schicht finger daumen rechner programm fenster bildschirm
dabei damit dann dort heute hier manchmal oft selten wieder zusammen vielleicht natürlich eigentlich trotzdem
deshalb außerdem zwischen gegen ohne unter neben hinter während wegen statt seit trotz innerhalb außerhalb`;

const EN = `the be to of and a in that have it for not on with he as you do at this but his by from they we say her she
or an will my one all would there their what so up out if about who get which go me when make can like time no just
him know take people into year your good some could them see other than then now look only come its over think also
back after use two how our work first well way even new want because any these give day most us is was are been has
had were said did very much where through long down should still own find here thing many life tell child world
school point hand place week case company group number problem fact keyboard layer finger thumb split column row
right left old great high small large next early young important few public bad same able last late hard major better
best sure free clear full special easy whole strong possible real every open close begin start seem help show hear
play run move live believe hold bring happen write provide sit stand lose pay meet include continue set learn change
lead understand watch follow stop create speak read allow add spend grow offer remember love consider appear buy
wait serve die send expect build stay fall cut reach kill remain suggest raise pass sell require report decide pull
water money story month lot study book eye job word business issue side kind head house service friend father power
hour game line end member law car city community name president team minute idea body information nothing ago`;

const CODE_TOKENS = [
  '()', '[]', '{}', '<>', '=>', '->', '!=', '==', '===', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '::',
  ';', ':', ',', '.', '!', '?', '@', '#', '$', '%', '^', '&', '*', '~', '`', '\\', '|', '_', '-', '+', '=', '/',
  "'", '"', '//', '/*', '*/', '#{}', '$()', '${}', '<!--', '-->', '?.', '??', '...', '[0]', '{}()', '"";', "'';",
];
const CODE_WORDS = ['const', 'let', 'if', 'else', 'for', 'while', 'return', 'function', 'class', 'import', 'export', 'true',
  'false', 'null', 'map', 'filter', 'key', 'value', 'array', 'list', 'item', 'index', 'name', 'data', 'config', 'layer'];

const parse = (s) => s.split(/\s+/).filter(Boolean);
export const WORD_LISTS = { de: parse(DE), en: parse(EN) };

function pick(arr, rnd) {
  return arr[Math.floor(rnd() * arr.length)];
}

/**
 * Generate words for a test.
 * opts: { lang: 'de'|'en', count, punctuation, numbers, mode: 'words'|'time'|'code' }
 */
export function generateWords(opts, rnd = Math.random) {
  const out = [];
  const list = WORD_LISTS[opts.lang] || WORD_LISTS.de;
  let sentenceStart = true;
  while (out.length < opts.count) {
    if (opts.mode === 'code') {
      const r = rnd();
      if (r < 0.45) out.push(pick(CODE_TOKENS, rnd));
      else if (r < 0.7) out.push(pick(CODE_WORDS, rnd) + pick(['()', '[]', ';', ':', '.', ',', '{', '=', '=>', '?'], rnd));
      else if (r < 0.85) out.push(pick(['(', '[', '{', '"', "'", '<', '`'], rnd) + pick(CODE_WORDS, rnd) + pick([')', ']', '}', '"', "'", '>', '`'], rnd));
      else out.push(String(Math.floor(rnd() * 1000)) + pick(['', '%', ';', ')', ']', '.0', 'px'], rnd));
      continue;
    }
    let w;
    if (opts.numbers && rnd() < 0.12) {
      w = String(Math.floor(rnd() * (rnd() < 0.5 ? 100 : 10000)));
    } else {
      w = pick(list, rnd);
      if (out.length && w === out[out.length - 1]) continue;
    }
    if (opts.punctuation) {
      // German nouns are capitalized; we only capitalize sentence starts to keep it fair across languages.
      if (sentenceStart) w = w[0].toUpperCase() + w.slice(1);
      sentenceStart = false;
      const r = rnd();
      if (r < 0.08) { w += '.'; sentenceStart = true; }
      else if (r < 0.13) w += ',';
      else if (r < 0.15) { w += '?'; sentenceStart = true; }
      else if (r < 0.165) { w += '!'; sentenceStart = true; }
      else if (r < 0.18) w += ':';
      else if (r < 0.19) w = '"' + w + '"';
      else if (r < 0.2) w = '(' + w + ')';
      else if (r < 0.21) w += ';';
      else if (r < 0.22 && out.length) w = '-';
    }
    out.push(w);
  }
  if (opts.punctuation && opts.mode !== 'code') {
    const last = out[out.length - 1];
    if (!/[.!?]$/.test(last)) out[out.length - 1] = last.replace(/[,:;]$/, '') + '.';
  }
  return out;
}
