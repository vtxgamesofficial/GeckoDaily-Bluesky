const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? 1;

function ts() {
  return new Date().toISOString();
}

function make(level) {
  return (...args) => {
    if (LEVELS[level] < current) return;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`[${ts()}] [${level.toUpperCase()}]`, ...args);
  };
}

export const logger = {
  debug: make("debug"),
  info: make("info"),
  warn: make("warn"),
  error: make("error"),
};
