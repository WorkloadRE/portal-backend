import { injectable } from "tsyringe";
import _debug from "debug";
import { agentsCreateClientSchema } from "../../../validate/agent.js";
import BaseEventCollectionSelector, { EventsCollectionPropertiesSelector } from "./baseEventCollectionSelector.js";
const debug = _debug("repliers:services:SelectAgentClientRegistrationParams");
@injectable()
export default class SelectAgentClientRegistrationParams extends BaseEventCollectionSelector {
   select: EventsCollectionPropertiesSelector = async ctx => {
      const {
         error,
         value
      } = agentsCreateClientSchema.validate({
         ...ctx.request.body,
         status: true,
         agentId: ctx.state["user"].sub
      });
      if (error) {
         debug("[SelectAgentClientRegistrationParams] error %O", error);
         return null;
      }
      const defaults = await this.getDefaults(ctx);
      const agentProps = await this.getAgent(value.agentId);
      return {
         ...defaults,
         person: {
            customAuthType: "Agent",
            firstName: value.fname,
            lastName: value.lname,
            emails: [{
               value: value.email,
               type: "main"
            }],
            phones: [{
               value: value.phone,
               type: "main"
            }],
            tags: ["Registration"],
            ...agentProps
         },
         type: "Registration",
         status: true
      };
   };
}