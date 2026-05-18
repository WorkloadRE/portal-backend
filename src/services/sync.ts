import { PeopleSyncRepository } from "../repository/people_sync.js";
import { SyncRepository } from "../repository/sync.js";
import { inject, injectable } from "tsyringe";
import RepliersClients from "./repliers/clients.js";
import { JetStreamClient } from "@nats-io/jetstream";
import { ApiError } from "../lib/errors.js";
import type { AppConfig } from "../config.js";
import { RplOperator } from "../types/repliers.js";
import _ from "lodash";

export interface PeopleSyncPayload {
   id: number;
   firstName?: string;
   lastName?: string;
   emails?: Array<{ value: string; type?: string }>;
   phones?: Array<{ value: string; type?: string }>;
   tags?: string[];
   addresses?: unknown[];
}

@injectable()
export default class SyncService {
   constructor(private readonly syncRepository: SyncRepository, private readonly peopleSyncRepository: PeopleSyncRepository, private readonly repliersClients: RepliersClients, @inject("config")
   private config: AppConfig, @inject("nats")
   private readonly jsc: Promise<JetStreamClient>) {}
   async processUpsert(id: number, payload: PeopleSyncPayload) {
      try {
         const peopleSync = await this.peopleSyncRepository.getById(id);
         if (peopleSync === undefined) {
            throw new Error("Sync information not found");
         }
         const email = payload.emails?.find(e => e.type === "main" || e.type === "primary")?.value ?? payload.emails?.[0]?.value;
         const phone = payload.phones?.find(p => p.type === "main" || p.type === "primary")?.value ?? payload.phones?.[0]?.value;
         if (phone === undefined && email === undefined) {
            throw new Error("No email or phone found");
         }
         const possibleClient = await this.repliersClients.filter({
            externalId: payload.id.toString(),
            email,
            phone,
            operator: RplOperator.OR
         });
         let client = possibleClient.clients[0];
         // RplClientsCreateRequest/UpdateRequest fields are strict (not
         // `string | undefined`), so we conditionally spread each optional
         // payload field only when it's defined.
         const optionals = {
            ...(email !== undefined          && { email }),
            ...(payload.firstName !== undefined && { fname: payload.firstName }),
            ...(payload.lastName !== undefined  && { lname: payload.lastName }),
            ...(payload.tags !== undefined   && { tags: payload.tags }),
            ...(phone !== undefined          && { phone }),
         };
         if (client === undefined) {
            client = await this.repliersClients.create({
               agentId: peopleSync.agent_id,
               ...optionals,
               status: true,
               externalId: payload.id
            });
         } else {
            await this.repliersClients.update({
               clientId: client.clientId,
               agentId: peopleSync.agent_id,
               ...optionals,
               status: true,
               externalId: payload.id
            });
         }
         await this.peopleSyncRepository.update(id, {
            client_id: client.clientId,
            status: "SUCCESS"
         });
         await this.syncRepository.updateLastProcessedAt(peopleSync.sync_id);
      } catch (error) {
         let status = "UNKNOWN ERROR";
         if (error instanceof ApiError) {
            status = JSON.stringify({
               error: error.message,
               info: error.opts
            });
         } else if (error instanceof Error) {
            status = JSON.stringify({
               error: error.message
            });
         }
         await this.peopleSyncRepository.update(id, {
            status
         });
         throw error;
      }
   }
   async publishUpsert(id: number, payload: PeopleSyncPayload) {
      const jsc = await this.jsc;
      return jsc.publish(`${this.config.nats.worker.consumer_stream}.people.upsert`, JSON.stringify({
         id,
         payload
      }));
   }
}
