import pino from "pino";

export function createLogger(level: string = "info") {
  return pino({
    level,
    transport: {
      target: "pino/file",
      options: { destination: 1 }, // stdout
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
