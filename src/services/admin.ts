import { injectable } from "tsyringe";
import _ from "lodash";
import RepliersAgents from "./repliers/agents.js";
import { RplCreateAgentDto, RplUpdateAgentDto } from "../validate/admin.js";
import { normalizeEmail, normalizePhoneNumber } from "../lib/utils.js";
import { ApiError, ApiWarning } from "../lib/errors.js";
@injectable()
export default class AdminService {
   constructor(private readonly repliersAgents: RepliersAgents) {}
   async getAgents(params: { offset?: number; limit?: number }) {
      const repliersAgents = await this.repliersAgents.filter({
         status: true
      });
      const agents = repliersAgents.agents.map(agent => ({
         ...agent,
         repliers: [agent]
      }));
      return {
         offset: params.offset ?? 0,
         limit: params.limit ?? 10,
         total: agents.length,
         agents
      };
   }
   async createAgentsBatch(params: RplCreateAgentDto[]) {
      const resultArray = [];
      for (const agent of params) {
         const normPhone = normalizePhoneNumber(agent.phone);
         const normEmail = normalizeEmail(agent.email);
         if (!normPhone || !normEmail) {
            resultArray.push("Phone or email is missing");
            continue;
         }
         const extAgent = {
            ...agent,
            phone: normPhone,
            email: normEmail,
            data: {
               ...agent?.data,
               lastSyncOn: new Date().toISOString()
            }
         };
         try {
            const resp = await this.repliersAgents.create(extAgent);
            resultArray.push(resp);
         } catch (error) {
            resultArray.push(this.stringifyError(error));
         }
      }
      return resultArray;
   }
   stringifyError(error: unknown) {
      let status = "UNKNOWN ERROR";
      if (error instanceof ApiError) {
         status = JSON.stringify({
            error: error.message,
            info: error.opts
         });
      } else if (error instanceof Error || error instanceof ApiWarning) {
         status = JSON.stringify({
            error: error.message
         });
      }
      return status;
   }
   async updateAgent(params: RplUpdateAgentDto) {
      const extParams = {
         ...params,
         phone: normalizePhoneNumber(params.phone)!,
         data: {
            ...params?.data,
            lastSyncOn: new Date().toISOString()
         }
      };
      return this.repliersAgents.update(extParams);
   }
}