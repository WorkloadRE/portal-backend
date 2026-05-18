import { injectable, inject } from "tsyringe";
import _debug from "debug";
import ActiveCampaignService from "../activecampaign.js";
import type { AppConfig } from "config.js";
import { Context } from "koa";
import { CrmEventsCreateRequest, CrmNoteCreateRequest } from "../../types/crm-events.js";

const debug = _debug("repliers:services:eventsCollection");

export type EventsCollectionPropertiesSelector = (ctx: Context) => Promise<CrmEventsCreateRequest | null>;
export type NotesCollectionPropertiesSelector = (ctx: Context) => Promise<CrmNoteCreateRequest | null>;

@injectable()
export default class EventsCollectionService {
   constructor(
      private activecampaign: ActiveCampaignService,
      @inject("config") private config: AppConfig
   ) {}

   eventsCreate(params: Partial<CrmEventsCreateRequest>) {
      const {
         ignoreDefaultTags,
         ...rest
      } = params;
      debug("[reportEvent] params %O", params);
      const enrichedParams: Partial<CrmEventsCreateRequest> = {
         ...this.config.eventsCollection.defaultEventFields,
         ...rest,
         person: {
            ...params.person,
            ...this.assignAgent(params.person),
            tags: ignoreDefaultTags ? params.person?.tags : this.assignTags(params.person)
         }
      };

      // Fire-and-forget to ActiveCampaign — primary CRM for Bruno Fine Properties.
      // AC failures must not break user-facing flows.
      this.activecampaign.pushEvent(enrichedParams).catch(e => {
         debug("[reportEvent] AC error %O", e);
      });
   }

   async noteCreate(params: CrmNoteCreateRequest) {
      // Notes were a Follow Up Boss concept; ActiveCampaign has no notes API.
      // Log for traceability but don't dispatch anywhere.
      debug("[noteCreate] params %O (no-op, FUB removed)", params);
   }

   assignAgent(person?: CrmEventsCreateRequest["person"]) {
      const defaultPersonFields = this.config.eventsCollection.defaultPersonFields;
      return person?.assignedUserId ? {
         assignedUserId: person.assignedUserId
      } : {
         assignedTo: person?.assignedTo || defaultPersonFields.assignedTo
      };
   }

   assignTags(person?: CrmEventsCreateRequest["person"]) {
      const defaultPersonFields = this.config.eventsCollection.defaultPersonFields;
      return [...(defaultPersonFields.tags || []), ...(person?.tags || [])];
   }
}
