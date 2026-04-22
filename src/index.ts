import "reflect-metadata";
import "./providers/index.js";
import http from "node:http";
import type { Logger } from "pino";
import { container } from "tsyringe";
import app from "./app.js";
import config from "./config.js";
import BossWebhooksService from "./services/boss/webhook.js";
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

// FUB webhook installer — only run if BOSS_ENABLED. Bruno Fine Properties
// runs with BOSS_ENABLED=false (ActiveCampaign is the primary CRM), so this
// entire block is a no-op in production.
let webhook: BossWebhooksService | undefined;
if (config.boss.enabled && config.boss.webhook.enabled) {
   webhook = container.resolve(BossWebhooksService);
   await webhook.installHooks();
   logger.info("BossWebhooksService: hooks installed");
} else {
   logger.info("BossWebhooksService: skipped (boss.enabled=%s webhook.enabled=%s)", config.boss.enabled, config.boss.webhook.enabled);
}

const shutdown = (signal: string) => {
   logger.info(`Shutting down (${signal})`);
   if (webhook) {
      webhook.uninstallHooks().finally(() => process.exit(0));
   } else {
      process.exit(0);
   }
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));