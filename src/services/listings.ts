import { container, inject, injectable } from "tsyringe";
import RepliersService from "./repliers.js";
import type { RplListingsCountDto, RplListingsLocationsDto, RplListingsSearchDto, RplListingsSimilarDto, RplListingsSingleDto, RplNlpDto } from "../validate/listings.js";
import { RplArea, RplFlatLocation, RplListingsLocationsResponse, RplListingsSingleResponse } from "./repliers/listings.js";
import { RplYesNo } from "../types/repliers.js";
import _debug from "debug";
import cached, { Cached } from "../lib/decorators/cached.js";
import { type AppConfig } from "../config.js";
import { scrubbed } from "./scrubber/listings.js";
import { ApiError } from "../lib/errors.js";
const config = container.resolve<AppConfig>("config");
const debug = _debug("repliers:services:listings");

// HELPERS
const allowedAreas = (areas: RplArea[]) => config.settings.locations.allow_all_areas ? areas : areas.filter(area => config.settings.locations.allowed_areas.includes(area.name.toLowerCase()));
@injectable()
export default class ListingsService {
   constructor(private repliers: RepliersService, @inject("config")
   private config: AppConfig) {}
   private ensureRequiredFields(params: {
      fields?: string;
   }) {
      let {
         fields = ""
      } = params;
      const fieldsArr = fields.split(",");
      fieldsArr.push("status", "permissions", "address", "duplicates", "boardId");
      fields = [...new Set(fieldsArr)].join(",");
      params.fields = fields;
      return params;
   }
   @scrubbed("listings")
   async search(params: RplListingsSearchDto) {
      const {
         app_state: _state,
         ...rplParams
      } = params;
      rplParams.displayInternetEntireListing = RplYesNo.Y;
      this.ensureRequiredFields(rplParams);
      const results = await this.repliers.listings.search({
         ...rplParams
      }, true);
      return results;

      // REMOVED this hack as we crashed on it at times
      // // this is a hack to remove statistics for listings that are not in the requested timeframe
      // return this.ensureStatisticsCorrect(results, params);
   }
   @cached("listings:count", config.cache.listingscount.ttl_ms)
   async count(params: RplListingsCountDto) {
      this.ensureRequiredFields(params);
      return await this.repliers.listings.search({
         ...params,
         listings: false
      }, true);
   }

   // REMOVED this hack as we crashed on it at times
   // private ensureStatisticsCorrect(results: RplListingsSearchResponse, requestParams: RplListingsSearchDto) {
   //    if (
   //       "statistics" in results &&
   //       "daysOnMarket" in results.statistics &&
   //       "mth" in results.statistics.daysOnMarket &&
   //       "minListDate" in requestParams
   //    ) {
   //       Object.keys(results.statistics.daysOnMarket.mth).forEach((date) => {
   //          if (dayjs(date, "YYYY-MM").isBefore(dayjs(requestParams.minListDate, "YYYY-MM-DD"))) {
   //             delete results.statistics.daysOnMarket.mth[date];
   //          }
   //       });
   //    }
   //    return results;
   // }

