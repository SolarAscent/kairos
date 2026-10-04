import { z } from "zod";

// Set this before importing contracts: Zod caches JIT eligibility when schemas
// are created, and WeChat may return a non-callable object from Function.
z.config({ jitless: true });
