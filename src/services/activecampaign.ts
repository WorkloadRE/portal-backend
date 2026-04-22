import { injectable, inject } from "tsyringe";
import _debug from "debug";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { BossEventsCreateRequest } from "./boss.js";

const debug = _debug("repliers:services:activecampaign");

/**
 * Tag a string -> AC-safe format.
 * "Spring" -> "Spring"
 * "the woodlands" -> "The-Woodlands"
 * "Gleannloch Farms / Champions" -> "Gleannloch-Farms-Champions"
 */
function slugifyTagSegment(input: string): string {
   return input
      .replace(/[\/\\]+/g, " ")
      .replace(/[^a-zA-Z0-9\s-]/g, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join("-");
}

interface ACContactSyncBody {
   contact: {
      email: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
   };
}

interface ACContactSyncResponse {
   contact: {
      id: string;
      email: string;
   };
}

interface ACTagCreateResponse {
   tag: {
      id: string;
      tag: string;
      tagType: "contact" | "template";
   };
}

interface ACTagsListResponse {
   tags: Array<{ id: string; tag: string; tagType: string }>;
}

@injectable()
export default class ActiveCampaignService {
   private tagIdCache = new Map<string, string>();

   constructor(
      @inject("config") private config: AppConfig,
      @inject("logger.global") private logger: Logger
   ) {}

   /**
    * Fires an event to ActiveCampaign. This is the PRIMARY lead ingress for
    * Bruno Fine Properties. Safe to call in parallel with BossService — both
    * accept the same BossEventsCreateRequest shape.
    *
    * Fire-and-forget style: errors are logged but never thrown, so a flaky
    * AC API does not break user registration or saved searches.
    */
   async pushEvent(params: Partial<BossEventsCreateRequest>): Promise<void> {
      if (!this.config.activecampaign?.enabled) {
         debug("[pushEvent] AC disabled; skipping");
         return;
      }

      const email = params.person?.emails?.[0]?.value;
      if (!email) {
         debug("[pushEvent] no email on person; skipping AC push");
         return;
      }

      try {
         const contactId = await this.upsertContact({
            email,
            firstName: params.person?.firstName,
            lastName: params.person?.lastName,
            phone: params.person?.phones?.[0]?.value
         });

         if (this.config.activecampaign.list_id) {
            await this.addContactToList(contactId, this.config.activecampaign.list_id);
         }

         const tags = this.computeTags(params);
         for (const tag of tags) {
            try {
               const tagId = await this.ensureTag(tag);
               await this.applyTagToContact(contactId, tagId);
            } catch (err) {
               this.logger.warn({ err, tag, contactId }, "[AC] failed to apply tag");
            }
         }

         debug("[pushEvent] ok contactId=%s tags=%O", contactId, tags);
      } catch (err) {
         this.logger.error({ err, email }, "[AC] pushEvent failed");
      }
   }

   /**
    * Compute the full tag set for an event: event-type tags (Registration,
    * "Saved Property Search"), location tags (City-Spring-TX,
    * Subdivision-Gleannloch-Farms), and the mutually-exclusive price bucket.
    * Always appends Source-BrunoFineProperties-IDX.
    */
   computeTags(params: Partial<BossEventsCreateRequest>): string[] {
      const out = new Set<string>();
      const state = this.config.activecampaign?.default_state_code || "TX";

      // Carry through whatever tags the selector provided (e.g. "Registration")
      for (const t of params.person?.tags || []) {
         if (t) out.add(t);
      }

      // Event-type tag
      if (params.type) {
         out.add(`Event-${slugifyTagSegment(params.type)}`);
      }

      const search = params.propertySearch;

      // Cities — can be comma-separated if multiple
      if (search?.city) {
         for (const city of search.city.split(",").map(s => s.trim()).filter(Boolean)) {
            const slug = slugifyTagSegment(city);
            if (slug) out.add(`City-${slug}-${state}`);
         }
      }

      // Subdivisions / neighborhoods — can be comma-separated
      if (search?.neighborhood) {
         for (const sub of search.neighborhood.split(",").map(s => s.trim()).filter(Boolean)) {
            const slug = slugifyTagSegment(sub);
            if (slug) out.add(`Subdivision-${slug}`);
         }
      }

      // Property-level fallback: individual listing page view / favorite
      if (params.property?.city) {
         const slug = slugifyTagSegment(params.property.city);
         if (slug) out.add(`City-${slug}-${state}`);
      }

      // Price bucket (mutually exclusive)
      out.add(this.bucketPrice(params));

      // Map fallback — custom polygon searches have no city/subdivision
      if (
         !search?.city && !search?.neighborhood &&
         !params.property?.city && params.type &&
         (params.type === "Saved Property Search" || params.type === "Property Search")
      ) {
         out.add("Search-Custom-Polygon");
      }

      // Every lead gets the source tag
      out.add("Source-BrunoFineProperties-IDX");

      return [...out];
   }

   private bucketPrice(params: Partial<BossEventsCreateRequest>): string {
      const search = params.propertySearch;
      const property = params.property;

      // Rentals / lease: search.type or property.forRent
      const isRental =
         property?.forRent === true ||
         (search?.type && /(lease|rent)/i.test(search.type));
      if (isRental) return "Price-Rental";

      // Prefer search.maxPrice (intent signal) over property.price
      const price = search?.maxPrice ?? property?.price ?? search?.minPrice;
      if (!price || price <= 0) return "Price-Unknown";

      if (price < 250000) return "Price-Under-250K";
      if (price < 500000) return "Price-250K-500K";
      if (price < 1000000) return "Price-500K-1M";
      return "Price-1M-Plus";
   }

   // ---------- AC API plumbing ----------

   private async acFetch<T>(
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      body?: unknown
   ): Promise<T> {
      const url = `${this.config.activecampaign.base_url.replace(/\/$/, "")}${path}`;
      const res = await fetch(url, {
         method,
         headers: {
            "Api-Token": this.config.activecampaign.api_key,
            "Content-Type": "application/json",
            Accept: "application/json"
         },
         body: body ? JSON.stringify(body) : undefined
      });
      if (!res.ok) {
         const txt = await res.text().catch(() => "");
         throw new Error(`AC ${method} ${path} -> ${res.status}: ${txt.slice(0, 500)}`);
      }
      return (await res.json()) as T;
   }

   /**
    * Upsert via /contact/sync — AC's first-party way to create-or-update
    * by email. Idempotent, returns the contact ID either way.
    */
   async upsertContact(c: {
      email: string;
      firstName?: string | undefined;
      lastName?: string | undefined;
      phone?: string | undefined;
   }): Promise<string> {
      const body: ACContactSyncBody = {
         contact: {
            email: c.email,
            ...(c.firstName && { firstName: c.firstName }),
            ...(c.lastName && { lastName: c.lastName }),
            ...(c.phone && { phone: c.phone })
         }
      };
      const r = await this.acFetch<ACContactSyncResponse>("POST", "/api/3/contact/sync", body);
      return r.contact.id;
   }

   /**
    * Add contact to a list. status=1 means "active subscriber".
    */
   async addContactToList(contactId: string, listId: string | number): Promise<void> {
      await this.acFetch("POST", "/api/3/contactLists", {
         contactList: {
            list: String(listId),
            contact: contactId,
            status: 1
         }
      });
   }

   /**
    * Ensure a tag exists in AC and return its ID. Cached in-process.
    */
   async ensureTag(tagName: string): Promise<string> {
      const cached = this.tagIdCache.get(tagName);
      if (cached) return cached;

      // Try fetch-by-name first
      const existing = await this.acFetch<ACTagsListResponse>(
         "GET",
         `/api/3/tags?search=${encodeURIComponent(tagName)}`
      );
      const hit = existing.tags?.find(t => t.tag === tagName);
      if (hit) {
         this.tagIdCache.set(tagName, hit.id);
         return hit.id;
      }

      // Create it
      const created = await this.acFetch<ACTagCreateResponse>("POST", "/api/3/tags", {
         tag: {
            tag: tagName,
            tagType: "contact",
            description: "auto-created by portal-backend"
         }
      });
      this.tagIdCache.set(tagName, created.tag.id);
      return created.tag.id;
   }

   /**
    * Apply a tag to a contact. AC returns 422 if the tag is already applied —
    * we swallow that case silently since the end state matches intent.
    */
   async applyTagToContact(contactId: string, tagId: string): Promise<void> {
      try {
         await this.acFetch("POST", "/api/3/contactTags", {
            contactTag: {
               contact: contactId,
               tag: tagId
            }
         });
      } catch (err) {
         if (err instanceof Error && /422/.test(err.message)) {
            debug("[applyTag] already applied contact=%s tag=%s", contactId, tagId);
            return;
         }
         throw err;
      }
   }
}
