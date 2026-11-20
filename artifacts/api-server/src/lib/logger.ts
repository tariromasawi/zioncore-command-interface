import pino from "pino";

export function requestLogUrl(url:string|undefined) {
  const path=url?.split("?")[0];
  return path?.replace(/^\/api\/command\/private(?:\/.*)?$/i,"/api/command/private/[redacted]");
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
});
