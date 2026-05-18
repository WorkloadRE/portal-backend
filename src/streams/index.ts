// NATS streams registry. Empty for now — the only active stream was the
// Follow Up Boss people sync, which was removed with the rest of FUB.
// `nats.ts` and `worker.ts` import this and read `.stream`, `.consumer`, and
// `.worker` off each entry, so we declare the structural shape explicitly
// rather than let the empty array infer `never[]`.

import type { ConsumerConfig, StreamConfig } from "@nats-io/jetstream";

// tsyringe's `InjectionToken` widens to `constructor<T>` which is
// `new (...args: any[]) => T`, so the worker constructor's `args` must
// be `any[]` (not `never[]`) to satisfy `container.resolve(WorkerClass)`.
export type StreamSpec = {
   stream: StreamConfig;
   consumer: ConsumerConfig;
   // eslint-disable-next-line @typescript-eslint/no-explicit-any
   worker: new (...args: any[]) => { process(msg: unknown): Promise<unknown> };
};

const streams: StreamSpec[] = [];
export default streams;
