import Router from "@koa/router";
const router = new Router({
   prefix: "/webhooks"
});
// Boss/FUB webhooks removed — ActiveCampaign uses push (we call their API)
export default router;