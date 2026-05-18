import "reflect-metadata";
import "./providers/index.js";
import http from "node:http";
import type { Logger } from "pino";
import { container } from "tsyringe";
import app from "./app.js";
import config from "./config.js";
const logger = container.resolve<Logger>("logger.global");

// setup nats connection on start, testing resolving on actual use
// import { JetStreamClient } from "@nats-io/jetstream";
// await container.resolve<Promise<JetStreamClient>>("nats");

import _debug from 'debug';
const debug = _debug("repliers:server");
debug(`process.env.PORT:`, process.env["PORT"]);
debug(`Starting server with config:`, config);
http.createServer(app.callback()).listen(config.app.port, () => {
   logger.info(`Server is running on port ${config.app.port}`);
});

// Follow Up Boss webhook installer was removed when FUB was replaced by
// ActiveCampaign; nothing to wire up on startup beyond the HTTP server.
process.on("SIGINT", () => {
   logger.info("Shutting down");
   process.exit(0);
});
process.on("SIGTERM", () => {
   logger.info("Shutting down");
   process.exit(0);
});
