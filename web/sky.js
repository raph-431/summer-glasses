// Deals one of the skies in sky.css. A classic script on purpose: loaded in
// <head>, it sets the class before the first paint, so the page never flashes
// a default background and then changes its mind.
(function(){
  // Always sunset — it's the one that flows out of the gallery's sunset hero
  // and sits right with the bitter-orange / oxblood palette. (?sky= can force
  // another for screenshots.)
  var ALL = ['dawn', 'morning', 'noon', 'afternoon', 'sunset', 'dusk'];
  var forced = new URLSearchParams(location.search).get('sky');
  var sky = (forced && ALL.indexOf(forced) >= 0) ? forced : 'sunset';
  document.documentElement.classList.add('sky-' + sky);
})();