   @scrubbed("similar")
   async similar(params: RplListingsSimilarDto) {
      this.ensureRequiredFields(params);
      return this.repliers.listings.similar({
         ...params
      });
   }
   @scrubbed()
   async single(params: RplListingsSingleDto) {
      const listing = await this.repliers.listings.single({
         ...params
      });
      this.validateAvailability(listing);
      return listing;
   }
   private validateAvailability(listing: RplListingsSingleResponse) {
      const hiddenStatuses = this.config.settings.hide_unavailable_listings_statuses;
      const statusCode = this.config.settings.hide_unavailable_listings_http_code;
      const status = listing.lastStatus;
      if (hiddenStatuses.includes(status)) {
         debug(`[ListingsService: single]: %0 has status %1 and cannot be returned. HiddenStatuses are %2`, listing.mlsNumber, status, hiddenStatuses);
         throw new ApiError(`Not found. ${status}`, statusCode);
      }
   }
   private async fetchFlatPage(boardId: number, pageNum: number): Promise<{ locations: RplFlatLocation[]; numPages: number }> {
      let attempts = 0;
      while (true) {
         try {
            const res = await this.repliers.listings.flatLocations({
               boardId, resultsPerPage: 300, pageNum, state: 'TX', country: 'US'
            });
            debug("fetchFlatPage: page %d/%d, got %d locations", pageNum, res.numPages, res.locations.length);
            return { locations: res.locations, numPages: res.numPages };
         } catch (err: any) {
            const status = err?.status ?? err?.response?.status;
            if (status === 429 && attempts < 5) {
               const delay = Math.min(1000 * Math.pow(2, attempts), 16000);
               debug("fetchFlatPage: 429 on page %d, retry %d after %dms", pageNum, attempts + 1, delay);
               await new Promise(r => setTimeout(r, delay));
               attempts++;
            } else {
               throw err;
            }
         }
      }
   }
   private async fetchAllFlatLocations(boardId: number): Promise<RplFlatLocation[]> {
      // Fetch page 1 to discover numPages, then remaining pages concurrently (batches of 8)
      const first = await this.fetchFlatPage(boardId, 1);
      const all: RplFlatLocation[] = [...first.locations];
      const numPages = first.numPages;
      debug("fetchAllFlatLocations: %d total pages to fetch for boardId=%d", numPages, boardId);

      if (numPages > 1) {
         const remaining = Array.from({ length: numPages - 1 }, (_, i) => i + 2);
         const BATCH = 8;
         for (let i = 0; i < remaining.length; i += BATCH) {
            const batch = remaining.slice(i, i + BATCH);
            const results = await Promise.all(batch.map(p => this.fetchFlatPage(boardId, p)));
            for (const r of results) all.push(...r.locations);
         }
      }
      debug("fetchAllFlatLocations: fetched %d locations across %d pages", all.length, numPages);
      return all;
   }
   private buildLocationsFromFlat(flat: RplFlatLocation[], boardId: number): RplListingsLocationsResponse {
      // Filter to US/TX only. Also require non-empty area for cities/neighborhoods —
      // some Repliers records have country=US/state=TX but blank area/city (bad geocoding
      // on international listings). These get bucketed into area="" and pollute results.
      flat = flat.filter(loc =>
         loc.address.country === 'US' &&
         loc.address.state === 'TX' &&
         loc.name.trim() !== '' &&
         (loc.type === 'area' || loc.address.area.trim() !== '')
      );
      const areasMap = new Map<string, RplArea>();
      // Pass 1: areas
      for (const loc of flat) {
         if (loc.type === 'area' && !areasMap.has(loc.name)) {
            areasMap.set(loc.name, { name: loc.name, cities: [] });
         }
      }
      // Pass 2: cities
      for (const loc of flat) {
         if (loc.type === 'city') {
            if (!areasMap.has(loc.address.area)) {
               areasMap.set(loc.address.area, { name: loc.address.area, cities: [] });
            }
            const area = areasMap.get(loc.address.area)!;
            if (!area.cities.find(c => c.name === loc.name)) {
               area.cities.push({ name: loc.name, activeCount: 999, location: { lat: 0, lng: 0 }, neighborhoods: [] });
            }
         }
      }
      // Pass 3: neighborhoods
      for (const loc of flat) {
         if (loc.type === 'neighborhood') {
            if (!areasMap.has(loc.address.area)) {
               areasMap.set(loc.address.area, { name: loc.address.area, cities: [] });
            }
            const area = areasMap.get(loc.address.area)!;
            let city = area.cities.find(c => c.name === loc.address.city);
            if (!city) {
               city = { name: loc.address.city, activeCount: 999, location: { lat: 0, lng: 0 }, neighborhoods: [] };
               area.cities.push(city);
            }
            if (!city.neighborhoods.find(n => n.name === loc.name)) {
               city.neighborhoods.push({ name: loc.name, activeCount: 999, location: { lat: 0, lng: 0 } });
            }
         }
      }
      const filteredAreas = allowedAreas(Array.from(areasMap.values()));
      return {
         boards: [{
            boardId,
            name: 'HAR',
            updatedOn: new Date().toISOString().slice(0, 10),
            classes: [{ name: 'residential', areas: filteredAreas }] as unknown as RplListingsLocationsResponse['boards'][0]['classes']
         }]
      };
   }
   @cached("autosuggest:locations", config.cache.statswidget.ttl_ms)
   async locations(params: RplListingsLocationsDto): Promise<RplListingsLocationsResponse | Cached<RplListingsLocationsResponse>> {
      const {
         dropCoordinates,
         ...repliersParams
      } = params;
      // Always use the flat /locations endpoint — it includes country/state metadata
      // which lets us reliably filter to US/TX only. The grouped /listings/locations
      // endpoint returns international records that cannot be filtered by geography.
      const boardId = repliersParams.boardId ?? config.settings.locations.boardId;
      debug("[ListingsService: locations]: using flat /locations endpoint for boardId=%d", boardId);
      const flat = await this.fetchAllFlatLocations(boardId);
      return this.buildLocationsFromFlat(flat, boardId);
   }
   async nlp(params: RplNlpDto) {
      const result = await this.repliers.listings.nlp({
         ...params
      });
      if ("request" in result && "url" in result.request) {
         const params = new URL(result.request.url).searchParams;
         delete result.request.url;
         result.request.params = Object.fromEntries(params);
      }
      return result;
   }
}