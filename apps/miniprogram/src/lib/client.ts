import "./zod-runtime";
import { z } from "zod";
import {
  authResponseSchema,
  logoutResponseSchema,
  successEnvelope,
  type AuthResponse,
} from "@life/contracts";

export type ClientConfig = {
  environment: "develop" | "staging" | "production";
  appId: string;
  apiBaseUrl: string;
  loginMode: "wechat" | "mock";
  appVersion: string;
};
export interface ClientPlatform {
  send(input: {
    url: string;
    method: "GET" | "POST";
    data?: unknown;
    headers: Record<string, string>;
  }): Promise<{ status: number; body: unknown }>;
  login(): Promise<string>;
  uuid(): Promise<string>;
  read(key: string): unknown;
  write(key: string, value: unknown): void;
  remove(key: string): void;
  envVersion(): string;
  sdkVersion(): string;
}
export class ClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
    public readonly requestId?: string,
  ) {
    super(code);
  }
}
const storedSessionSchema = authResponseSchema.extend({ expiresAt: z.number() });
const errorSchema = z.object({
  error: z.object({ code: z.string(), request_id: z.string().nullable().optional() }),
});
type Session = z.infer<typeof storedSessionSchema>;

export class ApiClient {
  private session: Session | null = null;
  private refreshFlight: Promise<void> | null = null;
  private loginFlight: Promise<void> | null = null;
  private epoch = 0;
  readonly storageKey: string;
  constructor(
    readonly config: ClientConfig,
    private readonly platform: ClientPlatform,
    private readonly onSession: (userId: string | null) => void = () => {},
  ) {
    this.storageKey = `kairos:${config.environment}:${config.appId}:${config.apiBaseUrl}`;
    const parsed = storedSessionSchema.safeParse(platform.read(this.storageKey));
    if (parsed.success) this.session = parsed.data;
    this.onSession(this.session?.userId ?? null);
  }
  get userId() {
    return this.session?.userId ?? null;
  }
  newKey() {
    return this.platform.uuid();
  }
  private save(value: AuthResponse, epoch: number) {
    if (epoch !== this.epoch) throw new ClientError("SESSION_CHANGED");
    const session = { ...value, expiresAt: Date.now() + value.expiresIn * 1000 };
    try {
      this.platform.write(this.storageKey, session);
    } catch {
      throw new ClientError("STORAGE_UNAVAILABLE");
    }
    this.session = session;
    this.onSession(value.userId);
  }
  clear() {
    this.epoch++;
    this.session = null;
    this.refreshFlight = null;
    this.loginFlight = null;
    try {
      this.platform.remove(this.storageKey);
    } finally {
      this.onSession(null);
    }
  }
  private async raw<T>(
    path: string,
    schema: z.ZodType<T>,
    method: "GET" | "POST",
    data?: unknown,
    token?: string,
    key?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-app-version": this.config.appVersion,
      "x-platform": "MINIPROGRAM",
      "x-sdk-version": this.platform.sdkVersion(),
      "x-trace-id": await this.newKey(),
    };
    if (token) headers.authorization = "Bearer " + token;
    if (key) headers["X-Idempotency-Key"] = key;
    let response;
    try {
      response = await this.platform.send({
        url: this.config.apiBaseUrl + path,
        method,
        data,
        headers,
      });
    } catch {
      throw new ClientError("NETWORK_UNAVAILABLE");
    }
    if (response.status < 200 || response.status >= 300) {
      const parsed = errorSchema.safeParse(response.body);
      throw new ClientError(
        parsed.success ? parsed.data.error.code : "REQUEST_FAILED",
        response.status,
        parsed.success ? (parsed.data.error.request_id ?? undefined) : undefined,
      );
    }
    const parsed = successEnvelope(schema).safeParse(response.body);
    if (!parsed.success) throw new ClientError("RESPONSE_INVALID");
    return parsed.data.data;
  }
  login(): Promise<void> {
    if (this.loginFlight) return this.loginFlight;
    // A new login supersedes requests and refreshes from the previous session.
    const epoch = ++this.epoch;
    this.refreshFlight = null;
    const flight = (async () => {
      if (
        this.config.loginMode === "mock" &&
        (this.config.environment !== "develop" || this.platform.envVersion() !== "develop")
      )
        throw new ClientError("MOCK_LOGIN_FORBIDDEN");
      if (this.config.loginMode === "wechat" && this.config.appId === "touristappid")
        throw new ClientError("WECHAT_APP_ID_REQUIRED");
      const installationKey = this.storageKey + ":installation";
      const existing = this.platform.read(installationKey);
      const installationId = typeof existing === "string" ? existing : await this.newKey();
      this.platform.write(installationKey, installationId);
      let code: string;
      if (this.config.loginMode === "mock") code = "mini:" + installationId;
      else {
        try {
          code = await this.platform.login();
        } catch {
          throw new ClientError("WECHAT_LOGIN_FAILED");
        }
      }
      const result = await this.raw("/v1/auth/wechat/login", authResponseSchema, "POST", {
        code,
        clientInstallationId: installationId,
      });
      this.save(result, epoch);
    })().finally(() => {
      if (this.loginFlight === flight) this.loginFlight = null;
    });
    this.loginFlight = flight;
    return flight;
  }
  private refresh(): Promise<void> {
    if (this.refreshFlight) return this.refreshFlight;
    const epoch = this.epoch;
    const session = this.session;
    if (!session) return Promise.reject(new ClientError("LOGIN_REQUIRED"));
    const flight = (async () => {
      try {
        const result = await this.raw("/v1/auth/refresh", authResponseSchema, "POST", {
          refreshToken: session.refreshToken,
        });
        this.save(result, epoch);
      } catch (error) {
        // A lost response may already have rotated the server token. Re-login; never replay it.
        if (epoch === this.epoch) this.clear();
        throw error instanceof ClientError && error.code === "SESSION_CHANGED"
          ? error
          : new ClientError("LOGIN_REQUIRED");
      }
    })().finally(() => {
      if (this.refreshFlight === flight) this.refreshFlight = null;
    });
    this.refreshFlight = flight;
    return flight;
  }
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: { method?: "GET" | "POST"; data?: unknown; key?: string } = {},
  ): Promise<T> {
    const epoch = this.epoch;
    if (!this.session) throw new ClientError("LOGIN_REQUIRED");
    if (options.method === "POST" && !options.key)
      throw new ClientError("IDEMPOTENCY_KEY_REQUIRED");
    if (this.session.expiresAt <= Date.now() + 30000) await this.refresh();
    const usedToken = this.session?.accessToken;
    if (!usedToken || epoch !== this.epoch) throw new ClientError("SESSION_CHANGED");
    let result: T;
    try {
      result = await this.raw(
        path,
        schema,
        options.method ?? "GET",
        options.data,
        usedToken,
        options.key,
      );
    } catch (error) {
      if (!(error instanceof ClientError) || error.status !== 401) throw error;
      if (epoch !== this.epoch || !this.session) throw new ClientError("SESSION_CHANGED");
      if (this.session.accessToken === usedToken) await this.refresh();
      if (epoch !== this.epoch || !this.session) throw new ClientError("SESSION_CHANGED");
      try {
        result = await this.raw(
          path,
          schema,
          options.method ?? "GET",
          options.data,
          this.session.accessToken,
          options.key,
        );
      } catch (retryError) {
        if (retryError instanceof ClientError && retryError.status === 401 && epoch === this.epoch)
          this.clear();
        throw retryError;
      }
    }
    if (epoch !== this.epoch) throw new ClientError("SESSION_CHANGED");
    return result;
  }
  async logout() {
    const token = this.session?.accessToken;
    this.clear();
    if (token) await this.raw("/v1/auth/logout", logoutResponseSchema, "POST", {}, token);
  }
}
