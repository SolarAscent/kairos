import "./lib/zod-runtime";
import { createSessionServices } from "./lib/session";

App({ globalData: createSessionServices() });
