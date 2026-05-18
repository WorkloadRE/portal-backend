import { Context } from "koa";
import { CrmEventPerson, CrmEventProperty, CrmEventPropertySearch, CrmEventsCreateRequest } from "../../../types/crm-events.js";
import RepliersService from "../../repliers.js";
import { inject, injectable } from "tsyringe";
import { type AppConfig } from "config.js";
import { listingsSingleSchema } from "../../../validate/listings.js";
import _debug from "debug";
import { RplListingsSingleResponse } from "../../repliers/listings.js";
import { RplType } from "../../../types/repliers.js";
import { RplSearchesCreateDto } from "../../repliers/searches.js";
import RepliersAgents from "../../repliers/agents.js";
import { RplEstimateAddDto, RplEstimateCore } from "../../../services/repliers/estimate.js";
const debug = _debug("repliers:services:BaseEventCollectionSelector");
export type EventsCollectionPropertiesSelector = (ctx: Context) => Promise<CrmEventsCreateRequest | null>;
@injectable()
export default class BaseEventCollectionSelector {
   constructor(protected repliers: RepliersService, protected agentsService: RepliersAgents, @inject("config")
   protected config: AppConfig) {}
   async getPerson(email: string, defaults: Partial<CrmEventPerson> = {}): Promise<CrmEventPerson> {
      return {
         ...defaults,
         emails: [{
            value: email,
            type: "main"
         }]
      };
   }
   async getDefaults(ctx: Context) {
      return {
         pageReferrer: ctx.request.headers.referer,
         occurredAt: new Date().toISOString(),
         person: await this.getPerson(ctx.state["user"]?.email)
      };
   }
   buildPropertyUrl(mlsNumber: number | string, boardId?: number) {
      if (boardId) {
         return this.config.eventsCollection.propertyUrl.replace("[MLS_NUMBER]", mlsNumber.toString()).replace("[BOARD_ID]", boardId.toString());
      }
      return this.config.eventsCollection.propertyUrl.replace("[MLS_NUMBER]", mlsNumber.toString()).replace("boardId=[BOARD_ID]", "");
   }
   mapRplPropertyToCrm(property: RplListingsSingleResponse): CrmEventProperty {
      return {
         street: this.addressShort(property.address),
         city: property.address?.["city"] as string,
         state: property.address?.["state"] as string,
         code: property.address?.["zip"] as string,
         mlsNumber: property?.["mlsNumber"],
         price: Number(property?.["listPrice"]),
         forRent: property?.["type"]?.toLowerCase() === RplType.Lease,
         type: property?.["type"],
         bedrooms: property?.["details"]?.["numBedrooms"] as string,
         bathrooms: property?.["details"]?.["numBathrooms"] as string
      };
   }
   async getProperty(mlsNumber: string, boardId?: number): Promise<CrmEventProperty> {
      const pageUrl = this.buildPropertyUrl(mlsNumber, boardId);
      const defaults = {
         mlsNumber,
         url: pageUrl
      };
      const payload = {
         mlsNumber,
         boardId: boardId || this.config.eventsCollection.defaultBoardId
      };
      const {
         error,
         value
      } = listingsSingleSchema.validate(payload);
      if (error) {
         debug("[getProperty] error %O", error);
         return defaults;
      }
      try {
         const data = await this.repliers.listings.single({
            ...value
         });
         return {
            ...defaults,
            ...this.mapRplPropertyToCrm(data)
         };
      } catch (err) {
         debug("[getProperty] error %O", err);
         return defaults;
      }
   }
   addressShort(address: RplListingsSingleResponse["address"]) {
      const {
         streetNumber,
         streetName,
         streetSuffix,
         unitNumber
      } = address;
      const formattedUnitNumber = unitNumber ? `#${unitNumber} - ` : "";
      const formattedStreetNumber = this.sanitizedStreetNumber(streetNumber as string);
      return `${formattedUnitNumber + formattedStreetNumber} ${this.capitalize(streetName as string)} ${streetSuffix}`;
   }
   sanitizedStreetNumber(streetNumber: string) {
      if (streetNumber === "00" || streetNumber === "0" || !streetNumber) return "";
      return streetNumber;
   }
   capitalize(str: string) {
      return str.toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
   }
   mapRplPropertySearchToCrm(propertySearch: RplSearchesCreateDto): CrmEventPropertySearch {
      return {
         // @ts-expect-error bad type? class is an array
         type: propertySearch["class"].join(","),
         // CrmEventPropertySearch models neighborhoods as string[]. The Repliers
         // DTO actually validates this as string[] (see validate/searches.ts),
         // but some upstream callers historically passed a comma-separated
         // string, so accept either shape defensively.
         neighborhood: (() => {
            const raw = propertySearch["neighborhoods"];
            if (!raw) return undefined;
            if (Array.isArray(raw)) return raw.filter(Boolean);
            return String(raw).split(",").map(s => s.trim()).filter(Boolean);
         })(),
         city: propertySearch["cities"]?.join(","),
         state: propertySearch["areas"]?.join(","),
         minPrice: propertySearch["minPrice"],
         maxPrice: propertySearch["maxPrice"],
         minBedrooms: propertySearch["minBeds"],
         maxBedrooms: propertySearch["maxBeds"],
         minBathrooms: propertySearch["minBaths"],
         maxBathrooms: propertySearch["maxBaths"]
      };
   }
   async getAgent(agentId: number): Promise<{
      assignedUserId?: number;
      assignedTo?: string;
   }> {
      const agent = await this.agentsService.get(agentId);
      if (agent.externalId) {
         return {
            assignedUserId: +agent.externalId
         };
      }
      const agentName = `${agent.fname} ${agent.lname}`;
      return { assignedTo: agentName };
   }
   getSellIntentionTag(estimate: RplEstimateAddDto): string[] {
      const tagsMap = {
         asap: "Sell ASAP",
         "3months": "Sell in 1-3 Months",
         "6months": "Sell in 3-6 Months",
         "12months": "Sell in 6-12 Months",
         other: "Sell just Curious"
      };
      const sellingTimeline = estimate.data?.salesIntentions?.sellingTimeline as keyof typeof tagsMap;
      const intentionTag = tagsMap[sellingTimeline];
      return intentionTag ? [intentionTag] : [];
   }
   getEstimateUrl(responseBody: unknown) {
      if (this.isEstimateModel(responseBody)) {
         const useUlid = this.config.eventsCollection.estimateUrl.includes("[ULID]");
         const value = useUlid ? responseBody.ulid : responseBody.estimateId.toString();
         const key = useUlid ? "[ULID]" : "[ESTIMATE_ID]";
         return this.config.eventsCollection.estimateUrl.replace(key, value || "");
      }
      return null;
   }
   isEstimateModel(body: unknown): body is RplEstimateCore {
      return typeof body === "object" && body !== null && "estimate" in body;
   }
   stringifyIfSet(value?: string | number | null): string | undefined {
      return typeof value === "undefined" || value === null ? undefined : value.toString();
   }
   formatPrice(price?: number): string {
      if (typeof price !== "number" || isNaN(price)) {
         return "unknown price";
      }
      return new Intl.NumberFormat("en-US", {
         style: "currency",
         currency: "USD",
         notation: "compact"
      }).format(price);
   }
}