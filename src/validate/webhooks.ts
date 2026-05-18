import Joi from "joi";

// Boss/FUB webhooks removed — this file kept for future webhook validation
export interface WebhooksEventDto {
   eventId: string;
   eventCreated: string;
   event: string;
   resourceIds: number[];
   uri: string;
   correlationId: string;
}

export const webhooksEventSchema = Joi.object<WebhooksEventDto>().unknown();