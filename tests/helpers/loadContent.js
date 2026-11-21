/**
 * tests/helpers/loadContent.js
 *
 * Evaluates content/content.js inside the current jsdom window so every
 * function it defines lands on `window` (which is `global` in jsdom).
 * Call once at the top of each test file: `require('../helpers/loadContent')`.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const src = fs.readFileSync(
  path.resolve(__dirname, '../../content/content.js'),
  'utf8'
);

// Wrap in a function so `return` statements inside top-level functions work
// (strict-mode scripts run via `new Function` must not contain bare returns).
// We strip the `'use strict'` directive first then re-add it inside the wrapper.
const stripped = src.replace(/^'use strict';?\s*/m, '');

const context = vm.createContext({
  ...global,           // jsdom globals (document, window, navigator, …)
  window:   global,
  chrome:   global.chrome,
  performance: global.performance,
  console:  global.console,
  fetch:    global.fetch,    // may be undefined; individual tests mock it
  setTimeout:  global.setTimeout,
  clearTimeout: global.clearTimeout,
  requestAnimationFrame: cb => setTimeout(cb, 0),
  MutationObserver: global.MutationObserver,
  Event:    global.Event,
  KeyboardEvent: global.KeyboardEvent,
  InputEvent: global.InputEvent,
  ClipboardEvent: global.ClipboardEvent,
  DragEvent: global.DragEvent,
  DataTransfer: global.DataTransfer,
  File:     global.File,
  Blob:     global.Blob,
  URL:      global.URL,
  history:  { pushState: jest.fn() },
  PopStateEvent: global.PopStateEvent || Event,
  atob:     global.atob,
  btoa:     global.btoa,
});

// Run the script; all top-level `function foo()` declarations are hoisted
// onto `context` automatically by the V8 vm module.
vm.runInContext(`'use strict';\n${stripped}`, context, {
  filename: 'content.js',
  displayErrors: true,
});

// Export the context so individual tests can grab functions from it
module.exports = context;
