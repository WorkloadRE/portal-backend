import type { AppConfig } from "config.js";
import { instanceCachingFactory } from "tsyringe";
import { Middleware } from "koa";
import EventsCollectionService, { type NotesCollectionPropertiesSelector, type EventsCollectionPropertiesSelector } from "../../services/eventsCollection/eventsCollection.js";
import emptyMiddleware from "../../lib/middleware/empty.js";
type EventsCollectionMiddlewareOptions = {
   allowIncognito: boolean;
};
export interface EventsCollectionMiddlewareFactoryProps {
   selector: EventsCollectionPropertiesSelector;
   notesSelector?: NotesCollectionPropertiesSelector;
   options?: EventsCollectionMiddlewareOptions;
}
export type EventsCollectionMiddleware = (props: EventsCollectionMiddlewareFactoryProps) => Middleware;
export default {
   token: "middleware.eventsCollection",
   useFactory: instanceCachingFactory(container => {
      const config = container.resolve<AppConfig>("config");
      const middlewareFactory: EventsCollectionMiddleware = ({
         selector,
         notesSelector,
         options: {
            allowIncognito
         } = {}
      }) => {
         return (ctx, next) => {
            const eventsCollectionService = ctx.state.container.resolve(EventsCollectionService);
            if (allowIncognito || ctx.state['user']) {
               // Fire-and-forget. The .catch() is non-optional: a thrown
               // selector becomes an unhandled rejection under Node 20 and
               // can terminate the process. We log and swallow.
               selector(ctx)
                  .then(props => props && eventsCollectionService.eventsCreate(props))
                  .catch(err => console.error("[eventsCollection] selector error", err));
               if (notesSelector) {
                  notesSelector(ctx)
                     .then(props => props && eventsCollectionService.noteCreate(props))
                     .catch(err => console.error("[eventsCollection] notesSelector error", err));
               }
            }
            next();
         };
      };
      // If AC is not configured, return empty middleware
      const isEnabled = !!(
         config.activecampaign.enabled &&
         config.activecampaign.base_url &&
         config.activecampaign.api_key
      );
      return isEnabled ? middlewareFactory : () => emptyMiddleware;
   })
};