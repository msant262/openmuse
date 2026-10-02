import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type ClientHttp2Stream, connect } from "node:http2";
import { JWT } from "google-auth-library";
import { z } from "zod";
import type { AgentNotification } from "../../../packages/domain/src/agent.ts";
import { ActionLog } from "./action-log.ts";
import type { Store } from "./db.ts";

export interface PushConfig {
  apnsKeyFile?: string;
  apnsKeyId?: string;
  apnsTeamId?: string;
  apnsTopic?: string;
  apnsSandbox?: boolean;
  fcmCredentialsFile?: string;
  fcmProjectId?: string;
}
export const pushDeviceInput = z
  .object({
    installationId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[\w-]+$/),
    platform: z.enum(["ios", "android"]),
    token: z
      .string()
      .min(16)
      .max(4096)
      .regex(/^[\w:.-]+$/),
  })
  .strict()
  .superRefine((value, c) => {
    if (value.platform === "ios" && !/^[a-f\d]{64,200}$/i.test(value.token))
      c.addIssue({ code: "custom", message: "Invalid APNs device token" });
  });
type Device = z.infer<typeof pushDeviceInput> & {
  id: string;
  updatedAt: string;
  registrationId?: string;
};
type Payload = { id: string; title: string; body?: string; taskId?: string };
type Sender = (
  device: Device,
  payload: Payload,
  signal: AbortSignal,
) => Promise<"accepted" | "invalid_token" | "rejected">;
type Delivery = {
  id: string;
  status:
    | "pending"
    | "sending"
    | "accepted"
    | "invalid_token"
    | "rejected"
    | "outcome_unknown"
    | "suppressed";
  deviceId: string;
  notificationId: string;
  leaseUntil?: string;
};
type DeliveryIntent = {
  id: string;
  status: "pending" | "settled";
  targets: Device[];
  deliveryIds?: string[];
  nativeDelivery?: NonNullable<AgentNotification["nativeDelivery"]>;
};
function deliveryStatus(statuses: string[]): NonNullable<AgentNotification["nativeDelivery"]> {
  return statuses.includes("outcome_unknown")
    ? "outcome_unknown"
    : statuses.includes("sending") || statuses.includes("pending")
      ? "pending"
      : statuses.includes("accepted")
        ? "accepted"
        : statuses.includes("rejected") ||
            statuses.includes("invalid_token") ||
            statuses.includes("suppressed")
          ? "rejected"
          : "not_configured";
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener("abort", stop);
      reject(new Error("Push request interrupted"));
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    void operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop))
      .catch(() => {});
  });
}
export function nativePushAdapters(
  config: PushConfig,
): Partial<Record<Device["platform"], Sender>> {
  const senders: Partial<Record<Device["platform"], Sender>> = {};
  if (config.apnsKeyFile && config.apnsKeyId && config.apnsTeamId && config.apnsTopic) {
    const keyFile = config.apnsKeyFile;
    senders.ios = async (device, payload, signal) => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${encode({ alg: "ES256", kid: config.apnsKeyId })}.${encode({ iss: config.apnsTeamId, iat: Math.floor(Date.now() / 1000) })}`;
      const key = createPrivateKey(await readFile(keyFile, "utf8"));
      const token = `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const client = connect(
          config.apnsSandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com",
        );
        let settled = false;
        const finish = (status?: "accepted" | "invalid_token" | "rejected", error?: Error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          client.destroy();
          if (error) reject(error);
          else if (status) resolve(status);
          else reject(new Error("APNs response is incomplete"));
        };
        const abort = () => finish(undefined, new Error("APNs request interrupted"));
        signal.addEventListener("abort", abort, { once: true });
        client.on("error", (error) => finish(undefined, error));
        client.on("close", () => {
          if (!settled) finish(undefined, new Error("APNs connection closed"));
        });
        if (signal.aborted) {
          abort();
          return;
        }
        let request: ClientHttp2Stream;
        try {
          request = client.request({
            ":method": "POST",
            ":path": `/3/device/${device.token}`,
            "apns-topic": config.apnsTopic,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-collapse-id": payload.id.slice(0, 64),
            authorization: `bearer ${token}`,
          });
        } catch (error) {
          finish(undefined, error instanceof Error ? error : new Error("Invalid APNs request"));
          return;
        }
        let status = 0,
          body = "";
        request.on("response", (headers) => {
          status = Number(headers[":status"]);
        });
        request.setEncoding("utf8");
        request.on("data", (part) => {
          if (body.length < 8192) body += part;
        });
        request.on("error", (error) => finish(undefined, error));
        request.on("end", () => {
          finish(
            status === 200
              ? "accepted"
              : status === 410 ||
                  (status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(body))
                ? "invalid_token"
                : "rejected",
          );
        });
        request.end(
          JSON.stringify({
            aps: { alert: { title: payload.title }, sound: "default" },
            notificationId: payload.id,
            taskId: payload.taskId,
          }),
        );
      });
    };
  }
  if (config.fcmCredentialsFile && config.fcmProjectId) {
    const credentialsFile = config.fcmCredentialsFile,
      projectId = config.fcmProjectId;
    senders.android = async (device, payload, signal) => {
      const credentials = z
        .object({ client_email: z.string(), private_key: z.string() })
        .parse(JSON.parse(await readFile(credentialsFile, "utf8")));
      signal.throwIfAborted();
      const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
        transporterOptions: { signal, timeout: 15000, retry: false },
      });
      const token = await abortable(auth.getAccessToken(), signal);
      signal.throwIfAborted();
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
        {
          method: "POST",
          signal,
          redirect: "error",
          headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              token: device.token,
              notification: { title: payload.title },
              data: {
                notificationId: payload.id,
                ...(payload.taskId ? { taskId: payload.taskId } : {}),
              },
              android: { notification: { channel_id: "openmuse", tag: payload.id } },
            },
          }),
        },
      );
      if (response.ok) {
        await response.body?.cancel();
        return "accepted";
      }
      const body = (await response.text()).slice(0, 8192);
      return /UNREGISTERED/.test(body) ? "invalid_token" : "rejected";
    };
  }
  return senders;
}
/** Direct OS push is optional; every notification remains durable in the app. */
export class PushService {
  private audit(delivery: Delivery) {
    return {
      operationId: `push:${delivery.id}`,
      tool: "push.native",
      target: "Native notification provider",
      summary:
        "Native notification request; success means provider acceptance, not physical delivery",
    };
  }
  private async auditReceipt(owner: string, delivery: Delivery) {
    if (delivery.status === "sending") return;
    const log = new ActionLog(this.db);
    if (delivery.status !== "suppressed") await log.append(owner, this.audit(delivery), "started");
    if (delivery.status === "pending") {
      await log.finish(owner, this.audit(delivery), "rejected_not_dispatched");
      return;
    }
    await log.finish(
      owner,
      this.audit(delivery),
      delivery.status === "accepted"
        ? "succeeded"
        : delivery.status === "suppressed"
          ? "denied"
          : delivery.status === "outcome_unknown"
            ? "outcome_unknown"
            : "failed",
    );
  }
  private active = new Set<Promise<unknown>>();
  private readonly abort = new AbortController();
  constructor(
    private readonly db: Store,
    private readonly senders: Partial<Record<Device["platform"], Sender>>,
    private readonly dispatchAllowed: (owner: string) => Promise<boolean> = async () => true,
  ) {}
  async register(owner: string, raw: unknown) {
    const input = pushDeviceInput.parse(raw);
    await this.db.registerPushDevice(owner, {
      ...input,
      id: input.installationId,
      registrationId: randomUUID(),
      updatedAt: new Date().toISOString(),
    });
    return { registered: true, configured: Boolean(this.senders[input.platform]) };
  }
  async unregister(owner: string, id: string) {
    await this.db.remove(owner, "push-devices", id);
    return { registered: false };
  }
  async devices(owner: string) {
    return (await this.db.list<Device>(owner, "push-devices")).map(
      ({ id, platform, updatedAt }) => ({
        id,
        platform,
        updatedAt,
        configured: Boolean(this.senders[platform]),
      }),
    );
  }
  async recover() {
    for (const { owner, value } of await this.db.scan<Delivery>("push-deliveries")) {
      if (
        value.status === "sending" &&
        (!value.leaseUntil || Date.parse(value.leaseUntil) < Date.now())
      ) {
        if (
          await this.db.compareAndSwap(
            owner,
            "push-deliveries",
            value.id,
            { status: "sending" },
            { status: "outcome_unknown" },
          )
        )
          await this.db.notificationDelivery(owner, value.notificationId, "outcome_unknown");
      }
    }
    for (const { owner, value } of await this.db.scan<Delivery>("push-deliveries"))
      await this.auditReceipt(owner, value);
    for (const { owner, value } of await this.db.scan<DeliveryIntent>("push-intents")) {
      const notice = await this.db.get<AgentNotification>(owner, "notifications", value.id);
      if (!notice) continue;
      if (value.status === "pending") await this.deliver(owner, notice);
      else if (value.nativeDelivery && notice.nativeDelivery !== value.nativeDelivery)
        await this.db.notificationDelivery(owner, value.id, value.nativeDelivery);
    }
  }
  /** Freeze original targets atomically with creation, before any external send. */
  notify(owner: string, notice: AgentNotification) {
    return this.track(async () => {
      const saved =
        (await this.db.insertNotification(owner, notice, Object.keys(this.senders))) ??
        (await this.db.get<AgentNotification>(owner, "notifications", notice.id));
      if (saved) await this.send(owner, saved);
    });
  }
  deliver(owner: string, notice: AgentNotification) {
    return this.track(() => this.send(owner, notice));
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    const result = Promise.resolve().then(() => {
      this.abort.signal.throwIfAborted();
      return operation();
    });
    this.active.add(result);
    void result.finally(() => this.active.delete(result)).catch(() => {});
    return result;
  }
  private async send(owner: string, notice: AgentNotification) {
    this.abort.signal.throwIfAborted();
    let intent = await this.db.get<DeliveryIntent>(owner, "push-intents", notice.id);
    if (!intent) {
      // Pre-upgrade notices have no target snapshot. Reconcile existing claims
      // only; registering/configuring a phone must never create a backlog.
      const original = await this.db.pushDeliveries<Delivery>(owner, notice.id);
      const status = deliveryStatus(original.map((delivery) => delivery.status));
      const candidate: DeliveryIntent = {
        id: notice.id,
        status: status === "pending" ? "pending" : "settled",
        targets: [],
        deliveryIds: original.map((delivery) => delivery.id),
        nativeDelivery:
          notice.nativeDelivery === "pending" ? status : (notice.nativeDelivery ?? status),
      };
      intent =
        (await this.db.insertIfAbsent(owner, "push-intents", candidate)) ??
        (await this.db.get<DeliveryIntent>(owner, "push-intents", notice.id));
      if (!intent) throw new Error("Native notification intent could not be saved");
    }
    if (intent.status === "settled") {
      await this.db.notificationDelivery(
        owner,
        notice.id,
        intent.nativeDelivery ?? "not_configured",
      );
      return;
    }
    const statuses: string[] = [];
    const deliveryId = (device: Device) =>
      createHash("sha256").update(`${notice.id}:${device.id}:${device.token}`).digest("hex");
    const ids = [
      ...new Set([
        ...(intent.deliveryIds ?? []),
        ...intent.targets
          .filter((device) => Boolean(this.senders[device.platform]))
          .map(deliveryId),
      ]),
    ];
    for (const device of intent.targets) {
      const sender = this.senders[device.platform];
      if (!sender) {
        statuses.push("not_configured");
        continue;
      }
      const id = deliveryId(device);
      let delivery = await this.db.get<Delivery>(owner, "push-deliveries", id);
      if (!delivery || delivery.status === "pending") {
        if (!(await this.dispatchAllowed(owner))) break;
        const claimed = await this.db.claimPushDelivery(
          owner,
          {
            id,
            status: "sending",
            deviceId: device.id,
            notificationId: notice.id,
            leaseUntil: new Date(Date.now() + 30000).toISOString(),
          },
          device,
        );
        if (claimed) {
          let status: Delivery["status"];
          try {
            const current = await this.db.get<Device>(owner, "push-devices", device.id);
            if (
              current?.token === device.token &&
              current.platform === device.platform &&
              current.registrationId === device.registrationId
            ) {
              await new ActionLog(this.db).append(
                owner,
                this.audit(claimed as Delivery),
                "started",
              );
              // Audit persistence is asynchronous: consent may have been revoked or
              // replaced while it was pending. No await may separate this final
              // registration check from invoking the external sender.
              const latest = await this.db.get<Device>(owner, "push-devices", device.id);
              if (
                latest?.token === device.token &&
                latest.platform === device.platform &&
                latest.registrationId === device.registrationId
              ) {
                this.abort.signal.throwIfAborted();
                if (await this.dispatchAllowed(owner))
                  status = await sender(
                    device,
                    { id: notice.id, title: notice.title.slice(0, 160), taskId: notice.taskId },
                    AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
                  );
                else {
                  const pending = await this.db.compareAndSwap<Delivery>(
                    owner,
                    "push-deliveries",
                    id,
                    { status: "sending", leaseUntil: claimed.leaseUntil },
                    { status: "pending", leaseUntil: null },
                  );
                  await new ActionLog(this.db).finish(
                    owner,
                    this.audit(claimed as Delivery),
                    "rejected_not_dispatched",
                  );
                  delivery = pending ?? (await this.db.get<Delivery>(owner, "push-deliveries", id));
                  continue;
                }
              } else status = "suppressed";
            } else status = "suppressed";
          } catch {
            status = "outcome_unknown";
          }
          delivery = { id, status, deviceId: device.id, notificationId: notice.id };
          await this.db.put(owner, "push-deliveries", delivery);
          await this.auditReceipt(owner, delivery);
          if (status === "invalid_token") await this.db.takePushDevice(owner, device);
        } else {
          delivery = await this.db.get<Delivery>(owner, "push-deliveries", id);
          if (!delivery) {
            // Revocation/stale consent settles this original target permanently.
            await this.db.insertIfAbsent(owner, "push-deliveries", {
              id,
              status: "suppressed",
              deviceId: device.id,
              notificationId: notice.id,
            });
          } else if (delivery.status === "pending") {
            // A pending receipt can outlive the registration it was created for.
            // Settle only after comparing the current registration; the CAS keeps
            // a concurrent sender claim from being overwritten.
            const current = await this.db.get<Device>(owner, "push-devices", device.id);
            if (
              current?.token !== device.token ||
              current.platform !== device.platform ||
              current.registrationId !== device.registrationId
            )
              delivery =
                (await this.db.compareAndSwap<Delivery>(
                  owner,
                  "push-deliveries",
                  id,
                  { status: "pending" },
                  { status: "suppressed", leaseUntil: null },
                )) ?? (await this.db.get<Delivery>(owner, "push-deliveries", id));
          }
        }
      }
    }
    // Reconcile append-only outcomes even if a previous sender committed its receipt
    // then stopped before appending the result. Frozen targets/claims still govern sends.
    for (const id of ids) {
      const receipt = await this.db.get<Delivery>(owner, "push-deliveries", id);
      if (receipt) await this.auditReceipt(owner, receipt);
    }
    // Re-read claims after dispatch; another publisher may have completed one.
    for (const id of ids)
      statuses.push(
        (await this.db.get<Delivery>(owner, "push-deliveries", id))?.status ?? "pending",
      );
    let nativeDelivery = deliveryStatus(statuses);
    if (nativeDelivery !== "pending") {
      const settled = await this.db.compareAndSwap<DeliveryIntent>(
        owner,
        "push-intents",
        notice.id,
        { status: "pending" },
        { status: "settled", nativeDelivery },
      );
      nativeDelivery =
        settled?.nativeDelivery ??
        (await this.db.get<DeliveryIntent>(owner, "push-intents", notice.id))?.nativeDelivery ??
        nativeDelivery;
    }
    await this.db.notificationDelivery(owner, notice.id, nativeDelivery);
  }
  async close() {
    this.abort.abort();
    await Promise.allSettled([...this.active]);
  }
}
