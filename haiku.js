// ---------------------------------------------------------------------------
// HAIKU — a generative caption composed from the scene state: drink line,
// setting line by canopy, time line by time-of-day preset. Shown on load and
// on every deal (via the window.onDeal hook main.js fires), fading after
// seven seconds. Each bank's final entry is the "aethereal" pick — more
// abstract than the rest of its bank.
//
// Dev-only flourish: this file is NOT part of the minted artwork build.
// main.js has no reference to it — remove the script tag and the piece runs
// identically, minus the caption. Loads after main.js (shares its globals).
// ---------------------------------------------------------------------------
const DRINK_LINE = {
  soda:          ["cola bubbles rise", "dark soda, ice-cold", "the fizz settles down", "soda catches light", "a small universe"],
  oj:            ["orange juice glows bright", "sunlight in a glass", "the orange juice gleams", "fresh juice, cold and bright", "a captured orange"],
  water:         ["cold water, clear light", "water catches light", "clear water sits still", "ice water sits calm", "water holds no name"],
  sparkling:     ["bubbles rise and pop", "sparkling water glows", "bright bubbles ascend", "water fizzes bright", "a thousand small breaths"],
  whiteWine:     ["pale white wine, chilled now", "white wine catches light", "cold wine, crisp and pale", "the white wine glows pale", "a quiet gold fire"],
  redWine:       ["red wine, deep and dark", "dark red wine glows deep", "the red wine runs deep", "bold red wine, held close", "the dark holds embers"],
  rose:          ["pale rosé glows pink", "rosé catches light", "cold rosé, pale pink", "the rosé glows soft", "a blush, held in glass"],
  whiskey:       ["amber whiskey glows", "whiskey catches light", "a dram, warm and deep", "whiskey, amber, still", "years, distilled to warmth"],
  chartreuse:    ["green chartreuse glows", "herbal green, cold light", "chartreuse, bright and green", "a green fire, distilled", "green as a summer leaf"],
  blueLagoon:    ["blue lagoon glows bright", "electric blue glows", "the blue lagoon gleams", "ocean blue, ice-cold", "a sky turned to sea"],
  icedTea:       ["amber iced tea glows", "cold tea, steeped and dark", "iced tea catches light", "cool tea, amber, deep", "slow hours, steeped and cold"],
  champagne:     ["champagne bubbles rise", "cold champagne, pale gold", "champagne catches light", "bright bubbles, pale gold", "small stars, set alight"],
  spritz:        ["bright spritz, bittersweet", "orange spritz glows bright", "the spritz, cold and bright", "spritz fizzes, pale gold", "bittersweet, and bright"],
  pastis:        ["pastis, cloudy, cold", "pastis turns to milk", "cloudy pastis glows", "anise clouds the glass", "anise turns to mist"],
  appleJuice:    ["apple juice runs sweet", "cold apple juice glows", "apple juice, sun-bright", "a harvest of light"],
  shirleyTemple: ["cherry pink and sweet", "Shirley Temple glows", "grenadine runs sweet", "cherry-bright and sweet", "childhood, poured in pink"],
  lemonade:      ["lemonade glows bright", "cold lemonade glows", "tart lemonade, cold", "sun-cooled lemonade", "citrus and sweetness"],
  gin:           ["gin and juniper", "cold gin catches light", "gin glows, cold and bright", "neat gin, cold and clear", "juniper and cold"],
  ginFizz:       ["gin fizz, cold and bright", "the gin fizz glows bright", "citrus gin fizz glows", "frothy gin fizz, cold", "foam, rising like cloud"],
  empty:         ["the glass stands empty", "only ice remains", "the last drop is gone", "the glass sits, drained now", "the ghost of a drink"],
};
const SETTING_LINE = {
  0: ["in the broadleaf's dappled shade", "on the terrasse, dappled shade", "beneath the leaf's mottled shade", "under the broad leaves' shadow",
      "leaves cut the sunlight to coins", "cutting shapes in the raw wind"],
  1: ["beneath the lace of thin leaves", "under the feathery shade", "in the fine dappled sunlight", "beneath acacia's thin shade",
      "the small details of friendship", "lace and mesh, intertwined now"],
  2: ["beneath the swaying palm trees", "under the tall palms, leaning", "poolside beneath the palm trees", "in the shade of palm fronds now",
      "whisper of the fronds above", "waves of both light and darkness"],
  3: ["under the pergola's shade", "beneath the pergola's shade", "on the vine-strung pergola", "in the pergola's cool shade",
      "a lattice of ancient forms", "valleys of light and shadow"],
  4: ["beneath the striped parasol", "under the parasol's shade", "at a table, sun-shaded", "beneath the parasol's stripes",
      "a soft wall against the sun", "slow moving circle of shade"],
};
const TIME_LINE = {
  dawn:            ["dawn breaks soft and gold", "morning mist still clings", "the air still holds night", "first light finds the glass", "threshold of the day"],
  morning:         ["the sun climbs slowly", "morning mist still clings", "first light finds the glass", "threshold of the day"],
  noon:            ["noon light, still and gold", "the sun stands still now", "shadows pull in tight", "heat shimmers the air", "midday heat presses", "the absence of shade"],
  goldenAfternoon: ["gold light slants in low", "afternoon turns gold", "shadows stretch and lean", "the light softens now", "heat, honey, and heart"],
  sunset:          ["the sun dips low now", "the last light fades out", "colors bleed to rose", "the sky catches fire", "day exhales and falls", "exhale of the day"],
  dusk:            ["blue dusk wraps the air", "twilight settles slow", "the color drains out", "shadows turn to blue", "in the deep blue hour"],
  night:           ["evening settles in", "the stars start to show", "night wraps the table", "lanterns start to glow", "the dark holds it close", "from light years away"],
};
const pickCap = arr => arr[(Math.random()*arr.length)|0];
let legendTimer = 0;
function showLegend(){
  const el  = $('legend');
  const liq = $('liquid').value;
  el.textContent = [
    pickCap(DRINK_LINE[liq] || DRINK_LINE.water),
    pickCap(SETTING_LINE[$('canopy').value] || SETTING_LINE[0]),
    pickCap(TIME_LINE[$('tod').value] || TIME_LINE.goldenAfternoon),
  ].join('\n');
  el.classList.add('show');
  clearTimeout(legendTimer);
  legendTimer = setTimeout(() => el.classList.remove('show'), 7000);
}
// H replays the deal's haiku without recomposing it (unless there is none yet)
function revealLegend(){
  const el = $('legend');
  if(!el.textContent){ showLegend(); return; }
  el.classList.add('show');
  clearTimeout(legendTimer);
  legendTimer = setTimeout(() => el.classList.remove('show'), 7000);
}
addEventListener('keydown', e => {
  if(e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if(e.key === 'h' || e.key === 'H') revealLegend();
});
window.onDeal = showLegend;
showLegend();   // caption the opening scene too
