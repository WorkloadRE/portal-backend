// import crypto from "crypto";
import { inject, injectable } from "tsyringe";
import RepliersClients from "./repliers/clients.js";
import RepliersEstimate from "./repliers/estimate.js";
import RepliersMessages from "./repliers/messages.js";
import { AgentCreateClientDto, AgentCreateEstimateDto, AgentCreateMessageDto, AgentGetClientsDto, AgentGetEstimateDto, AgentGetMessagesDto, AgentSendEstimateDto, AgentUpdateClientDto, AgentUpdateEstimateDto } from "../validate/agent.js";
import { type AppConfig } from "../config.js";
import { calcSignature } from "../lib/utils.js";
@injectable()
export default class AgentService {
   constructor(private repliersClients: RepliersClients, private repliersEstimates: RepliersEstimate, private repliersMessages: RepliersMessages,
   @inject("config")
   private config: AppConfig) {}
   async checkSignature(clientId: string, signature: string | string[] | undefined): Promise<[boolean, number?]> {
      if (!signature) {
         return [true];
      }
      const expectedSignature = calcSignature(clientId, this.config.auth.agents_signature_salt);
      if (signature === expectedSignature) {
         const client = await this.repliersClients.get(parseInt(clientId));
         return [true, client.agentId];
      }
      return [false];
   }
   async createClient(params: AgentCreateClientDto) {
      return this.repliersClients.create({
         ...params
      });
   }
   async createEstimate(params: AgentCreateEstimateDto) {
      return this.repliersEstimates.add({
         ...params
      });
   }
   async createMessage(params: AgentCreateMessageDto) {
      return this.repliersMessages.send({
         sender: "agent",
         agentId: params.agentId,
         clientId: params.clientId,
         content: params.content
      });
   }
   async getEstimate(params: AgentGetEstimateDto) {
      return this.repliersEstimates.get({
         ...params
      });
   }
   async sendEstimate(params: AgentSendEstimateDto) {
      return this.repliersEstimates.patch({
         estimateId: params.estimateId,
         sendEmailNow: true
      });
   }
   async getMessages(params: AgentGetMessagesDto) {
      return this.repliersMessages.get({
         ...params
      });
   }
   async checkClient(clientId: string, agentId: string) {
      const res = await this.getClients({
         clientId: parseInt(clientId),
         agentId: parseInt(agentId),
         showSavedSearches: false,
         showEstimates: false
      });
      return res.clients.at(0)?.agentId.toString() === agentId;
   }
   async getClients(params: AgentGetClientsDto) {
      return this.repliersClients.filter({
         ...params
      });
   }
   async updateClient(params: AgentUpdateClientDto) {
      return this.repliersClients.update({
         ...params
      });
   }
   async updateEstimate(params: Omit<AgentUpdateEstimateDto, "agentId">) {
      return this.repliersEstimates.patch({
         ...params
      });
   }
}