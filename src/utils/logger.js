const level = process.env.LOG_LEVEL || "info";
const levels = { debug: 0, info: 1, warn: 2, error: 3 };

function log(levelName, ...args) {
  if (levels[levelName] >= levels[level]) {
    const prefix = `[${new Date().toISOString()}] ${levelName.toUpperCase()}`;
    console.log(prefix, ...args);
  }
}

module.exports = {
  debug: (...args) => log("debug", ...args),
  info: (...args) => log("info", ...args),
  warn: (...args) => log("warn", ...args),
  error: (...args) => log("error", ...args),
};
