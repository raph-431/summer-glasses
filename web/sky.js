// Deals one of the skies in sky.css. A classic script on purpose: loaded in
// <head>, it sets the class before the first paint, so the page never flashes
// a default background and then changes its mind.
(function(){
  var SKIES = ['dawn', 'morning', 'noon', 'afternoon', 'sunset', 'dusk'];
  var forced = new URLSearchParams(location.search).get('sky');   // for screenshots
  var sky = (forced && SKIES.indexOf(forced) >= 0)
    ? forced : SKIES[Math.floor(Math.random() * SKIES.length)];
  document.documentElement.classList.add('sky-' + sky);
})();
