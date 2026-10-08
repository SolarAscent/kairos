import type { ApiClient } from "./client";
import { getCaptureImageCacheEpoch, readCaptureImage } from "./capture-image";

/** Per-page owned native files, shared reads, and bounded download concurrency. */
export class ImageGallery {
  private owner: string | null;
  private epoch = getCaptureImageCacheEpoch();
  private generation = 0;
  private cache = new Map<string, NonNullable<Awaited<ReturnType<typeof readCaptureImage>>>>();
  private flights = new Map<string, ReturnType<typeof readCaptureImage>>();
  constructor(private readonly client: ApiClient) {
    this.owner = client.userId;
  }
  clear() {
    this.generation++;
    this.cache.forEach((image) => image.dispose());
    this.cache.clear();
    this.flights.clear();
    this.owner = this.client.userId;
    this.epoch = getCaptureImageCacheEpoch();
  }
  private sync() {
    if (this.owner !== this.client.userId || this.epoch !== getCaptureImageCacheEpoch())
      this.clear();
  }
  path(id: string | null | undefined) {
    this.sync();
    return id ? (this.cache.get(id)?.path ?? "") : "";
  }
  async read(id: string) {
    this.sync();
    if (!this.owner) return null;
    const cached = this.cache.get(id);
    if (cached) return cached;
    const pending = this.flights.get(id);
    if (pending) return pending;
    const generation = this.generation,
      owner = this.owner;
    const flight = readCaptureImage(this.client, id).then((image) => {
      if (
        generation !== this.generation ||
        owner !== this.client.userId ||
        this.epoch !== getCaptureImageCacheEpoch()
      ) {
        image?.dispose();
        return null;
      }
      if (image) this.cache.set(id, image);
      return image;
    });
    this.flights.set(id, flight);
    try {
      return await flight;
    } finally {
      if (this.flights.get(id) === flight) this.flights.delete(id);
    }
  }
  invalidate(id: string) {
    this.cache.get(id)?.dispose();
    this.cache.delete(id);
  }
  async load(
    ids: string[],
    apply: (id: string, path: string) => void,
    failed: (id: string) => void = () => {},
  ) {
    this.sync();
    const generation = this.generation,
      owner = this.owner;
    const pending = [...new Set(ids)];
    const worker = async () => {
      while (pending.length && generation === this.generation && owner === this.client.userId) {
        const id = pending.shift()!;
        try {
          const image = await this.read(id);
          if (generation === this.generation) {
            if (image) apply(id, image.path);
            else failed(id);
          }
        } catch {
          if (generation === this.generation && owner === this.client.userId) failed(id);
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }
}
