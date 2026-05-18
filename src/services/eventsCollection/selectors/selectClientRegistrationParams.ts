import { injectable } from "tsyringe";
import _debug from "debug";
import BaseEventCollectionSelector from "./baseEventCollectionSelector.js";
import { RplClientsClient } from "../../../services/repliers/clients.js";
import { CrmEventsCreateRequest } from "../../../types/crm-events.js";
const debug = _debug("repliers:services:SelectClientRegistrationParams");
@injectable()
export default class SelectClientRegistrationParams extends BaseEventCollectionSelector {
   select = async ({
      user,
      provider,
      referer
   }: {
      user: RplClientsClient;
      provider: string;
      referer?: string;
   }): Promise<CrmEventsCreateRequest | null> => {
      if (!user) {
         debug("[SelectClientRegistrationParams] user is not defined");
         return null;
      }
      return {
         person: {
            customAuthType: provider,
            firstName: user.fname,
            lastName: user.lname,
            emails: [{
               value: user.email,
               type: "main"
            }],
            phones: user.phone ? [{
               value: user.phone,
               type: "main"
            }] : [],
            tags: ["Registration"]
         },
         type: "Registration",
         occurredAt: new Date().toISOString(),
         pageReferrer: referer
      };
   };
}