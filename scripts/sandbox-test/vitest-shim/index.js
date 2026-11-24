/**
 * Sandbox-only `vitest` shim over node:test.
 *
 * The DSH sandbox blocks child-process spawns with pipe stdio, which breaks
 * Vitest (Vite transforms every file with esbuild, which spawns a helper
 * process). This shim lets the compiled test suites run under `node --test`
 * instead, implementing the small vitest API surface the project's tests use:
 * describe/it/it.each, expect with the used matchers (incl. async
 * resolves/rejects, mock matchers, objectContaining/stringContaining), and
 * vi.fn with mock.calls/mock.results recording.
 *
 * It is NOT a full vitest replacement and is only used by
 * scripts/mdt-dev.ps1 in restricted environments.
 */
'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert');

/* ------------------------------------------------------------------ */
/* Pattern matching                                                    */
/* ------------------------------------------------------------------ */

class ObjectContaining {
  constructor(pattern) {
    this.pattern = pattern;
  }
}

class StringContaining {
  constructor(text) {
    this.text = text;
  }
}

function isObjectLike(value) {
  return value !== null && typeof value === 'object';
}

/** Recursive partial match (toMatchObject semantics, simplified). */
function matches(value, pattern) {
  if (pattern instanceof StringContaining) {
    return typeof value === 'string' && value.includes(pattern.text);
  }
  if (pattern instanceof RegExp) {
    return typeof value === 'string' && pattern.test(value);
  }
  if (pattern instanceof ObjectContaining) {
    return matches(value, pattern.pattern);
  }
  if (Array.isArray(pattern)) {
    if (!Array.isArray(value) || value.length !== pattern.length) return false;
    return pattern.every((p, i) => matches(value[i], p));
  }
  if (isObjectLike(pattern)) {
    if (!isObjectLike(value)) return false;
    return Object.keys(pattern).every((key) => matches(value[key], pattern[key]));
  }
  return Object.is(value, pattern) || value === pattern;
}

