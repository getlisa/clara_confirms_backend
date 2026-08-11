/**
 * Swap a real module out for a fake, by pre-seeding require.cache.
 *
 * The dispatcher pulls in `../db` transitively through a dozen modules, and
 * `require("../db")` opens a pg Pool at module load — so a stub has to be in
 * place BEFORE the module under test is required, not after. Seeding the cache
 * by resolved filename is the only thing that works for every one of those
 * transitive requires at once, since they all resolve to the same file.
 */

const path = require("path");

const SRC = path.resolve(__dirname, "..", "..", "src");

function stub(relativeToSrc, exports) {
  const filename = require.resolve(path.join(SRC, relativeToSrc));
  require.cache[filename] = {
    id: filename,
    filename,
    path: path.dirname(filename),
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
  return exports;
}

/** Logger that swallows output but keeps it inspectable (warn assertions). */
function silentLogger() {
  const records = { debug: [], info: [], warn: [], error: [] };
  const make = (level) => (...args) => { records[level].push(args); };
  return {
    debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error"),
    records,
    reset() { for (const k of Object.keys(records)) records[k].length = 0; },
  };
}

module.exports = { stub, silentLogger, SRC };
