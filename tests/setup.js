/**
 * tests/setup.js
 * Global test environment: mock Chrome extension APIs and browser globals
 * that aren't in jsdom by default.
 */

// ── Chrome extension API mock ──────────────────────────────────────────────────
global.chrome = {
  runtime: {
    sendMessage: jest.fn(),
    onMessage: { addListener: jest.fn() },
  },
  storage: {
    local: {
      get:  jest.fn((_keys, cb) => cb && cb({})),
      set:  jest.fn((_data, cb) => cb && cb()),
    },
  },
};

// ── performance.getEntriesByType mock ─────────────────────────────────────────
if (!global.performance) global.performance = {};
global.performance.getEntriesByType = jest.fn(() => []);

// ── execCommand (jsdom stub) ──────────────────────────────────────────────────
document.execCommand = jest.fn(() => true);

// ── DataTransfer (not in jsdom) ───────────────────────────────────────────────
if (!global.DataTransfer) {
  global.DataTransfer = class DataTransfer {
    constructor() { this.items = { add: jest.fn() }; this.files = []; this._data = {}; }
    setData(type, value) { this._data[type] = String(value); }
    getData(type) { return this._data[type] ?? ''; }
  };
}

// ── ClipboardEvent / DragEvent ────────────────────────────────────────────────
if (!global.ClipboardEvent) {
  global.ClipboardEvent = class ClipboardEvent extends Event {
    constructor(type, init) { super(type, init); this.clipboardData = init?.clipboardData; }
  };
}
if (!global.DragEvent) {
  global.DragEvent = class DragEvent extends Event {
    constructor(type, init) { super(type, init); this.dataTransfer = init?.dataTransfer; }
  };
}

// ── Silence console.log/warn in tests (keep errors) ──────────────────────────
global.console.log  = jest.fn();
global.console.warn = jest.fn();