function strictEqual(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* expect                                                              */
/* ------------------------------------------------------------------ */

function format(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function makeExpect(actual, negate) {
  const check = (ok, message) => {
    const finalOk = negate ? !ok : ok;
    if (!finalOk) {
      const prefix = negate ? 'Expected NOT ' : 'Expected ';
      throw new assert.AssertionError({ message: `${prefix}${message}`, actual, operator: negate ? 'not' : 'to be' });
    }
  };

  const base = {
    toBe: (expected) => check(Object.is(actual, expected), `value to be ${format(expected)}, got ${format(actual)}`),
    toEqual: (expected) => check(strictEqual(actual, expected), `value to equal ${format(expected)}, got ${format(actual)}`),
    toStrictEqual: (expected) => check(strictEqual(actual, expected), `value to strictly equal ${format(expected)}`),
    toBeTruthy: () => check(Boolean(actual), 'value to be truthy'),
    toBeFalsy: () => check(!actual, 'value to be falsy'),
    toBeUndefined: () => check(actual === undefined, 'value to be undefined'),
    toBeDefined: () => check(actual !== undefined, 'value to be defined'),
    toBeNull: () => check(actual === null, 'value to be null'),
    toBeInstanceOf: (ctor) => check(actual instanceof ctor, `value to be instance of ${ctor.name}`),
    toHaveLength: (n) => check(actual !== null && actual !== undefined && actual.length === n, `value to have length ${n}, got ${actual === null ? null : actual.length}`),
    toContain: (needle) =>
      check(
        typeof actual === 'string' ? actual.includes(needle) : Array.isArray(actual) && actual.some((v) => strictEqual(v, needle) || v === needle),
        `value to contain ${format(needle)}`,
      ),
    toMatchObject: (pattern) => check(matches(actual, pattern), `value to match ${format(pattern)}, got ${format(actual)}`),
    toMatch: (re) => check(typeof actual === 'string' && re.test(actual), `value to match ${re}`),
    toBeGreaterThan: (n) => check(actual > n, `${actual} to be > ${n}`),
    toBeGreaterThanOrEqual: (n) => check(actual >= n, `${actual} to be >= ${n}`),
    toBeLessThan: (n) => check(actual < n, `${actual} to be < ${n}`),
    toBeLessThanOrEqual: (n) => check(actual <= n, `${actual} to be <= ${n}`),
    toHaveBeenCalled: () => check(isMock(actual) && actual.mock.calls.length > 0, 'mock to have been called'),
    toHaveBeenCalledTimes: (n) => check(isMock(actual) && actual.mock.calls.length === n, `mock to have been called ${n} times, got ${isMock(actual) ? actual.mock.calls.length : 'not a mock'}`),
    toHaveBeenCalledWith: (...expected) => {
      const calls = isMock(actual) ? actual.mock.calls : [];
      check(calls.some((args) => args.length === expected.length && expected.every((e, i) => matches(args[i], e))), `mock to have been called with ${format(expected)}`);
    },
    toHaveBeenLastCalledWith: (...expected) => {
      const calls = isMock(actual) ? actual.mock.calls : [];
      const last = calls[calls.length - 1];
      check(!!last && last.length === expected.length && expected.every((e, i) => matches(last[i], e)), 'mock last call to match');
    },
    toThrow: (expected) => {
      let threw = false;
      let message = 'nothing';
      try {
        if (typeof actual === 'function') actual();
      } catch (err) {
        threw = true;
        message = err instanceof Error ? err.message : String(err);
      }
      if (expected instanceof RegExp) check(threw && expected.test(message), `function to throw matching ${expected}`);
      else if (typeof expected === 'string') check(threw && message.includes(expected), `function to throw containing "${expected}"`);
      else check(threw, 'function to throw');
    },
  };

  const asyncWrap = {
    resolves: {
      toEqual: async (expected) => {
        const value = await actual;
        check(strictEqual(value, expected), `resolved value to equal ${format(expected)}, got ${format(value)}`);
      },
      toBeUndefined: async () => {
        const value = await actual;
        check(value === undefined, 'resolved value to be undefined');
      },
    },
    rejects: {
      toMatchObject: async (pattern) => {
        let error = null;
        try {
          await actual;
        } catch (err) {
          error = err;
        }
        check(error !== null, 'promise to reject');
        check(matches(error, pattern), `rejection to match ${format(pattern)}, got ${format(error)}`);
      },
      toThrow: async (expected) => {
        let error = null;
        try {
          await actual;
        } catch (err) {
          error = err;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (expected instanceof RegExp) check(error !== null && expected.test(message), 'promise to reject matching');
        else check(error !== null && message.includes(String(expected)), 'promise to reject');
      },
    },
  };

  const expectObject = Object.assign({}, base, asyncWrap);
  Object.defineProperty(expectObject, 'not', {
    get: () => makeExpect(actual, !negate),
  });
  return expectObject;
}

function expect(actual) {
  return makeExpect(actual, false);
}
expect.objectContaining = (pattern) => new ObjectContaining(pattern);
expect.stringContaining = (text) => new StringContaining(text);
expect.any = () => new ObjectContaining({ __mdt_any: true });

/* ------------------------------------------------------------------ */
/* vi                                                                  */
/* ------------------------------------------------------------------ */

function isMock(fn) {
  return typeof fn === 'function' && fn.mock !== undefined;
}

function viFn(impl) {
  const calls = [];
  const results = [];
  const fn = (...args) => {
    calls.push(args);
    try {
      const value = impl === undefined ? undefined : impl(...args);
      results.push({ type: 'return', value });
      return value;
    } catch (err) {
      results.push({ type: 'throw', value: err });
      throw err;
    }
  };
  fn.mock = {
    calls,
    results,
    get lastCall() {
      return calls[calls.length - 1];
    },
  };
  return fn;
}

const vi = {
  fn: (impl) => viFn(impl),
  spyOn: (obj, method) => {
    const original = obj[method];
    const mock = viFn(original);
    obj[method] = mock;
    mock.mockRestore = () => {
      obj[method] = original;
    };
    return mock;
  },
};

/* ------------------------------------------------------------------ */
/* describe / it / it.each                                             */
/* ------------------------------------------------------------------ */

function printfReplace(name, args) {
  let index = 0;
  return name.replace(/%[idsoj]/g, () => {
    const value = args[index] ?? '';
    index += 1;
    return String(value);
  });
}

function makeIt(itFn) {
  const wrapped = (name, fn) => itFn(name, fn);
  wrapped.each = (table) => (name, fn) => {
    for (const row of table) {
      const args = Array.isArray(row) ? row : [row];
      const label = printfReplace(name, args);
      itFn(`${label}`, () => fn(...args));
    }
  };
  wrapped.skip = (name, fn) => itFn(name, { skip: true }, fn);
  wrapped.todo = (name) => itFn(name, { todo: true }, () => {});
  return wrapped;
}

const it = makeIt(nodeTest.it);
const test = makeIt(nodeTest.test);

module.exports = {
  describe: nodeTest.describe,
  suite: nodeTest.suite,
  it,
  test,
  expect,
  vi,
  beforeEach: nodeTest.beforeEach,
  afterEach: nodeTest.afterEach,
  beforeAll: nodeTest.before,
  afterAll: nodeTest.after,
};
