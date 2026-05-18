/**
 * CRM event types — originally modeled after Follow Up Boss, now used as
 * an internal event shape that the eventsCollection layer understands.
 *
 * These types are consumed by:
 *  - EventsCollectionService (dispatches to ActiveCampaign)
 *  - BaseEventCollectionSelector (builds event payloads)
 *  - Individual event selectors (registration, estimate, etc.)
 *
 * `tsconfig` has `exactOptionalPropertyTypes: true`, so every optional field
 * here is explicitly typed `T | undefined`. That lets selector code pass
 * `{ field: maybeUndefinedValue }` without TS rejecting it.
 */

export interface CrmEventPerson {
   firstName?: string | undefined;
   lastName?: string | undefined;
   emails?: Array<{ value: string | undefined; type?: string | undefined }> | undefined;
   phones?: Array<{ value: string | undefined; type?: string | undefined }> | undefined;
   tags?: string[] | undefined;
   assignedTo?: string | undefined;
   assignedUserId?: number | undefined;
   [key: string]: unknown; // custom fields
}

export interface CrmEventProperty {
   street?: string | undefined;
   city?: string | undefined;
   state?: string | undefined;
   code?: string | undefined;
   mlsNumber?: string | undefined;
   price?: number | undefined;
   forRent?: boolean | undefined;
   type?: string | undefined;
   bedrooms?: string | undefined;
   bathrooms?: string | undefined;
   area?: string | undefined;
   url?: string | undefined;
}

export interface CrmEventPropertySearch {
   type?: string | undefined;
   neighborhood?: string[] | undefined;
   city?: string | undefined;
   state?: string | undefined;
   minPrice?: number | undefined;
   maxPrice?: number | undefined;
   minBedrooms?: number | undefined;
   maxBedrooms?: number | undefined;
   minBathrooms?: number | undefined;
   maxBathrooms?: number | undefined;
}

export interface CrmEventsCreateRequest {
   source?: string | undefined;
   type?: string | undefined;
   person?: CrmEventPerson | undefined;
   property?: CrmEventProperty | undefined;
   propertySearch?: CrmEventPropertySearch | undefined;
   occurredAt?: string | undefined;
   pageReferrer?: string | undefined;
   status?: boolean | undefined;
   ignoreDefaultTags?: boolean | undefined;
   // Auxiliary fields used by some selectors but not directly modeled above.
   message?: string | undefined;
   description?: string | undefined;
   pageUrl?: string | undefined;
}

export interface CrmNoteCreateRequest {
   personId?: number | string | undefined;
   clientId?: number | string | undefined;
   subject: string;
   body: string;
   isHtml?: boolean | undefined;
}
